/**
 * 开发用:绕过 DSH,直接验证「模型能加载 + 一段中文音频能识别」。
 *
 *   node tools/decode-test.mjs tools/zh.wav
 */
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { modelPaths, modelsReady } from "../lib/model-cache.js";

const file = process.argv[2] || "tools/zh.wav";
const config = { modelDir: process.env.DSH_HTT_MODEL_DIR || "" };

if (!modelsReady(config)) {
	console.log("[hold-to-talk] 跳过:模型还没就位(首次 228MB)。先跑 `npm run model:fetch`。");
	process.exit(0);
}

/** 极简 WAV 解析:只支持 16-bit PCM,返回 {sampleRate, samples} */
function readWav(filePath) {
	const buf = fs.readFileSync(filePath);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("不是 WAV 文件");
	}
	let offset = 12;
	let sampleRate = 16000;
	let bits = 16;
	let channels = 1;
	let dataStart = -1;
	let dataLength = 0;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			channels = buf.readUInt16LE(body + 2);
			sampleRate = buf.readUInt32LE(body + 4);
			bits = buf.readUInt16LE(body + 14);
		} else if (id === "data") {
			dataStart = body;
			dataLength = size;
			break;
		}
		offset = body + size + (size % 2);
	}
	if (dataStart < 0) throw new Error("没有 data 块");
	if (bits !== 16) throw new Error("只支持 16-bit PCM,实际 " + bits);
	const count = Math.floor(dataLength / 2 / channels);
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		samples[i] = buf.readInt16LE(dataStart + i * 2 * channels) / 32768;
	}
	return { sampleRate, samples, channels };
}

const { sampleRate, samples, channels } = readWav(file);
console.log(`[hold-to-talk] ${file}: ${sampleRate}Hz ${channels}ch ${samples.length} 样本 (${(samples.length / sampleRate).toFixed(2)}s)`);

const { modelPath, tokensPath } = modelPaths(config);
const worker = new Worker(new URL("../lib/asr-worker.mjs", import.meta.url), {
	workerData: { modelPath, tokensPath, language: "auto", useItn: true, numThreads: 2 },
});

const started = Date.now();
worker.on("message", (msg) => {
	if (msg.type === "ready") {
		console.log(`[hold-to-talk] 引擎就绪 backend=${msg.backend},耗时 ${Date.now() - started}ms`);
		worker.postMessage({ type: "decode", id: 1, samples });
		return;
	}
	if (msg.type === "result") {
		console.log(`[hold-to-talk] 识别结果(${msg.ms}ms): ${msg.text}`);
		worker.terminate();
		process.exit(0);
	}
	if (msg.type === "error") {
		console.error("[hold-to-talk] worker 报错:", msg.message);
		worker.terminate();
		process.exit(1);
	}
});
worker.on("error", (err) => {
	console.error("[hold-to-talk] worker 崩溃:", err);
	process.exit(1);
});
worker.postMessage({ type: "warmup", id: 0 });
