/**
 * dsh-hold-to-talk · 模型缓存
 *
 * 首次使用时从镜像拉取 SenseVoice int8 模型 + tokens.txt,支持断点续传
 * (.part 临时文件 + HTTP Range),带进度回调供浮层/设置页显示。
 *
 * 关键约束:sherpa-onnx 的 nodejs WASM 构建启用了 NODERAWFS,识别器拿到的是
 * **宿主真实路径**(必须绝对路径;相对路径会落到 emscripten 虚拟 CWD 里读不到)。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

/** SenseVoice 中文原生模型(k2-fsa 官方导出;int8 版 228MB,fp32 版 894MB 不必要) */
export const DEFAULT_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
/** 国内可达的 HuggingFace 镜像 */
export const DEFAULT_MIRROR = "https://hf-mirror.com";

const FILES = [
  { name: "model.int8.onnx", size: 239233841 },
  { name: "tokens.txt", size: 315894 },
];

/** 允许 1KB 误差:个别镜像/代理会对文件做轻微补白 */
const SIZE_TOLERANCE = 1024;

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 模型目录(绝对路径) */
export function modelsDir(config = {}) {
  const custom = typeof config.modelDir === "string" ? config.modelDir.trim() : "";
  const base = custom !== "" ? custom : path.join(os.homedir(), ".dsh", "hold-to-talk", "models");
  return path.resolve(base, DEFAULT_REPO);
}

/** 识别器需要的两个绝对路径 */
export function modelPaths(config = {}) {
  const dir = modelsDir(config);
  return {
    dir,
    modelPath: path.join(dir, "model.int8.onnx"),
    tokensPath: path.join(dir, "tokens.txt"),
  };
}

/** 两个文件是否都已就位 */
export function modelsReady(config = {}) {
  const { modelPath, tokensPath } = modelPaths(config);
  const pairs = [
    [modelPath, FILES[0].size],
    [tokensPath, FILES[1].size],
  ];
  for (const [file, size] of pairs) {
    if (statSize(file) < size - SIZE_TOLERANCE) return false;
  }
  return true;
}

/**
 * 下载单个文件,支持续传。
 * @param {string} url 完整下载地址
 * @param {string} dest 目标绝对路径
 * @param {number} expectedSize 期望字节数
 * @param {(p: {received: number, total: number}) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
async function downloadOne(url, dest, expectedSize, onProgress, signal) {
  const part = dest + ".part";
  let start = statSize(part);
  if (start >= expectedSize - SIZE_TOLERANCE) {
    await fsp.rename(part, dest);
    return;
  }

  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(url, { headers, redirect: "follow", signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
  }
  // 服务器不支持 Range 时(200)必须从头写,不能追加
  const resuming = res.status === 206 && start > 0;
  if (!resuming) start = 0;
  if (!res.body) throw new Error("响应没有 body");

  const out = fs.createWriteStream(part, { flags: resuming ? "a" : "w" });
  let received = start;
  let lastEmit = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastEmit > 200) {
        lastEmit = now;
        onProgress({ received, total: expectedSize });
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }

  const got = statSize(part);
  if (got < expectedSize - SIZE_TOLERANCE) {
    throw new Error(`下载不完整:${path.basename(dest)} ${got}/${expectedSize} 字节`);
  }
  await fsp.rename(part, dest);
}

/**
 * 保证模型可用(已就位则直接返回)。
 * @param {object} config 插件配置(mirror / modelDir)
 * @param {(p: {file: string, received: number, total: number, ratio: number}) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
export async function ensureModels(config = {}, onProgress, signal) {
  const { dir, modelPath, tokensPath } = modelPaths(config);
  await fsp.mkdir(dir, { recursive: true });

  const mirror = String(config.mirror || DEFAULT_MIRROR).replace(/\/+$/, "");
  const repo = DEFAULT_REPO;
  const totalBytes = FILES.reduce((sum, f) => sum + f.size, 0);
  let doneBytes = 0;

  for (const file of FILES) {
    const dest = path.join(dir, file.name);
    if (statSize(dest) >= file.size - SIZE_TOLERANCE) {
      doneBytes += file.size;
      onProgress?.({ file: file.name, received: file.size, total: file.size, ratio: doneBytes / totalBytes });
      continue;
    }
    const url = `${mirror}/${repo}/resolve/main/${file.name}`;
    await downloadOne(
      url,
      dest,
      file.size,
      (p) => onProgress?.({ file: file.name, received: p.received, total: p.total, ratio: (doneBytes + p.received) / totalBytes }),
      signal,
    );
    doneBytes += file.size;
    onProgress?.({ file: file.name, received: file.size, total: file.size, ratio: doneBytes / totalBytes });
  }

  return { dir, modelPath, tokensPath, repo, mirror };
}
