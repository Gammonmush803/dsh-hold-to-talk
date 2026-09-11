/**
 * dsh-hold-to-talk · 浏览器半身
 *
 * 微信式长按说话:在输入框(data-lexical-editor)上按住鼠标不动 400ms 进入录音,
 * 浮层里边说边出字(interim 只进浮层,绝不回写输入框),松手把定稿文字追加进草稿,
 * 按住上滑则丢弃。
 *
 * 经典脚本 + window.__ModuleLoader__,无构建步骤,因此不能写 JSX,一律 React.createElement。
 */
window.__ModuleLoader__.load({
	id: "dsh-hold-to-talk",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;
		const { useEffect, useRef, useState } = React;

		const API = "/dsh-hold-to-talk";
		const TAG = "[hold-to-talk]";
		const TARGET_RATE = 16000;
		const MOVE_TOLERANCE_PX = 8;
		// 太短的音频送进非流式模型会吐幻觉词(实测 1.2s 得 "哈。",2s 才稳定),首次预览前先攒够
		const INTERIM_MIN_AUDIO_SEC = 2.0;
		const INTERIM_MIN_STEP_SEC = 0.3;
		const FALLBACK_CONFIG = {
			enabled: true,
			holdThresholdMs: 400,
			cancelSlidePx: 60,
			interimIntervalMs: 1500,
			minHoldMs: 250,
			maxHoldMs: 60000,
			autoSend: false,
		};

		/* ------------------------------------------------------------------ 样式 */

		const CSS_TAG_ID = "dsh-hold-to-talk/overlay.css";
		const CSS = [
			".dsh-htt{position:fixed;left:50%;transform:translateX(-50%);bottom:132px;z-index:2147483000;",
			"display:flex;justify-content:center;width:min(600px,calc(100vw - 32px));pointer-events:none;",
			"font-family:inherit}",
			".dsh-htt__card{min-width:210px;max-width:100%;padding:10px 14px;border-radius:14px;",
			"background:rgba(22,24,29,.95);color:#f5f6f8;border:1px solid rgba(255,255,255,.08);",
			"box-shadow:0 12px 32px rgba(0,0,0,.34);font-size:13px;line-height:1.5;",
			"-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:background .15s ease}",
			".dsh-htt__card.is-armed{background:rgba(140,38,40,.96)}",
			".dsh-htt__row{display:flex;align-items:center;gap:8px}",
			".dsh-htt__mic{font-size:13px;line-height:1;flex:none}",
			".dsh-htt__mic.is-live{color:#ff5d5d;animation:dsh-htt-pulse 1s ease-in-out infinite}",
			"@keyframes dsh-htt-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
			".dsh-htt__wave{display:flex;align-items:center;gap:2px;height:18px;flex:1 1 auto;min-width:60px}",
			".dsh-htt__wave i{display:block;width:3px;border-radius:2px;background:#8ab4ff;opacity:.85;",
			"transition:height .09s linear}",
			".dsh-htt__time{flex:none;font-variant-numeric:tabular-nums;font-size:12px;opacity:.7}",
			".dsh-htt__hint{margin-top:6px;font-size:12px;opacity:.72}",
			".dsh-htt__text{margin-top:6px;max-height:9em;overflow:hidden;white-space:pre-wrap;word-break:break-word}",
			".dsh-htt__text--pending{opacity:.75}",
			".dsh-htt__text--warn{color:#ffd08a}",
			".dsh-htt__bar{margin-top:7px;height:3px;border-radius:2px;background:rgba(255,255,255,.16);overflow:hidden}",
			".dsh-htt__bar span{display:block;height:100%;background:#8ab4ff;transition:width .2s ease}",
			"body.dsh-htt-holding [data-lexical-editor=\"true\"],body.dsh-htt-holding .dsh-htt-src",
			"{-webkit-user-select:none!important;user-select:none!important}",
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hold-to-talk";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ------------------------------------------------------- AudioWorklet 源码 */

		// 插件没有独立的静态文件服务,worklet 用 Blob URL 内联加载。
		const WORKLET_SRC = [
			"class DshPcmTap extends AudioWorkletProcessor {",
			"  process(inputs) {",
			"    const ch = inputs[0] && inputs[0][0];",
			"    if (ch && ch.length) {",
			"      const copy = new Float32Array(ch.length);",
			"      copy.set(ch);",
			"      let sum = 0;",
			"      for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];",
			"      this.port.postMessage({ samples: copy, rms: Math.sqrt(sum / copy.length) });",
			"    }",
			"    return true;",
			"  }",
			"}",
			"registerProcessor('dsh-pcm-tap', DshPcmTap);",
		].join("\n");

		/* ------------------------------------------------------------ 音频基础设施 */

		// AudioContext 必须在真实用户手势里创建/解挂,否则自动播放策略会让它一直 suspended。
		// 这里不碰麦克风(没有权限弹窗、没有录音指示灯),只是一台常备的静音引擎。
		let warmCtx = null;
		function warmAudioContext() {
			if (warmCtx) return warmCtx;
			try {
				const Ctor = window.AudioContext || window.webkitAudioContext;
				if (!Ctor) return null;
				let ctx;
				try {
					ctx = new Ctor({ sampleRate: TARGET_RATE });
				} catch (err) {
					ctx = new Ctor();
				}
				if (ctx.state === "suspended") ctx.resume().catch(() => {});
				warmCtx = ctx;
			} catch (err) {
				console.warn(TAG, "创建 AudioContext 失败", err);
				warmCtx = null;
			}
			return warmCtx;
		}

		async function startCapture(onChunk) {
			const ctx = warmAudioContext();
			if (!ctx) throw new Error("当前浏览器不支持音频采集");
			if (ctx.state === "suspended") {
				try {
					await ctx.resume();
				} catch (err) {
					/* ignore */
				}
			}
			if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
				throw new Error("当前页面无法访问麦克风(需要 https 或 127.0.0.1)");
			}
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});

			const source = ctx.createMediaStreamSource(stream);
			// 采集节点必须连到 destination 才会被拉动;串一个 0 增益的 sink 保证不外放(否则啸叫)
			const sink = ctx.createGain();
			sink.gain.value = 0;
			sink.connect(ctx.destination);

			let node = null;
			if (ctx.audioWorklet) {
				try {
					const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
					try {
						await ctx.audioWorklet.addModule(url);
					} finally {
						URL.revokeObjectURL(url);
					}
					node = new AudioWorkletNode(ctx, "dsh-pcm-tap");
					node.port.onmessage = (ev) => onChunk(ev.data);
				} catch (err) {
					console.warn(TAG, "AudioWorklet 不可用,回退 ScriptProcessor", err);
					node = null;
				}
			}
			if (!node) {
				node = ctx.createScriptProcessor(4096, 1, 1);
				node.onaudioprocess = (ev) => {
					const ch = ev.inputBuffer.getChannelData(0);
					const copy = new Float32Array(ch.length);
					copy.set(ch);
					let sum = 0;
					for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
					onChunk({ samples: copy, rms: Math.sqrt(sum / copy.length) });
				};
			}

			source.connect(node);
			node.connect(sink);

			return {
				nativeRate: ctx.sampleRate,
				stop() {
					try {
						source.disconnect();
					} catch (err) {
						/* ignore */
					}
					try {
						node.disconnect();
					} catch (err) {
						/* ignore */
					}
					try {
						if (node.port) node.port.onmessage = null;
						node.onaudioprocess = null;
					} catch (err) {
						/* ignore */
					}
					try {
						sink.disconnect();
					} catch (err) {
						/* ignore */
					}
					for (const track of stream.getTracks()) {
						try {
							track.stop();
						} catch (err) {
							/* ignore */
						}
					}
				},
			};
		}

		/** 可增长的单声道缓冲(避免每个 tick 重新分配整段) */
		function createBuffer() {
			let data = new Float32Array(1 << 16);
			let length = 0;
			return {
				append(chunk) {
					if (length + chunk.length > data.length) {
						let cap = data.length;
						while (cap < length + chunk.length) cap *= 2;
						const next = new Float32Array(cap);
						next.set(data.subarray(0, length));
						data = next;
					}
					data.set(chunk, length);
					length += chunk.length;
				},
				view() {
					return data.subarray(0, length);
				},
				get length() {
					return length;
				},
			};
		}

		/**
		 * 线性重采样到 16k。
		 * 每次都从 0 号样本重算,保证各次增量能严丝合缝地拼接(只重采样尾部会错位)。
		 */
		function resampleTo16k(src, nativeRate) {
			if (!src || src.length === 0) return new Float32Array(0);
			if (nativeRate === TARGET_RATE) return src;
			const ratio = nativeRate / TARGET_RATE;
			const outLen = Math.max(0, Math.floor(src.length / ratio));
			const out = new Float32Array(outLen);
			for (let i = 0; i < outLen; i++) {
				const pos = i * ratio;
				const i0 = Math.floor(pos);
				const i1 = i0 + 1 < src.length ? i0 + 1 : i0;
				const frac = pos - i0;
				out[i] = src[i0] * (1 - frac) + src[i1] * frac;
			}
			return out;
		}

		/* ------------------------------------------------------------------ 网络 */

		async function postPcm(holdId, mode, samples, signal) {
			let res;
			try {
				res = await fetch(API + "/asr?mode=" + mode + "&hold=" + encodeURIComponent(holdId), {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: samples,
					signal,
				});
			} catch (err) {
				return { ok: false, status: 0, data: { error: String((err && err.message) || err) } };
			}
			let data = null;
			try {
				data = await res.json();
			} catch (err) {
				data = null;
			}
			return { ok: res.ok, status: res.status, data: data || {} };
		}

		function postDrop(holdId) {
			try {
				fetch(API + "/asr?mode=drop&hold=" + encodeURIComponent(holdId), { method: "POST", keepalive: true }).catch(() => {});
			} catch (err) {
				/* ignore */
			}
		}

		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		function newHoldId() {
			return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		}

		function micErrorMessage(err) {
			const name = err && err.name;
			if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限被拒绝,请在地址栏允许后重试";
			if (name === "NotFoundError") return "没有找到麦克风设备";
			if (name === "NotReadableError") return "麦克风被其他程序占用";
			return String((err && err.message) || err || "无法开始录音");
		}

		/* ------------------------------------------------- 全局手势(单例,跨会话实例) */

		const EDITOR_SELECTOR = '[data-lexical-editor="true"], [contenteditable="true"]';

		// 整包热重载(HMR)后,上一份模块注册的文档级监听器还在。用一枚 token 让它自动
		// 失效,否则同一次 mousedown 会被新旧两份逻辑各接一次(可能开两条录音)。
		const MODULE_TOKEN = "htt-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

		function isStaleModule() {
			return typeof window !== "undefined" && window.__dshHoldToTalkToken !== MODULE_TOKEN;
		}

		const registry = {
			bound: false,
			instances: [],
			owner: null,
		};

		/**
		 * 判断某个浮层实例是否"属于"这次按下的输入框:从输入框往上走,看哪一层祖先
		 * 同时包含浮层节点。
		 *
		 * 这里刻意**不看可见性**:浮层空闲时是隐藏的(甚至 display:none 的祖先),
		 * 用 offsetParent/getClientRects 判可见会让长按在第一次成功之后彻底失效
		 * ——真实的踩坑现场。DOM 包含关系与 CSS 无关,所以永远稳。
		 */
		function nodeOwnsEditor(node, editorEl) {
			if (!node || !editorEl) return false;
			let el = editorEl;
			while (el) {
				if (typeof el.contains === "function" && el.contains(node)) return true;
				el = el.parentElement;
			}
			return false;
		}

		/** 为这次按下挑实例:优先"同卡片"的那个;只有一个实例时兜底用它 */
		function pickInstanceFor(editorEl) {
			for (const inst of registry.instances) {
				try {
					if (inst.ownsEditor(editorEl)) return inst;
				} catch (err) {
					/* ignore */
				}
			}
			// 只有一个实例时(绝大多数情况)即使 DOM 结构出乎意料也别让功能瘫掉;
			// 多实例且都对不上时宁可不响应,避免把文字写进别的会话
			return registry.instances.length === 1 ? registry.instances[0] : null;
		}

		function bindGlobalOnce() {
			if (registry.bound || typeof document === "undefined") return;
			registry.bound = true;
			try {
				window.__dshHoldToTalkToken = MODULE_TOKEN;
			} catch (err) {
				/* ignore */
			}

			document.addEventListener(
				"mousedown",
				(e) => {
					if (isStaleModule()) return;
					const target = e.target;
					const editor = target && typeof target.closest === "function" ? target.closest(EDITOR_SELECTOR) : null;
					if (!editor) return;
					const inst = pickInstanceFor(editor);
					if (inst) inst.onMouseDown(e);
				},
				true,
			);
			document.addEventListener(
				"mousemove",
				(e) => {
					if (isStaleModule()) return;
					const inst = registry.owner;
					if (inst) inst.onMouseMove(e);
				},
				true,
			);
			document.addEventListener(
				"mouseup",
				(e) => {
					if (isStaleModule()) return;
					const inst = registry.owner;
					if (inst) inst.onMouseUp(e);
				},
				true,
			);
			document.addEventListener(
				"keydown",
				(e) => {
					if (isStaleModule()) return;
					const inst = registry.owner;
					if (inst) inst.onKeyDown(e);
				},
				true,
			);
			window.addEventListener("blur", () => {
				if (isStaleModule()) return;
				const inst = registry.owner;
				if (inst) inst.onBlur();
			});
		}

		/* ------------------------------------------------------------ 交互控制器 */

		function createController(ui) {
			const hold = { current: null };
			let epoch = 0;

			function setHoldingClass(on) {
				try {
					document.body.classList.toggle("dsh-htt-holding", !!on);
				} catch (err) {
					/* ignore */
				}
			}

			function clearTimers(item) {
				if (!item) return;
				if (item.judgeTimer) clearTimeout(item.judgeTimer);
				if (item.uiTimer) clearInterval(item.uiTimer);
				if (item.interimTimer) clearInterval(item.interimTimer);
				item.judgeTimer = null;
				item.uiTimer = null;
				item.interimTimer = null;
			}

			function release(item) {
				clearTimers(item);
				if (item.recorder) {
					try {
						item.recorder.stop();
					} catch (err) {
						/* ignore */
					}
					item.recorder = null;
				}
				if (hold.current === item) hold.current = null;
				if (registry.owner === ui.self) registry.owner = null;
				setHoldingClass(false);
			}

			function cancelBeforeStart(item) {
				item.cancelled = true;
				release(item);
			}

			async function begin(item) {
				if (item.cancelled || hold.current !== item) return;
				const cfg = ui.getConfig();
				if (!cfg.enabled) {
					release(item);
					return;
				}
				item.active = true;
				item.startedAt = Date.now();
				ui.setPhase("holding");
				ui.setInterim("");
				ui.setArmed(false);
				ui.setMessage("");
				ui.setMeter({ ms: 0, levels: [] });

				try {
					item.recorder = await startCapture((data) => {
						if (item.cancelled || !data || !data.samples) return;
						item.buffer.append(data.samples);
						item.rms = typeof data.rms === "number" ? data.rms : 0;
					});
				} catch (err) {
					release(item);
					ui.setPhase("error");
					ui.setMessage(micErrorMessage(err));
					console.warn(TAG, "录音启动失败", err);
					setTimeout(() => ui.clearIfIdle(), 4000);
					return;
				}

				if (item.cancelled || hold.current !== item) {
					release(item);
					return;
				}

				item.uiTimer = setInterval(() => {
					const cfgNow = ui.getConfig();
					const ms = Date.now() - item.startedAt;
					item.levels.push(item.rms || 0);
					if (item.levels.length > 18) item.levels.shift();
					ui.setMeter({ ms, levels: item.levels.slice() });
					if (ms >= cfgNow.maxHoldMs) finish(item, false);
				}, 100);

				item.interimTimer = setInterval(() => pumpInterim(item), Math.max(400, cfg.interimIntervalMs));
			}

			async function pumpInterim(item) {
				if (!item.active || item.cancelled || item.uploadBusy) return;
				if (hold.current !== item) return;
				const nativeRate = item.recorder ? item.recorder.nativeRate : TARGET_RATE;
				const pcm = resampleTo16k(item.buffer.view(), nativeRate);
				const needed = item.sent === 0 ? INTERIM_MIN_AUDIO_SEC : INTERIM_MIN_STEP_SEC;
				if (pcm.length - item.sent < TARGET_RATE * needed) return;
				if (pcm.length < TARGET_RATE * INTERIM_MIN_AUDIO_SEC) return;
				const increment = pcm.subarray(item.sent);
				const myEpoch = ++epoch;
				item.uploadBusy = true;
				try {
					const res = await postPcm(item.id, "interim", increment);
					if (item.cancelled || hold.current !== item || epoch !== myEpoch) return;
					if (res.status === 409) {
						ui.onModelPreparing(res.data);
						return;
					}
					if (!res.ok) return; // 预览失败不打扰用户
					item.sent = pcm.length;
					const text = res.data && typeof res.data.text === "string" ? res.data.text.trim() : "";
					if (text) ui.setInterim(text);
				} finally {
					item.uploadBusy = false;
				}
			}

			async function finish(item, cancelled) {
				if (item.finished) return;
				item.finished = true;
				item.cancelled = true; // 让在途的预览结果全部作废
				const cfg = ui.getConfig();
				const raw = item.buffer.view();
				const nativeRate = item.recorder ? item.recorder.nativeRate : TARGET_RATE;
				const durationMs = nativeRate > 0 ? (raw.length / nativeRate) * 1000 : 0;
				release(item);

				if (cancelled || durationMs < cfg.minHoldMs) {
					postDrop(item.id);
					ui.setPhase("idle");
					ui.setInterim("");
					ui.setArmed(false);
					ui.setMessage(cancelled && durationMs >= cfg.minHoldMs ? "已取消" : "");
					ui.clearMessageLater(1400);
					return;
				}

				ui.setPhase("working");
				ui.setMessage("识别中…");
				const pcm = resampleTo16k(raw, nativeRate);
				const from = Math.min(item.sent, pcm.length);
				const increment = pcm.subarray(from);

				try {
					let payload = null;
					for (let attempt = 0; attempt < 240; attempt++) {
						const res = await postPcm(item.id, "final", increment);
						if (res.status === 409) {
							ui.onModelPreparing(res.data);
							await sleep(1500);
							continue;
						}
						if (!res.ok) throw new Error((res.data && res.data.error) || "HTTP " + res.status);
						payload = res.data || {};
						break;
					}
					if (!payload) throw new Error("等待语音模型超时");
					const text = typeof payload.text === "string" ? payload.text.trim() : "";
					if (!text) {
						ui.setPhase("idle");
						ui.setInterim("");
						ui.setMessage("没听清,再说一次");
						ui.clearMessageLater(2000);
						return;
					}
					const wrote = ui.insertText(text);
					ui.setPhase("idle");
					ui.setInterim("");
					ui.setArmed(false);
					ui.setMessage(wrote ? "" : "无法写入输入框");
					ui.clearMessageLater(1600);
				} catch (err) {
					console.warn(TAG, "识别失败", err);
					ui.setPhase("error");
					ui.setMessage(String((err && err.message) || err));
					ui.clearMessageLater(4500);
				}
			}

			return {
				onMouseDown(e) {
					if (hold.current) return;
					if (e.button !== 0) return;
					const target = e.target;
					const editor = target && typeof target.closest === "function" ? target.closest(EDITOR_SELECTOR) : null;
					if (!editor) return;
					// 真实用户手势里把 AudioContext 建起来/解挂,免得 400ms 后创建时被自动播放策略挂起
					warmAudioContext();

					const item = {
						id: newHoldId(),
						active: false,
						finished: false,
						cancelled: false,
						armed: false,
						uploadBusy: false,
						sent: 0,
						rms: 0,
						levels: [],
						buffer: createBuffer(),
						recorder: null,
						startedAt: 0,
						startX: e.clientX,
						startY: e.clientY,
						judgeTimer: null,
						uiTimer: null,
						interimTimer: null,
					};
					hold.current = item;
					registry.owner = ui.self;
					item.judgeTimer = setTimeout(() => begin(item), Math.max(120, ui.getConfig().holdThresholdMs));
				},

				onMouseMove(e) {
					const item = hold.current;
					if (!item) return;
					if (!item.active) {
						const moved = Math.abs(e.clientX - item.startX) + Math.abs(e.clientY - item.startY);
						if (moved > MOVE_TOLERANCE_PX) cancelBeforeStart(item);
						return;
					}
					const dy = item.startY - e.clientY;
					const armed = dy > ui.getConfig().cancelSlidePx;
					if (armed !== item.armed) {
						item.armed = armed;
						ui.setArmed(armed);
					}
				},

				onMouseUp() {
					const item = hold.current;
					if (!item) return;
					if (!item.active) {
						cancelBeforeStart(item); // 普通点击(未到长按阈值):放行,不影响光标与选区
						return;
					}
					finish(item, item.armed);
				},

				onKeyDown(e) {
					const item = hold.current;
					if (!item) return;
					if (e.key === "Escape") {
						if (e.preventDefault) e.preventDefault();
						if (item.active) finish(item, true);
						else cancelBeforeStart(item);
					}
				},

				onBlur() {
					const item = hold.current;
					if (!item) return;
					if (item.active) finish(item, true);
					else cancelBeforeStart(item);
				},

				abort() {
					const item = hold.current;
					if (!item) return;
					release(item);
					if (!item.active) return;
					postDrop(item.id);
				},
			};
		}

		/* ------------------------------------------------------------ 浮层组件 */

		function formatSeconds(ms) {
			const total = Math.max(0, Math.floor(ms / 1000));
			const m = Math.floor(total / 60);
			const s = total % 60;
			return m > 0 ? m + ":" + (s < 10 ? "0" + s : s) : s + "s";
		}

		// 归属判定锚点:零尺寸、脱离文档流、不接收指针事件——只为"我属于哪个 composer"
		// 提供 DOM 锚点,对布局零影响(package 无关:浮层卡片自己是 position:fixed)
		const MARKER_STYLE = { position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none" };

		/** 把定稿文字追加到原草稿:中英文之间补一个空格,避免"hello世界"这种粘连 */
		function composeDraft(base, text) {
			const head = typeof base === "string" ? base : "";
			const sep = head !== "" && !/\s$/.test(head) ? " " : "";
			return head + sep + text;
		}

		function HoldToTalk(props) {
			const useInput = props.useInput;
			const inputActions = props.inputActions;
			const inputState = typeof useInput === "function" ? useInput((s) => s) : null;

			const rootRef = useRef(null);
			const cfgRef = useRef({ ...FALLBACK_CONFIG });
			const draftRef = useRef("");
			const healthRef = useRef({ status: "unknown", progress: 0 });
			const actionsRef = useRef({ setDraft: null, submit: null });

			const [phase, setPhase] = useState("idle");
			const [interim, setInterim] = useState("");
			const [armed, setArmed] = useState(false);
			const [message, setMessage] = useState("");
			const [meter, setMeter] = useState({ ms: 0, levels: [] });
			const [progress, setProgress] = useState(0);

			if (inputState && typeof inputState.draft === "string") draftRef.current = inputState.draft;
			actionsRef.current.setDraft = inputActions && typeof inputActions.setDraft === "function" ? inputActions.setDraft : null;
			actionsRef.current.submit = inputActions && typeof inputActions.submit === "function" ? inputActions.submit : null;

			useEffect(() => {
				ensureCss();
				bindGlobalOnce();

				let disposed = false;
				let healthTimer = null;
				let messageTimer = null;

				const clearMessageLater = (ms) => {
					if (messageTimer) clearTimeout(messageTimer);
					messageTimer = setTimeout(() => {
						if (!disposed) {
							setMessage("");
							setPhase((p) => (p === "error" ? "idle" : p));
						}
					}, ms);
				};

				const ui = {
					self: null,
					getConfig: () => cfgRef.current,
					setPhase,
					setInterim,
					setArmed,
					setMessage,
					setMeter,
					clearMessageLater,
					clearIfIdle: () => {
						setPhase((p) => (p === "error" ? "idle" : p));
					},
					insertText: (text) => {
						const setDraft = actionsRef.current.setDraft;
						if (!setDraft) return false;
						const base = draftRef.current || "";
						const next = composeDraft(base, text);
						try {
							setDraft(next);
						} catch (err) {
							console.warn(TAG, "写入草稿失败", err);
							return false;
						}
						draftRef.current = next;
						if (cfgRef.current.autoSend && actionsRef.current.submit) {
							setTimeout(() => {
								try {
									actionsRef.current.submit();
								} catch (err) {
									/* ignore */
								}
							}, 80);
						}
						return true;
					},
					onModelPreparing: (data) => {
						const ratio = data && typeof data.progress === "number" ? data.progress : 0;
						healthRef.current = { status: "downloading", progress: ratio };
						if (!disposed) setProgress(ratio);
					},
				};

				const controller = createController(ui);
				ui.self = controller;

				const instance = {
					controller,
					// 归属判定:不管浮层卡片当前是否可见,我的节点和这个输入框在同一个
					// composer 卡片里,就归我处理(见 nodeOwnsEditor 的注释)
					ownsEditor: (editorEl) => nodeOwnsEditor(rootRef.current, editorEl),
					onMouseDown: (e) => controller.onMouseDown(e),
					onMouseMove: (e) => controller.onMouseMove(e),
					onMouseUp: (e) => controller.onMouseUp(e),
					onKeyDown: (e) => controller.onKeyDown(e),
					onBlur: () => controller.onBlur(),
				};
				registry.instances.push(instance);

				// 配置 + 预热模型(后台把 228MB 模型准备好,省得第一次长按干等)
				(async () => {
					try {
						const res = await fetch(API + "/config", { headers: { accept: "application/json" } });
						if (res.ok) {
							const data = await res.json();
							if (!disposed) cfgRef.current = { ...FALLBACK_CONFIG, ...data };
						}
					} catch (err) {
						/* 路由不可用时用默认值 */
					}
					try {
						await fetch(API + "/health?prepare=1", { headers: { accept: "application/json" } });
					} catch (err) {
						/* ignore */
					}
				})();

				healthTimer = setInterval(async () => {
					if (disposed) return;
					try {
						const res = await fetch(API + "/health", { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						const model = (data && data.model) || {};
						healthRef.current = { status: model.status || "unknown", progress: model.progress || 0 };
						if (model.status === "ready") {
							clearInterval(healthTimer);
							healthTimer = null;
						}
					} catch (err) {
						/* ignore */
					}
				}, 3000);

				return () => {
					disposed = true;
					if (healthTimer) clearInterval(healthTimer);
					if (messageTimer) clearTimeout(messageTimer);
					const index = registry.instances.indexOf(instance);
					if (index >= 0) registry.instances.splice(index, 1);
					controller.abort();
				};
			}, []);

			const showCard = phase !== "idle" || interim !== "" || message !== "";

			const levels = meter.levels && meter.levels.length ? meter.levels : [];
			const bars = [];
			for (let i = 0; i < 9; i++) {
				const sample = levels.length ? levels[Math.max(0, levels.length - 9 + i)] : 0;
				const height = Math.max(3, Math.min(18, Math.round(sample * 46)));
				bars.push(h("i", { key: i, style: { height: height + "px" } }));
			}

			let hint;
			if (armed) hint = "松开取消";
			else if (phase === "holding") hint = "松开发送 · 上滑取消";
			else if (phase === "working") hint = message || "识别中…";
			else if (message) hint = message;
			else hint = "";

			const modelHint =
				healthRef.current.status === "downloading"
					? "语音模型准备中 " + Math.round((healthRef.current.progress || 0) * 100) + "%(首次使用需下载 228MB,仅一次)"
					: healthRef.current.status === "error"
						? "语音模型准备失败,请查看宿主日志"
						: "";

			// 外层标记节点**永远渲染**(哪怕卡片隐藏):它是归属判定的锚点,也是
			// 长按在第一次成功之后还能继续工作的前提(见 nodeOwnsEditor 注释)。
			return h(
				"span",
				{ ref: rootRef, className: "dsh-htt-src", style: MARKER_STYLE },
				showCard
					? h(
							"div",
							{ className: "dsh-htt" },
							h(
								"div",
								{ className: "dsh-htt__card" + (armed ? " is-armed" : "") },
								h(
									"div",
									{ className: "dsh-htt__row" },
									h(
										"span",
										{ className: "dsh-htt__mic" + (phase === "holding" && !armed ? " is-live" : "") },
										armed ? "✕" : phase === "holding" ? "●" : phase === "working" ? "⋯" : "🎤",
									),
									h("span", { className: "dsh-htt__wave" }, bars),
									h("span", { className: "dsh-htt__time" }, formatSeconds(meter.ms || 0)),
								),
								hint ? h("div", { className: "dsh-htt__hint" }, hint) : null,
								interim ? h("div", { className: "dsh-htt__text" }, interim) : null,
								!interim && phase === "working" ? h("div", { className: "dsh-htt__text dsh-htt__text--pending" }, "正在识别整段语音…") : null,
								modelHint ? h("div", { className: "dsh-htt__hint dsh-htt__text--warn" }, modelHint) : null,
								healthRef.current.status === "downloading" && progress > 0
									? h("div", { className: "dsh-htt__bar" }, h("span", { style: { width: Math.round(progress * 100) + "%" } }))
									: null,
							),
						)
					: null,
			);
		}

		/* --------------------------------------------------------------- 注册 */

		function apply(ctx) {
			ensureCss();
			const slots = ctx.get("slots");
			if (!slots) {
				console.warn(TAG, "slots 服务不可用,浮层未注册");
				return;
			}
			slots.inject("conversation.input.overlay", () =>
				slots.register(
					{
						name: "conversation.input.overlay",
						id: "hold-to-talk",
						order: 30,
					},
					HoldToTalk,
				),
			);
		}

		module.exports = {
			name: "dsh-hold-to-talk",
			inject: ["slots"],
			apply,
			// 仅供 tools/ 下的离线测试驱动核心逻辑;DSH 运行时不会读这个字段
			__test: { createController, composeDraft, resampleTo16k, createBuffer, registry, nodeOwnsEditor, pickInstanceFor },
		};
		return module.exports;
	},
});
