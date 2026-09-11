/**
 * 开发用:测 WASM 单线程下 SenseVoice 的解码耗时随窗口长度的关系,
 * 用来定 interimIntervalMs / maxWindowSec 的默认值。
 *
 *   node tools/bench.mjs tools/zh.wav
 */
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { modelPaths, modelsReady } from "../lib/model-cache.js";

const file = process.argv[2] || "tools/zh.wav";
if (!modelsReady({ modelDir: process.env.DSH_HTT_MODEL_DIR || "" })) {
	console.log("[bench] 跳过:模型还没就位(首次 228MB)。先跑 `npm run model:fetch`。");
	process.exit(0);
}
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
const base = new Float32Array(Math.floor(dataLength / 2));
for (let i = 0; i < base.length; i++) base[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
const loop = (src, times) => {
	const out = new Float32Array(src.length * times);
	for (let t = 0; t < times; t++) out.set(src, t * src.length);
	return out;
};

const cases = [
	["2.0s", base.subarray(0, 32000)],
	["5.6s", base],
	["11.2s", loop(base, 2)],
	["22.4s", loop(base, 4)],
];

const { modelPath, tokensPath } = modelPaths({});
const worker = new Worker(new URL("../lib/asr-worker.mjs", import.meta.url), {
	workerData: { modelPath, tokensPath, language: "auto", useItn: true, numThreads: 1 },
});

let index = -1;
const results = [];
function next() {
	index += 1;
	if (index >= cases.length) {
		console.log("\n[hold-to-talk] 汇总");
		for (const r of results) console.log(`  ${r.name}: ${r.ms}ms  RTF=${(r.ms / (r.seconds * 1000)).toFixed(2)}  → "${r.text.slice(0, 30)}"`);
		worker.terminate();
		process.exit(0);
	}
	const [name, samples] = cases[index];
	console.log(`[hold-to-talk] 解码 ${name} ...`);
	worker.postMessage({ type: "decode", id: index + 1, samples });
}

worker.on("message", (msg) => {
	if (msg.type === "ready") {
		next();
		return;
	}
	if (msg.type === "result") {
		const [name, samples] = cases[index];
		results.push({ name, ms: msg.ms, seconds: samples.length / 16000, text: msg.text });
		next();
		return;
	}
	if (msg.type === "error") {
		console.error("worker 报错:", msg.message);
		process.exit(1);
	}
});
worker.postMessage({ type: "warmup", id: 0 });
