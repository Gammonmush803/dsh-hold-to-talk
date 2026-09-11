/**
 * dsh-hold-to-talk · ASR worker
 *
 * 为什么放 worker_threads:解码是同步阻塞的,一次 6~22 秒窗口要占住线程
 * 0.7~3.3 秒。放进 worker,DSH 宿主的事件循环与页面流式输出才不会跟着卡。
 *
 * 引擎优先级(实测数据见 README):
 *   1. sherpa-onnx-node(原生,可多线程) —— 22.4s 音频 3310ms,native RTF≈0.15
 *   2. sherpa-onnx(WASM 单线程) —— 同一段 8015ms,仅作降级兜底
 * 两者的识别器/流 API 只差 acceptWaveform 的入参形式,这里抽象掉。
 *
 * 协议:主线程 → {type:"warmup"} | {type:"decode", id, samples: Float32Array}
 *      worker  → {type:"ready", id, backend} | {type:"result", id, text, ms} | {type:"error", id, message}
 */
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16000;

let backend = null;
let backendError = null;

function loadBackend() {
  if (backend) return backend;
  try {
    const native = require("sherpa-onnx-node");
    if (native && typeof native.OfflineRecognizer === "function") {
      backend = { kind: "native", mod: native };
      return backend;
    }
    backendError = new Error("sherpa-onnx-node 没有导出 OfflineRecognizer");
  } catch (err) {
    backendError = err;
  }
  const wasm = require("sherpa-onnx");
  backend = { kind: "wasm", mod: wasm };
  return backend;
}

let recognizer = null;
let initError = null;

function build() {
  if (recognizer) return recognizer;
  if (initError) throw initError;
  const { kind, mod } = loadBackend();
  const config = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: workerData.modelPath,
        language: workerData.language || "auto",
        useInverseTextNormalization: workerData.useItn ? 1 : 0,
      },
      tokens: workerData.tokensPath,
      numThreads: workerData.numThreads || 2,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  };
  try {
    // 原生包直接 new;WASM 包走工厂函数
    recognizer = kind === "native" ? new mod.OfflineRecognizer(config) : mod.createOfflineRecognizer(config);
  } catch (err) {
    initError = err;
    throw err;
  }
  return recognizer;
}

function accept(stream, samples) {
  const kind = loadBackend().kind;
  if (kind === "native") stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  else stream.acceptWaveform(SAMPLE_RATE, samples);
}

function describe(err) {
  if (!err) return "未知错误";
  return String(err.message || err);
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "warmup") {
    try {
      build();
      parentPort.postMessage({ type: "ready", id: msg.id, backend: loadBackend().kind });
    } catch (err) {
      parentPort.postMessage({
        type: "error",
        id: msg.id,
        message: describe(err) + (backendError ? ` (原生包加载失败:${describe(backendError)})` : ""),
      });
    }
    return;
  }

  if (msg.type === "decode") {
    const started = Date.now();
    let stream = null;
    try {
      const rec = build();
      stream = rec.createStream();
      accept(stream, msg.samples);
      rec.decode(stream);
      const result = rec.getResult(stream);
      parentPort.postMessage({
        type: "result",
        id: msg.id,
        text: (result && typeof result.text === "string" ? result.text : "").trim(),
        ms: Date.now() - started,
      });
    } catch (err) {
      parentPort.postMessage({ type: "error", id: msg.id, message: describe(err) });
    } finally {
      try {
        stream?.free();
      } catch {
        /* ignore */
      }
    }
  }
});
