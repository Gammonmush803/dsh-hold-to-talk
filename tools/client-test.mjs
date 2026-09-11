/**
 * 开发用:在 Node 里驱动 client 半身的**真实交互逻辑**(手势状态机 → PCM 采集 →
 * 增量上传 → interim 预览 → 松手定稿 → 写入草稿),对接的是真实 host 路由。
 *
 *   node tools/client-test.mjs
 *
 * 为什么要这一层:重启 dsh web 会中断会话,浏览器端的手势/增量/竞态逻辑必须先在这里
 * 吃干净,不能靠"重启一次试一次"。
 *
 * 浏览器 API(AudioContext / AudioWorkletNode / getUserMedia / fetch / document)
 * 全部由本文件桩掉;被驱动的是 lib/client.js 里 `__test` 暴露的真实实现。
 */
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import { apply } from "../lib/index.js";
import { modelsReady } from "../lib/model-cache.js";

// 纯函数用例(composeDraft/resampleTo16k/归属判定)不需要模型,但整体流程用例需要,
// 所以没有模型时整体跳过,保持 `npm test` 在干净环境里也能通过。
const HAS_WAV = fs.existsSync(new URL("./zh.wav", import.meta.url));
if (!modelsReady({ modelDir: process.env.DSH_HTT_MODEL_DIR || "" }) || !HAS_WAV) {
	console.log("[client-test] 跳过:需要 SenseVoice 模型(首次 228MB)与 tools/zh.wav。");
	console.log("[client-test] 先跑 `npm run model:fetch`,或用 DSH_HTT_MODEL_DIR 指向已有模型目录。");
	process.exit(0);
}

/* ---------------------------------------------------------------- host 桩服务 */

const routes = [];
const server = http.createServer((req, res) => {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const route = routes.find((r) => r.path === url.pathname);
	if (!route) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "no route" }));
		return;
	}
	Promise.resolve(route.handler(req, res)).catch((err) => {
		if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String(err && err.message) }));
	});
});

apply({
	name: "dsh-hold-to-talk",
	logger: { info: () => {}, warn: (...a) => console.log("  [host warn]", ...a) },
	inject(deps, callback) {
		if (deps.includes("webServer")) {
			callback({ webServer: { register: (r) => (routes.push(r), () => {}) } });
		}
	},
	effect(fn) {
		fn();
	},
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------ 浏览器 API 桩 */

const audioNodes = [];
const gainNodes = [];
const streams = [];

class FakeAudioContext {
	constructor() {
		this.sampleRate = 16000;
		this.state = "running";
		this.destination = { kind: "destination" };
		this.audioWorklet = { addModule: async () => {} };
	}
	resume() {
		return Promise.resolve();
	}
	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}
	createGain() {
		const node = { gain: { value: 1 }, connect() {}, disconnect() {} };
		gainNodes.push(node);
		return node;
	}
	createScriptProcessor() {
		const node = { onaudioprocess: null, connect() {}, disconnect() {} };
		audioNodes.push(node);
		return node;
	}
}

class FakeAudioWorkletNode {
	constructor() {
		this.port = { onmessage: null };
		audioNodes.push(this);
	}
	connect() {}
	disconnect() {}
}

let micDenied = false;

const sandbox = {
	console: { log: () => {}, warn: (...a) => console.log("  [client warn]", ...a), error: (...a) => console.log("  [client error]", ...a) },
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	Date,
	Math,
	JSON,
	Promise,
	Float32Array,
	Object,
	Array,
	String,
	Number,
	Boolean,
	Error,
	URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
	Blob: class {},
	AudioWorkletNode: FakeAudioWorkletNode,
	navigator: {
		mediaDevices: {
			getUserMedia: async () => {
				if (micDenied) {
					const err = new Error("denied");
					err.name = "NotAllowedError";
					throw err;
				}
				const stream = { getTracks: () => [{ stop() {} }] };
				streams.push(stream);
				return stream;
			},
		},
	},
	fetch: (url, init) => fetch(base + url, init),
	document: {
		body: { classList: { toggle() {} } },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {}, textContent: "" }),
		head: { appendChild: () => {} },
		addEventListener: () => {},
		removeEventListener: () => {},
	},
};

sandbox.window = {
	__ModuleLoader__: { load: (spec) => (sandbox.__loaded = spec) },
	AudioContext: FakeAudioContext,
	addEventListener: () => {},
	removeEventListener: () => {},
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), sandbox, { filename: "lib/client.js" });

