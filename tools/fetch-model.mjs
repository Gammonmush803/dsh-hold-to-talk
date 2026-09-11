/**
 * 开发用:把 SenseVoice 模型拉到本地缓存(走镜像,断点续传)。
 * 不入发布包(package.json 的 files 只含 lib/、cordis.patch.yml、README.md)。
 *
 *   node tools/fetch-model.mjs
 */
import { ensureModels, modelPaths, modelsReady } from "../lib/model-cache.js";

const config = { mirror: process.env.DSH_HTT_MIRROR || "https://hf-mirror.com", modelDir: process.env.DSH_HTT_MODEL_DIR || "" };
const { dir } = modelPaths(config);
console.log("[hold-to-talk] 模型目录:", dir);

let lastLog = 0;
await ensureModels(config, (p) => {
	const now = Date.now();
	if (now - lastLog < 2000) return;
	lastLog = now;
	console.log(
		`  ${p.file}  ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB  ${(p.ratio * 100).toFixed(1)}%`,
	);
});
console.log("[hold-to-talk] ready:", modelsReady(config));
