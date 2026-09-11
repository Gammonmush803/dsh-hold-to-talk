/**
 * 开发用:把一段文案写进 DSH 市场的插件「备注」。
 *
 * 市场卡片读的不是 package.json.description,而是 profile 下
 * `.dsh-market/state.json` 的 notes 对象(上限 200 字)。本脚本按市场自己
 * 的写法(readMarketState/writeMarketState:紧凑 JSON、无 BOM)改这个文件,
 * 只动目标插件那一条,其余字段原样保留。
 *
 *   node tools/market-note.mjs <插件名> <文案文件路径>
 *   node tools/market-note.mjs dsh-hold-to-talk tools/market-note.txt
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_NOTE = 200;

const pluginName = process.argv[2];
const textFile = process.argv[3];
if (!pluginName || !textFile) {
	console.error("用法: node tools/market-note.mjs <插件名> <文案文件路径>");
	process.exit(1);
}

const stateFile = path.join(os.homedir(), ".dsh", "profiles", "web", ".dsh-market", "state.json");
const text = fs.readFileSync(textFile, "utf8").trim().replace(/\s*\n\s*/g, "");
if (text === "") {
	console.error("文案文件是空的,不写");
	process.exit(1);
}

const raw = fs.readFileSync(stateFile, "utf8");
const state = JSON.parse(raw);
state.notes = state.notes || {};
const before = state.notes[pluginName];
state.notes[pluginName] = text.slice(0, MAX_NOTE);

// 与市场的 writeMarketState 一致:紧凑 JSON,UTF-8 无 BOM
fs.writeFileSync(stateFile, JSON.stringify(state));

const after = JSON.parse(fs.readFileSync(stateFile, "utf8")).notes[pluginName];
console.log(`[market-note] ${stateFile}`);
console.log(`[market-note] ${pluginName}: ${before ? "覆盖" : "新增"} 备注 ${after.length}/${MAX_NOTE} 字`);
console.log(`[market-note] 结果: ${after}`);
console.log(`[market-note] 其他插件备注条数: ${Object.keys(state.notes).length - 1}`);