const mod = sandbox.__loaded.factory((name) => {
	if (name === "react") {
		return { createElement: () => null, useState: () => [null, () => {}], useRef: () => ({ current: null }), useEffect: () => {} };
	}
	throw new Error("未声明依赖 " + name);
});
const { createController, composeDraft, resampleTo16k, registry, nodeOwnsEditor, pickInstanceFor } = mod.__test;

/* ------------------------------------------------------------------ 工具 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(25);
	}
	console.log(`  ⏳ 等待超时:${label}`);
	return false;
}

function readWav16k(file) {
	const buf = fs.readFileSync(file);
	let offset = 12;
	let dataStart = -1;
	let dataLength = 0;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		if (id === "data") {
			dataStart = offset + 8;
			dataLength = size;
			break;
		}
		offset = offset + 8 + size + (size % 2);
	}
	const out = new Float32Array(Math.floor(dataLength / 2));
	for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
	return out;
}

function makeUi(baseDraft) {
	const state = {
		phase: "idle",
		interim: "",
		armed: false,
		messages: [],
		meter: { ms: 0, levels: [] },
		results: [],
		drafts: [],
		baseDraft,
	};
	const ui = {
		self: null,
		getConfig: () => ({
			enabled: true,
			holdThresholdMs: 120,
			cancelSlidePx: 60,
			interimIntervalMs: 400,
			minHoldMs: 100,
			maxHoldMs: 20000,
			autoSend: false,
		}),
		setPhase: (value) => {
			state.phase = typeof value === "function" ? value(state.phase) : value;
		},
		setInterim: (value) => {
			state.interim = value;
			if (value) state.results.push(value);
		},
		setArmed: (value) => {
			state.armed = value;
		},
		setMessage: (value) => {
			if (value) state.messages.push(value);
		},
		setMeter: (value) => {
			state.meter = value;
		},
		clearMessageLater: () => {},
		clearIfIdle: () => {
			state.phase = "idle";
		},
		insertText: (text) => {
			state.drafts.push(composeDraft(state.baseDraft, text));
			return true;
		},
		onModelPreparing: () => {},
	};
	const controller = createController(ui);
	ui.self = controller;
	return { ui, controller, state };
}

const pcm = readWav16k(new URL("./zh.wav", import.meta.url));
const BLOCK = 128;

/** 把音频重复几遍,拉长按住时长,才够触发多轮 interim 与滑动窗口裁剪 */
function loopPcm(src, times) {
	const out = new Float32Array(src.length * times);
	for (let t = 0; t < times; t++) out.set(src, t * src.length);
	return out;
}
const pcmLong = loopPcm(pcm, 2); // 11.2s

/** 按 128 样本/块喂给采集节点,2ms 一块(比真实时间快 ~4 倍) */
async function feedAudio(node, samples) {
	for (let offset = 0; offset < samples.length; offset += BLOCK) {
		const block = samples.subarray(offset, Math.min(offset + BLOCK, samples.length));
		if (node.port && node.port.onmessage) node.port.onmessage({ data: { samples: Float32Array.from(block), rms: 0.4 } });
		await sleep(2);
	}
}

function mouseDownEvent(x = 400, y = 300) {
	return { button: 0, clientX: x, clientY: y, target: { closest: () => ({ tagName: "DIV" }) } };
}

