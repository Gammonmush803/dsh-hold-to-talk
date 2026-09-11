/**
 * 开发用:在无浏览器环境下验证 client 半身的"注册契约"。
 *
 *   node tools/client-smoke.mjs
 *
 * 检查:经典脚本能加载、__ModuleLoader__.load 的 id 正确、factory 只用 react、
 *      导出 {name, inject, apply}、apply 把浮层注册进 conversation.input.overlay
 *      且 id/order 正确、样式只注入一次。
 */
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let loaded = null;
const styleTags = [];
const documentStub = {
	querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) || null,
	createElement: () => ({ dataset: {}, style: {}, textContent: "" }),
	head: { appendChild: (tag) => styleTags.push(tag) },
	addEventListener: () => {},
	removeEventListener: () => {},
};

const sandbox = {
	window: {
		__ModuleLoader__: {
			load(spec) {
				loaded = spec;
			},
		},
		addEventListener: () => {},
	},
	document: documentStub,
	console: { log: () => {}, warn: (...a) => console.log("  [warn]", ...a), error: (...a) => console.log("  [error]", ...a) },
	URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
	Blob: class {},
	fetch: () => Promise.reject(new Error("no network in smoke test")),
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
};

let failures = 0;
function check(label, ok, detail) {
	console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? " — " + detail : ""}`);
	if (!ok) failures += 1;
}

console.log("1) 经典脚本加载");
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "lib/client.js" });
check("调用了一次 __ModuleLoader__.load", loaded !== null);
check("id = dsh-hold-to-talk", loaded?.id === "dsh-hold-to-talk", String(loaded?.id));

console.log("2) factory 依赖只有 react");
const required = [];
const ReactStub = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [initial, () => {}],
	useRef: (initial) => ({ current: initial }),
	useEffect: () => {},
};
const mod = loaded.factory((name) => {
	required.push(name);
	if (name === "react") return ReactStub;
	throw new Error("未声明的依赖:" + name);
});
check("只 require 了 react", required.length === 1 && required[0] === "react", required.join(","));

console.log("3) 模块导出形态");
check("name 正确", mod.name === "dsh-hold-to-talk", String(mod.name));
check("inject 含 slots", Array.isArray(mod.inject) && mod.inject.includes("slots"), JSON.stringify(mod.inject));
check("apply 是函数", typeof mod.apply === "function");

console.log("4) 槽位注册");
const registrations = [];
const slotsStub = {
	inject(slotName, callback) {
		registrations.push({ slotName, value: callback() });
	},
	register(spec, component) {
		return { spec, component };
	},
};
mod.apply({ get: (name) => (name === "slots" ? slotsStub : undefined) });
check("注册了 1 个槽位", registrations.length === 1, String(registrations.length));
check("槽位名 = conversation.input.overlay", registrations[0]?.slotName === "conversation.input.overlay", String(registrations[0]?.slotName));
check("id = hold-to-talk", registrations[0]?.value?.spec?.id === "hold-to-talk", String(registrations[0]?.value?.spec?.id));
check("order = 30", registrations[0]?.value?.spec?.order === 30, String(registrations[0]?.value?.spec?.order));
check("注册了组件", typeof registrations[0]?.value?.component === "function");

console.log("5) 样式注入");
check("注入了一个 style 标签", styleTags.length === 1, String(styleTags.length));
check("style 带 pluginCss 标记", styleTags[0]?.dataset?.pluginCss === "dsh-hold-to-talk/overlay.css", String(styleTags[0]?.dataset?.pluginCss));
mod.apply({ get: (name) => (name === "slots" ? slotsStub : undefined) });
check("重复 apply 不重复注入样式", styleTags.length === 1, String(styleTags.length));

console.log("6) slots 缺失时不崩");
mod.apply({ get: () => undefined });
check("无 slots 时安全返回", true);

console.log(failures === 0 ? "\n[client-smoke] 全部通过 ✅" : `\n[client-smoke] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