let failures = 0;
function check(label, ok, detail) {
	console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? " — " + detail : ""}`);
	if (!ok) failures += 1;
}

/* ------------------------------------------------------------------ 用例 */

console.log(`[client-test] host=${base} 音频=${(pcm.length / 16000).toFixed(2)}s\n`);

// 等模型/引擎就绪,否则所有识别都会拿到 409
{
	const health = await (await fetch(base + "/dsh-hold-to-talk/health?prepare=1")).json();
	let ready = health.model.status === "ready" && health.engine.ready;
	for (let i = 0; i < 60 && !ready; i++) {
		await sleep(500);
		const again = await (await fetch(base + "/dsh-hold-to-talk/health")).json();
		ready = again.model.status === "ready" && again.engine.ready;
	}
	console.log(`[client-test] 引擎就绪:${ready}\n`);
	if (!ready) process.exit(1);
}

console.log("1) 纯函数:composeDraft / resampleTo16k");
{
	check("空草稿直接拼接", composeDraft("", "你好") === "你好", composeDraft("", "你好"));
	check("中英之间补空格", composeDraft("hello", "世界") === "hello 世界", composeDraft("hello", "世界"));
	check("已有空白不重复补", composeDraft("你好 ", "世界") === "你好 世界", composeDraft("你好 ", "世界"));
	check("16k 原样返回", resampleTo16k(pcm, 16000) === pcm);
	const up = resampleTo16k(new Float32Array(48000), 48000);
	check("48k→16k 长度 = 1/3", up.length === 16000, String(up.length));
}

console.log("2) 归属判定(长按该派给谁)—— 必须与浮层可见性无关");
{
	// 我的浮层节点 ← 同一个 composer 卡片 ← 输入框
	const myNode = { tag: "overlay" };
	const sameCard = { contains: (n) => n === myNode, parentElement: null };
	const editor = { tag: "editor", contains: () => false, parentElement: sameCard };
	check("同一卡片 → 归我", nodeOwnsEditor(myNode, editor) === true);

	const otherCard = { contains: () => false, parentElement: null };
	const otherEditor = { tag: "editor2", contains: () => false, parentElement: otherCard };
	check("别的卡片 → 不归我", nodeOwnsEditor(myNode, otherEditor) === false);

	const saved = registry.instances.slice();
	const mismatch = { tag: "mismatch", ownsEditor: () => false };
	const match = { tag: "match", ownsEditor: () => true };

	registry.instances.length = 0;
	registry.instances.push(mismatch, match);
	check("多个实例时选同卡片那个(哪怕它当前不可见)", pickInstanceFor(editor) === match);

	registry.instances.length = 0;
	registry.instances.push(mismatch);
	check("只有一个实例时兜底用它(功能不瘫)", pickInstanceFor(editor) === mismatch);

	registry.instances.push({ tag: "mismatch2", ownsEditor: () => false });
	check("多实例且都对不上 → 不响应(避免写错会话)", pickInstanceFor(editor) === null);

	registry.instances.length = 0;
	registry.instances.push(...saved);
}

console.log("3) 普通点击(未到长按阈值)不启动录音、不动草稿");
{
	const { controller, state } = makeUi("原文");
	controller.onMouseDown(mouseDownEvent());
	await sleep(30);
	controller.onMouseUp({});
	await sleep(200);
	check("没有创建采集节点", audioNodes.length === 0, "节点数 " + audioNodes.length);
	check("phase 回到 idle", state.phase === "idle", state.phase);
	check("草稿未被写入", state.drafts.length === 0, JSON.stringify(state.drafts));
}

console.log("4) 判定期内移动 = 取消(不抢文本选择)");
{
	const before = audioNodes.length;
	const { controller, state } = makeUi("原文");
	controller.onMouseDown(mouseDownEvent());
	controller.onMouseMove({ clientX: 440, clientY: 300 });
	await sleep(300);
	check("没有创建采集节点", audioNodes.length === before, "节点数 " + audioNodes.length);
	check("phase 仍是 idle", state.phase === "idle", state.phase);
	controller.onMouseUp({});
	await sleep(100);
}

console.log("5) 完整流程:长按 → 边说边出字 → 松手定稿入草稿");
{
	const before = audioNodes.length;
	const { controller, state } = makeUi("已有内容");
	controller.onMouseDown(mouseDownEvent());
	const started = await waitFor("进入录音", () => audioNodes.length > before && state.phase === "holding", 2000);
	check("长按后进入 holding", started, state.phase);

	const node = audioNodes[audioNodes.length - 1];
	const feeding = feedAudio(node, pcmLong);

	const gotInterim = await waitFor("出现实时预览", () => state.results.length > 0, 6000);
	check("录音期间浮层拿到 interim 预览", gotInterim, JSON.stringify(state.results.slice(0, 2)));
	check("interim 未写入草稿(草稿只在松手时才动)", state.drafts.length === 0, JSON.stringify(state.drafts));

	await feeding;
	controller.onMouseUp({});
	const done = await waitFor("定稿完成", () => state.phase === "idle" && state.drafts.length > 0, 10000);
	check("松手后写入草稿", done, JSON.stringify(state.drafts));
	const text = state.drafts[0] || "";
	check("草稿保留原内容并追加识别结果", text.startsWith("已有内容 "), text);
	check("识别结果非空且是中文", /[\u4e00-\u9fa5]/.test(text), text.slice(0, 40));
	check("松手后进入过 working 阶段", state.messages.includes("识别中…"), JSON.stringify(state.messages));
}

console.log("6) 上滑取消:丢弃音频,草稿不变");
{
	const { controller, state } = makeUi("不要动我");
	controller.onMouseDown(mouseDownEvent());
	const started = await waitFor("进入录音", () => state.phase === "holding", 2000);
	check("进入 holding", started, state.phase);
	const node = audioNodes[audioNodes.length - 1];
	const feeding = feedAudio(node, pcm.subarray(0, 16000));
	await sleep(200);
	controller.onMouseMove({ clientX: 400, clientY: 200 }); // 上移 100px > 60px 阈值
	check("进入上滑取消态", state.armed === true, String(state.armed));
	await feeding;
	controller.onMouseUp({});
	await sleep(600);
	check("草稿未被写入", state.drafts.length === 0, JSON.stringify(state.drafts));
	check("回到 idle", state.phase === "idle", state.phase);
	check("给出了取消提示", state.messages.some((m) => m.includes("取消")), JSON.stringify(state.messages));
}

console.log("7) 太短的录音被丢弃(防误触)");
{
	const { controller, state } = makeUi("");
	controller.onMouseDown(mouseDownEvent());
	await waitFor("进入录音", () => state.phase === "holding", 2000);
	const node = audioNodes[audioNodes.length - 1];
	node.port.onmessage({ data: { samples: Float32Array.from(pcm.subarray(0, 800)), rms: 0.3 } }); // 50ms < minHoldMs(100ms)
	await sleep(120);
	controller.onMouseUp({});
	await sleep(500);
	check("草稿未被写入", state.drafts.length === 0, JSON.stringify(state.drafts));
}

console.log("8) 麦克风被拒绝:浮层报错且不崩");
{
	const before = audioNodes.length;
	micDenied = true;
	const { controller, state } = makeUi("");
	controller.onMouseDown(mouseDownEvent());
	await sleep(400);
	check("没有创建采集节点", audioNodes.length === before, "节点数 " + audioNodes.length);
	check("phase=error", state.phase === "error", state.phase);
	check("给出权限提示", state.messages.some((m) => m.includes("权限")), JSON.stringify(state.messages));
	micDenied = false;
	controller.onMouseUp({});
	await sleep(100);
}

console.log("9) 取消后状态机可复用");
{
	const { controller, state } = makeUi("");
	controller.onMouseDown(mouseDownEvent());
	await waitFor("进入录音", () => state.phase === "holding", 2000);
	controller.onKeyDown({ key: "Escape", preventDefault() {} });
	await sleep(300);
	check("Escape 直接取消", state.phase === "idle" && state.drafts.length === 0, state.phase);

	const before = audioNodes.length;
	controller.onMouseDown(mouseDownEvent());
	const again = await waitFor("第二次长按仍能录音", () => audioNodes.length > before && state.phase === "holding", 2000);
	check("取消后可再次长按", again, state.phase);
	const node = audioNodes[audioNodes.length - 1];
	const feeding = feedAudio(node, pcm);
	await feeding;
	controller.onMouseUp({});
	const done = await waitFor("第二次定稿成功", () => state.drafts.length > 0, 10000);
	check("第二次能正常定稿", done, JSON.stringify(state.drafts));
}

console.log("10) 回归:一次成功识别之后,还能继续长按(用户实测报的 bug)");
{
	const { controller, state } = makeUi("");
	for (let round = 1; round <= 3; round++) {
		const before = audioNodes.length;
		controller.onMouseDown(mouseDownEvent());
		const started = await waitFor(`第 ${round} 次进入录音`, () => audioNodes.length > before && state.phase === "holding", 2000);
		check(`第 ${round} 次长按能起录音`, started, state.phase);
		if (!started) break;
		const node = audioNodes[audioNodes.length - 1];
		await feedAudio(node, pcm);
		controller.onMouseUp({});
		const done = await waitFor(`第 ${round} 次定稿`, () => state.drafts.length >= round, 10000);
		check(`第 ${round} 次定稿成功`, done, JSON.stringify(state.drafts.slice(-1)));
	}
	check("三轮都识别出中文", state.drafts.length === 3 && state.drafts.every((t) => /[\u4e00-\u9fa5]/.test(t)), JSON.stringify(state.drafts));
}

server.close();
console.log(failures === 0 ? "\n[client-test] 全部通过 ✅" : `\n[client-test] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
