// dsh-window-size-keeper 的**客户端半个插件**（运行在 DSH 桌面端 / Web UI 里）。
//
// 作用：在 DSH 设置页里加一个「窗口大小」分区——列出常用分辨率（1024×768 … 3840×2160）
// 与「上次尺寸 / 自定义宽高」，选中即通过宿主路由把主窗口改成该尺寸并居中，同时持久化，
// 下次启动沿用同一尺寸。另带「恢复时居中」开关与当前窗口外框尺寸展示。
//
// 文案语言（2026-10-19 新增，见 README.md / README_zh.md 的 Language 一节）：
// 本分区的中英文文案都在 `dictionaries` 里，语言按这个顺序定：
//   1. patch config 的 `language`（写死 "zh" 或 "en"，经宿主 /state 下发）；
//   2. DSH 客户端的当前语言（`ctx.locale`，即「设置 → 通用 → 语言」；切换立即生效，不必重启）；
//   3. 插件自带的 `detectLanguage()`：只有**简体中文**走中文，zh-TW/zh-Hant 与任何其它语言一律英文。
// 第 2 步拿得到就一律跟随 DSH —— 用户在应用里选了什么语言这里就是什么语言；第 3 步只在客户端
// 运行时不提供语言服务（DSH 0.1 系）时兜底。宿主侧不做界面翻译：它只发数据、稳定原因码
// （`code` / `noteCodes`）和中英两份预选项别名（`label` / `labelEn`），文案全在这里。
//
// 与宿主侧的通道：宿主在 lib/index.js 里用 webServer.register 注册了
// `/window-size-keeper/api`（GET /state、POST /select、POST /apply、POST /reset），
// 这里直接 fetch——与 @dsh-pet/bridge 的「桌宠」分区、dsh-super-injector 的「插件」
// 分区同一套做法，不引入任何新机制、也没有第三方依赖。
//
// 加载方式：DSH 客户端按 package.json 的 `dsh.client` + `exports["./client"]` 找到本文件，
// 用 window.__ModuleLoader__.load 的工厂形式执行；`inject = ["slots"]` 是本模块对客户端
// 运行时声明的依赖（和宿主侧 cordis 的 inject 同语义）。
//
// ⚠️ 为什么不把 "locale" 写进 inject：声明了某个服务而运行时没有它，会让这半个插件**整块起不来**
// （设置页里这个分区直接消失，而且不报错）。语言服务是 DSH 0.2 客户端才有的，所以这里对
// `ctx.locale` 用可选访问 + try/catch：拿不到就退回第 3 步的自带判定——功能不降级、也不会炸。
//
// ⚠️ 客户端槽位契约（照 @dsh-pet/bridge 2026-09-29 实机踩坑结论，形状错了**不报错、只是空白**）：
// 1. 组件是 `slots.register(options, component)` 的**第二个参数**，不是选项字段；
// 2. 工厂必须返回 **React 元素**（设置外壳是 React；返回 DOM 节点渲染不出来）；
// 3. `ctx.effect(...)` 管的是"注册"的清理，**渲染**的清理归 `useEffect` 的返回函数。
// 可工作的参照就是 dsh-pet-bridge 的 `ctx.slots.register({...}, () => react.createElement(...))`。

window.__ModuleLoader__.load({
	id: "dsh-window-size-keeper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// React 由客户端模块加载器注入（与 dsh-pet-bridge / dshmarket 同源），不是新增依赖。
		const React = require("react");
		const inject = ["slots"];
		const API = "/window-size-keeper/api";
		const CUSTOM = "custom";
		const LAST = ""; // 空串 = 用"上次尺寸"
		const REFRESH_MS = 10000;
		/** 词典命名空间（DSH 的 locale 契约：注册后框架按当前语言取值）。 */
		const NS = "window-size-keeper";
		/** 本插件支持的显示语言：与 DSH 自带的语言条目一致，只有中英两种。 */
		const LANGS = ["zh", "en"];

		// ---- 词典：zh 是 key 集权威，en 必须逐 key 对齐（scripts/selftest.mjs 第 [8] 组验三条）----
		// 带 {占位符} 的是模板，参数由代码填；标点、连接符也算文案，所以同样在词典里。
		const dictionaries = {
			zh: {
				"lang.code": "zh",
				"nav.title": "窗口大小",
				"page.title": "窗口大小",
				"page.hint": "选中即把主窗口改成该尺寸（并按设置居中），同时记住它——下次启动沿用同一尺寸。选「上次尺寸」则回到「跟随上一次手动调整」的行为。",
				"current.loading": "读取中…",
				"current.none": "当前主窗口外框：尚未读到（插件刚启动，稍后自动刷新）",
				"current.line": "当前主窗口外框：{width}×{height}（位置 {x}, {y}）{saved}",
				"current.saved": "　上次保存 {at}",
				"card.presets": "恢复尺寸",
				"option.last": "上次尺寸",
				"option.last.alias": "跟随上一次手动调整",
				"option.custom": "自定义…",
				"option.custom.alias": "任意宽高（外框物理像素）",
				"custom.hint": "填入宽高后点「应用自定义尺寸」",
				"custom.width": "宽",
				"custom.height": "高",
				"custom.apply": "应用自定义尺寸",
				"custom.invalid": "自定义宽高必须是正整数",
				"center.title": "恢复时居中",
				"center.alias": "把窗口居中到主屏工作区；关掉则只改大小、不动位置",
				"center.on": "已开启居中，正在居中…",
				"center.off": "已关闭居中",
				"action.applyNow": "立即应用当前选择",
				"action.refresh": "刷新",
				"busy.switching": "正在切换到 {size}…",
				"busy.applying": "正在应用…",
				"msg.already": "已是该尺寸，无需改动",
				"msg.alreadyNow": "已是当前尺寸与位置，无需改动",
				"msg.applied": "已应用：{width}×{height} @ ({x}, {y})",
				"msg.appliedPlain": "已应用",
				"msg.selectSavedButFailed": "已记录选择，但这次改窗口失败：{error}",
				"msg.saveFailed": "保存失败：{error}",
				"msg.applyFailed": "应用失败：{error}",
				"msg.readFailed": "读取失败：{error}",
				"msg.unknownError": "未知错误",
				"meta.next": "下次启动将用：{target}",
				"meta.target": "{width}×{height}（来源 {source}）",
				"meta.lastFallback": "上次尺寸",
				"meta.limits": "尺寸上下限：{minW}×{minH} – {maxW}×{maxH}",
				"meta.settingsFile": "设置文件：{path}",
				"meta.stateFile": "状态文件：{path}",
				"meta.unknown": "(未知)",
				"meta.unsupported": "注意：当前平台（{platform}）不支持改窗口大小，设置只会记录、不会应用。",
				"err.enum_failed": "窗口枚举失败",
				"err.enum_failed.detail": "窗口枚举失败：{detail}",
				"err.enum_bad_json": "窗口枚举结果不是合法 JSON",
				"err.main_window_not_found": "未定位到 DSH 主窗口（标题/窗口类不匹配，或宿主 PID 已变）",
				"err.superseded": "已有新的插件实例接管，本次应用已放弃",
				"err.set_pos_failed": "SetWindowPos 连续 3 次失败（PowerShell 冷启动或窗口权限）",
				"err.windows_only": "窗口尺寸调整仅支持 Windows（当前：{platform}）",
				"err.no_target": "既没有可用尺寸，也没有开启居中",
				"err.bad_json_body": "请求体不是合法 JSON",
				"err.unknown_route": "未知路由: {method} {route}",
				"err.internal_error": "插件内部错误",
				"err.apply_failed": "改窗口失败",
				"err.invalid_input": "输入不合法",
				"err.unknown_preset": "未知的 preset id：{id}",
				"err.custom_clamped": "自定义宽高已夹取到 {w}×{h}（上下限 {minW}×{minH} – {maxW}×{maxH}）",
				"err.custom_not_positive": "自定义宽高不是正整数，已忽略",
				"err.custom_pending": "自定义尺寸还没有有效宽高，已保持原选择不变"
			},
			en: {
				"lang.code": "en",
				"nav.title": "Window size",
				"page.title": "Window size",
				"page.hint": "Picking a size resizes the main window at once (centring follows your setting) and remembers it — the next start uses the same size. Choose “Last size” to go back to following your last manual resize.",
				"current.loading": "Loading…",
				"current.none": "Main window frame: not read yet (the plugin just started; it refreshes itself shortly)",
				"current.line": "Main window frame: {width}×{height} at ({x}, {y}){saved}",
				"current.saved": "  last saved {at}",
				"card.presets": "Restore size",
				"option.last": "Last size",
				"option.last.alias": "follow my last manual resize",
				"option.custom": "Custom…",
				"option.custom.alias": "any width×height (outer frame, physical pixels)",
				"custom.hint": "Enter a width and height, then press “Apply custom size”",
				"custom.width": "Width",
				"custom.height": "Height",
				"custom.apply": "Apply custom size",
				"custom.invalid": "Custom width and height must be positive integers",
				"center.title": "Centre on restore",
				"center.alias": "Centre the window on the primary work area; switched off it resizes only and leaves the position alone",
				"center.on": "Centring switched on — centring now…",
				"center.off": "Centring switched off",
				"action.applyNow": "Apply current selection",
				"action.refresh": "Refresh",
				"busy.switching": "Switching to {size}…",
				"busy.applying": "Applying…",
				"msg.already": "Already at this size — nothing to change",
				"msg.alreadyNow": "Already at this size and position — nothing to change",
				"msg.applied": "Applied: {width}×{height} @ ({x}, {y})",
				"msg.appliedPlain": "Applied",
				"msg.selectSavedButFailed": "Selection saved, but this resize failed: {error}",
				"msg.saveFailed": "Save failed: {error}",
				"msg.applyFailed": "Apply failed: {error}",
				"msg.readFailed": "Read failed: {error}",
				"msg.unknownError": "unknown error",
				"meta.next": "Next start will use: {target}",
				"meta.target": "{width}×{height} (source: {source})",
				"meta.lastFallback": "last size",
				"meta.limits": "Size bounds: {minW}×{minH} – {maxW}×{maxH}",
				"meta.settingsFile": "Settings file: {path}",
				"meta.stateFile": "State file: {path}",
				"meta.unknown": "(unknown)",
				"meta.unsupported": "Note: resizing windows is not supported on {platform}; these settings are recorded but never applied.",
				"err.enum_failed": "Window enumeration failed",
				"err.enum_failed.detail": "Window enumeration failed: {detail}",
				"err.enum_bad_json": "Window enumeration returned malformed JSON",
				"err.main_window_not_found": "Could not find the DSH main window (title/class mismatch, or the host PID changed)",
				"err.superseded": "A newer plugin instance took over; this apply was dropped",
				"err.set_pos_failed": "SetWindowPos failed 3 times in a row (PowerShell cold start or window permissions)",
				"err.windows_only": "Window resizing only supports Windows (current platform: {platform})",
				"err.no_target": "No usable size available and centring is switched off",
				"err.bad_json_body": "Request body is not valid JSON",
				"err.unknown_route": "Unknown route: {method} {route}",
				"err.internal_error": "Plugin internal error",
				"err.apply_failed": "Resizing the window failed",
				"err.invalid_input": "Invalid input",
				"err.unknown_preset": "Unknown preset id: {id}",
				"err.custom_clamped": "Custom size clamped to {w}×{h} (bounds {minW}×{minH} – {maxW}×{maxH})",
				"err.custom_not_positive": "Custom width/height were not positive integers and were ignored",
				"err.custom_pending": "Custom size has no valid width/height yet; your selection stayed unchanged"
			}
		};

		/** 模板填参数（与 DSH locale 服务的 `{name}` 口径一致）；认不出的占位符原样留着，不吞信息。 */
		function formatTemplate(template, params) {
			if (!params) return String(template);
			return String(template).replace(/\{(\w+)\}/g, (match, name) =>
				Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
		}

		/** 本地词典取值（框架不可用时的路径）：指定语言缺 key 退到 en，再缺就返回 key 本身。 */
		function translate(lang, key, params) {
			const dict = dictionaries[lang] || dictionaries.en;
			const value = dict[key] !== undefined ? dict[key] : dictionaries.en[key];
			return formatTemplate(value !== undefined ? value : key, params);
		}

		/**
		 * 「是不是简体中文」：zh、zh-Hans*、zh-CN、zh-SG、zh-MY 算；
		 * zh-TW / zh-HK / zh-MO / zh-Hant* 是繁体写法，**不算**——按"非简体中文一律英文"处理。
		 */
		function isSimplifiedChinese(tag) {
			const v = String(tag || "").trim().toLowerCase().replace(/_/g, "-");
			if (!v) return false;
			if (/^zh-(hant|tw|hk|mo)(?:-|$)/.test(v)) return false;
			if (v === "zh" || v === "zh-cn" || v === "zh-sg" || v === "zh-my") return true;
			return /^zh-hans(?:-|$)/.test(v);
		}

		/**
		 * 浏览器环境判定：按用户偏好顺序逐个看，**第一个能归类的就定案**——
		 * 繁体环境常常在后面挂一个通用的 "zh"，不能被它带成简体中文。
		 * 英文系写法（en / en-GB …）→ en；简体中文写法 → zh；中文但不是简体 → 直接 en；
		 * 其它语言继续往下看，看完都不认识就 en（本插件只有中英两种）。
		 */
		function detectLanguage(env) {
			const source = env || {};
			const tags = [];
			if (Array.isArray(source.languages)) tags.push(...source.languages);
			if (source.language) tags.push(source.language);
			if (source.intlLocale) tags.push(source.intlLocale);
			for (const tag of tags) {
				const v = String(tag || "").trim().toLowerCase().replace(/_/g, "-");
				if (!v) continue;
				if (v.startsWith("en")) return "en";
				if (isSimplifiedChinese(v)) return "zh";
				if (v.startsWith("zh")) return "en"; // 中文环境但不是简体中文 → 英文
			}
			return "en";
		}

		/**
		 * 语言判定优先级（纯函数，全部分支可离线测）：配置写死 → DSH 当前语言 → 浏览器兜底。
		 * 认不出的值一律继续往下走，绝不因为"值奇怪"就把界面哑掉。
		 * @param override 配置里写死的语言（"zh"/"en"，其它值视为没写）
		 * @param active   DSH locale 快照里的当前语言
		 * @param probe    问框架要 `lang.code` 得到的当前语言（快照拿不到时用）
		 * @param env      浏览器语言线索
		 */
		function resolveLanguage({ override, active, probe, env } = {}) {
			if (override === "zh" || override === "en") return override;
			if (active === "zh" || active === "en") return active;
			if (probe === "zh" || probe === "en") return probe;
			return detectLanguage(env);
		}

		/** 预选项显示哪一份别名：英文环境有 labelEn 就用它；没有就原样显示 label（绝不机器翻译用户自己写的名字）。 */
		function presetLabel(preset, lang) {
			const p = preset || {};
			if (lang === "en" && p.labelEn) return String(p.labelEn);
			return String(p.label || "");
		}

		/** 从「宽×高（别名）」里取出别名部分；没有括号就原样返回。 */
		function presetAlias(labelText) {
			const text = String(labelText || "");
			return text.replace(/^[0-9]+×[0-9]+\s*/, "").replace(/[（(【\[]\s*([^\]）)】]*)\s*[】)\]）]/, "$1").trim() || text;
		}

		/** 词典里有没有这个码的文案（zh 表为准：两表 key 集相同，自检钉着）。 */
		function hasErrorCode(code) {
			return typeof code === "string" && dictionaries.zh[`err.${code}`] !== undefined;
		}

		/**
		 * 宿主回报的原因码 → 当前语言的文案。认得出的码走词典（`detail` 存在时用带详情的那条）；
		 * 认不出来的码退回宿主给的 `error` 原文；连原文都没有就给一条通用失败文案。
		 * 绝不把未知错误码原样甩给用户，也绝不在码缺失时哑掉。
		 */
		function errorText(lang, payload) {
			const data = payload || {};
			const code = typeof data.code === "string" ? data.code : "";
			const detail = typeof data.detail === "string" && data.detail ? data.detail : "";
			if (code) {
				const key = `err.${code}`;
				const detailKey = `${key}.detail`;
				if (detail && hasErrorCode(`${code}.detail`)) return translate(lang, detailKey, { detail });
				if (hasErrorCode(code)) return translate(lang, key, data.params || {});
			}
			if (typeof data.error === "string" && data.error) return data.error;
			return translate(lang, "msg.unknownError");
		}

		/** 校验提示列表：有 noteCodes 就按码 + 参数渲染；没有（旧宿主）就原样显示它给的字符串。 */
		function notesText(lang, payload) {
			const data = payload || {};
			const fallback = Array.isArray(data.notes) ? data.notes.map((n) => String(n)) : [];
			const codes = Array.isArray(data.noteCodes) ? data.noteCodes : [];
			if (!codes.length) return fallback;
			return codes.map((entry, index) => {
				const code = entry && typeof entry.code === "string" ? entry.code : "";
				if (hasErrorCode(code)) return translate(lang, `err.${code}`, (entry && entry.params) || {});
				return fallback[index] !== undefined ? fallback[index] : translate(lang, "msg.unknownError");
			});
		}

		// i18n 内核（纯函数）导出给离线自检：不起进程、不碰 DOM、不发请求。
		exports.__i18n = {
			NS, LANGS, dictionaries, formatTemplate, translate, isSimplifiedChinese,
			detectLanguage, resolveLanguage, presetLabel, presetAlias, hasErrorCode, errorText, notesText
		};

		const styles = `
.wsk-page{font-size:12px;line-height:1.7;padding:14px 16px;max-width:760px}
.wsk-page h3{margin:0 0 4px;font-size:13px}
.wsk-hint{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 12px}
.wsk-current{font-size:12px;margin:0 0 12px}
.wsk-current b{font-weight:600}
.wsk-card{border:1px solid var(--theme-border,#333);border-radius:8px;padding:10px 12px;margin-bottom:10px}
.wsk-card h4{margin:0 0 8px;font-size:12px;font-weight:600}
.wsk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:4px 12px}
.wsk-opt{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
.wsk-opt input{accent-color:var(--theme-accent,#4a9eff);cursor:pointer}
.wsk-opt .sz{font-weight:600}
.wsk-opt .al{color:var(--theme-text-secondary,#888);font-size:11px}
.wsk-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.wsk-input{width:84px;background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:5px 7px;font-size:12px}
.wsk-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;white-space:nowrap}
.wsk-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.wsk-btn:disabled{opacity:.45;cursor:not-allowed}
.wsk-switch{position:relative;width:38px;height:20px;flex:0 0 auto}
.wsk-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.wsk-slider{position:absolute;inset:0;border-radius:10px;background:var(--theme-border,#444);transition:background .15s}
.wsk-slider::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.wsk-switch input:checked + .wsk-slider{background:var(--theme-accent,#4a9eff)}
.wsk-switch input:checked + .wsk-slider::after{transform:translateX(18px)}
.wsk-switch input:disabled + .wsk-slider{opacity:.5}
.wsk-label{flex:1}
.wsk-label b{font-weight:600}
.wsk-msg{margin-top:8px;font-size:11px;color:var(--theme-text-secondary,#999);white-space:pre-wrap}
.wsk-msg.err{color:#e0645c}
.wsk-msg.ok{color:#2ecc71}
.wsk-meta{color:var(--theme-text-secondary,#888);font-size:11px;margin-top:8px;word-break:break-all;white-space:pre-wrap}
.wsk-hidden{display:none}
`;

		function el(tag, cls, text) {
			const node = document.createElement(tag);
			if (cls) node.className = cls;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		function fetchJson(path, init) {
			return fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init
			}).then((response) => response.json());
		}

		/** 读客户端能拿到的环境语言线索（全部可选访问：受限环境里缺谁就跳过谁）。 */
		function localeEnv() {
			const env = { languages: [], language: "", intlLocale: "" };
			try {
				if (typeof navigator !== "undefined") {
					if (Array.isArray(navigator.languages)) env.languages = navigator.languages.slice();
					if (navigator.language) env.language = String(navigator.language);
				}
			} catch {
				// 没有 navigator：继续往下走，最终兜底英文
			}
			try {
				if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
					env.intlLocale = String((Intl.DateTimeFormat().resolvedOptions() || {}).locale || "");
				}
			} catch {
				// 拿不到 Intl 就只用 navigator
			}
			return env;
		}

		/**
		 * 语言上下文：优先用框架绑定的 t（`ctx.locale.bind(NS)`，跟随 DSH 当前语言），
		 * 拿不到就用本地词典 + `resolveLanguage()` 自己定语言。两条路对外同一个 `tr()`。
		 */
		function makeLocale(ctxLocale) {
			let lang = detectLanguage(localeEnv());
			let override = "";
			let frameworkT = null;
			if (ctxLocale && typeof ctxLocale.bind === "function") {
				try {
					const bound = ctxLocale.bind(NS);
					if (typeof bound === "function") frameworkT = (key, params) => bound(key, params);
				} catch {
					// 框架不接受 bind：退回本地词典，功能不降级
				}
				// 探针：词典没真注册上时（bind 却可用）框架会把 key 原样还回来。
				// 那种情况必须现在就退回本地词典，否则界面会露出 "page.title" 这种内部 key。
				if (frameworkT) {
					try {
						const code = frameworkT("lang.code");
						if (code !== "zh" && code !== "en") frameworkT = null;
					} catch {
						frameworkT = null;
					}
				}
			}
			const tr = (key, params) => (frameworkT ? frameworkT(key, params) : translate(lang, key, params));
			return {
				/** 当前生效语言（英文环境要挑 labelEn 就得靠它）。 */
				get lang() {
					return lang;
				},
				usesFramework() {
					return !!frameworkT;
				},
				tr,
				/**
				 * 定语言：`/state` 载荷里带的配置写死值优先，其次问框架（快照 → `lang.code` 探针），
				 * 都没有就用浏览器线索。payload 缺省时保留已知的配置写死值（别被一次订阅把它抹掉）。
				 */
				sync(payload) {
					if (payload && (payload.language === "zh" || payload.language === "en")) override = payload.language;
					let active = "";
					let probe = "";
					if (ctxLocale) {
						try {
							const snap = typeof ctxLocale.getSnapshot === "function" ? ctxLocale.getSnapshot() : null;
							if (snap && (snap.active === "zh" || snap.active === "en")) active = snap.active;
						} catch {
							// 快照拿不到就试探针；两条都不通退回浏览器判定
						}
						if (!active && frameworkT) {
							const code = frameworkT("lang.code");
							if (code === "zh" || code === "en") probe = code;
						}
					}
					lang = resolveLanguage({ override, active, probe, env: localeEnv() });
					return lang;
				}
			};
		}

		/**
		 * 只负责建 DOM 并返回**节点**：定时器与清理交给 React 侧的 useEffect
		 *（那是客户端槽位契约第 3 条）。选项列表在首次 GET 成功后按宿主返回的
		 * presets 建一次，之后只更新勾选/文本，避免每 10 秒重建打断用户操作。
		 *
		 * 文案一律走 `locale.tr()`，并且每条**静态**文案都登记进 `sinks`：DSH 里切换语言时
		 * 不重建 DOM（重建会丢掉用户正在输入的自定义宽高），只把登记的文案重刷一遍。
		 */
		function buildPage(refreshRef, locale) {
			const sinks = [];
			let lastPayload = null;
			let lastMessage = null; // { key, params, kind } —— 切语言时把上一条提示也说成当前语言

			const tr = (key, params) => locale.tr(key, params);

			function setText(node, key, getParams) {
				const apply = () => {
					node.textContent = tr(key, typeof getParams === "function" ? getParams() : undefined);
				};
				sinks.push(apply);
				apply();
				return node;
			}

			function setPlaceholder(node, key) {
				const apply = () => {
					node.placeholder = tr(key);
				};
				sinks.push(apply);
				apply();
				return node;
			}

			const style = el("style");
			style.textContent = styles;
			const page = el("div", "wsk-page");
			page.append(style);
			page.append(setText(el("h3"), "page.title"));
			page.append(setText(el("p", "wsk-hint"), "page.hint"));

			const current = el("div", "wsk-current");
			setText(current, "current.loading");
			page.append(current);

			const card = el("div", "wsk-card");
			card.append(setText(el("h4"), "card.presets"));
			const grid = el("div", "wsk-grid");
			card.append(grid);
			page.append(card);

			// 自定义宽高：只在选中「自定义…」时出现
			const customRow = el("div", "wsk-row wsk-hidden");
			const wIn = el("input", "wsk-input");
			wIn.type = "number";
			wIn.min = "1";
			setPlaceholder(wIn, "custom.width");
			const hIn = el("input", "wsk-input");
			hIn.type = "number";
			hIn.min = "1";
			setPlaceholder(hIn, "custom.height");
			const applyCustom = el("button", "wsk-btn");
			setText(applyCustom, "custom.apply");
			customRow.append(setText(el("span", "wsk-al"), "custom.width"), wIn,
				setText(el("span", "wsk-al"), "custom.height"), hIn, applyCustom);
			card.append(customRow);

			// 居中开关
			const centerCard = el("div", "wsk-card");
			const centerRow = el("div", "wsk-row");
			const switchWrap = el("label", "wsk-switch");
			const centerInput = el("input");
			centerInput.type = "checkbox";
			const slider = el("span", "wsk-slider");
			switchWrap.append(centerInput, slider);
			const centerLabel = el("div", "wsk-label");
			centerLabel.append(setText(el("b"), "center.title"), setText(el("div", "wsk-al"), "center.alias"));
			centerRow.append(switchWrap, centerLabel);
			centerCard.append(centerRow);
			page.append(centerCard);

			const actions = el("div", "wsk-row");
			const applyNowBtn = el("button", "wsk-btn ghost");
			setText(applyNowBtn, "action.applyNow");
			const refreshBtn = el("button", "wsk-btn ghost");
			setText(refreshBtn, "action.refresh");
			actions.append(applyNowBtn, refreshBtn);
			page.append(actions);

			const msg = el("div", "wsk-msg");
			page.append(msg);
			const meta = el("div", "wsk-meta");
			page.append(meta);

			const say = (text, kind, message) => {
				msg.textContent = text || "";
				msg.className = `wsk-msg${kind ? ` ${kind}` : ""}`;
				if (message) lastMessage = message;
				else lastMessage = null;
			};
			const sayKey = (key, params, kind) => {
				say(tr(key, params), kind, { key, params, kind });
			};
			/** 切语言后把上一条提示也用新语言说一遍（不重复也说得通：它本来就是当前状态的转述）。 */
			const resay = () => {
				if (lastMessage) say(tr(lastMessage.key, lastMessage.params), lastMessage.kind, lastMessage);
			};

			// ---- 选项列表（首次 GET 后按宿主 presets 建一次）----
			const radios = new Map(); // preset id（含 "" 与 "custom"）→ { input, sz, al }
			let built = false;
			let presetData = [];
			let limits = { minW: 1, minH: 1, maxW: 99999, maxH: 99999 };

			function addOption(id, sizeText, alias) {
				const label = el("label", "wsk-opt");
				const input = el("input");
				input.type = "radio";
				input.name = "wsk-preset";
				input.value = id;
				const sz = el("span", "sz", sizeText);
				const al = el("span", "al", alias || "");
				label.append(input, sz, al);
				grid.append(label);
				radios.set(id, { input, sz, al });
				input.addEventListener("change", () => {
					if (!input.checked) return;
					if (id === CUSTOM) {
						customRow.classList.remove("wsk-hidden");
						wIn.focus();
						return sayKey("custom.hint", undefined, "");
					}
					customRow.classList.add("wsk-hidden");
					post({ preset: id }, tr("busy.switching", { size: sizeText }));
				});
				return input;
			}

			function buildOptions(presets) {
				if (built) return;
				built = true;
				presetData = Array.isArray(presets) ? presets.slice() : [];
				addOption(LAST, tr("option.last"), tr("option.last.alias"));
				for (const p of presetData) {
					addOption(p.id, `${p.width}×${p.height}`, presetAlias(presetLabel(p, locale.lang)));
				}
				addOption(CUSTOM, tr("option.custom"), tr("option.custom.alias"));
			}

			/** 切语言：把每条选项的字号文本与别名换过来（列表不重建，勾选和输入内容都不丢）。 */
			function localizeOptions() {
				if (!built) return;
				const last = radios.get(LAST);
				if (last) {
					last.sz.textContent = tr("option.last");
					last.al.textContent = tr("option.last.alias");
				}
				const custom = radios.get(CUSTOM);
				if (custom) {
					custom.sz.textContent = tr("option.custom");
					custom.al.textContent = tr("option.custom.alias");
				}
				for (const p of presetData) {
					const entry = radios.get(p.id);
					if (!entry) continue;
					entry.sz.textContent = `${p.width}×${p.height}`;
					entry.al.textContent = presetAlias(presetLabel(p, locale.lang));
				}
			}

			function post(body, busyText) {
				for (const entry of radios.values()) entry.input.disabled = true;
				applyCustom.disabled = true;
				applyNowBtn.disabled = true;
				centerInput.disabled = true;
				if (busyText) say(busyText);
				return fetchJson("/select", { method: "POST", body: JSON.stringify(body) })
					.then((data) => {
						applyState(data);
						if (!data || data.ok === false) {
							const why = errorText(locale.lang, data && data.applied ? { ...data, ...data.applied } : data);
							const text = tr("msg.selectSavedButFailed", { error: why });
							return say(text, "err", { key: "msg.selectSavedButFailed", params: { error: why }, kind: "err" });
						}
						const a = data.applied;
						if (a?.already) return sayKey("msg.already", undefined, "ok");
						const r = a?.rect;
						return r
							? sayKey("msg.applied", { width: r.width, height: r.height, x: r.x, y: r.y }, "ok")
							: sayKey("msg.appliedPlain", undefined, "ok");
					})
					.catch((err) => {
						const error = String(err);
						say(tr("msg.saveFailed", { error }), "err", { key: "msg.saveFailed", params: { error }, kind: "err" });
					})
					.finally(() => {
						for (const entry of radios.values()) entry.input.disabled = false;
						applyCustom.disabled = false;
						applyNowBtn.disabled = false;
						centerInput.disabled = false;
					});
			}

			function readCustomInputs() {
				const width = Math.round(Number(wIn.value));
				const height = Math.round(Number(hIn.value));
				if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
				return { width, height };
			}

			applyCustom.addEventListener("click", () => {
				const custom = readCustomInputs();
				if (!custom) return sayKey("custom.invalid", undefined, "err");
				post({ preset: CUSTOM, custom }, tr("busy.switching", { size: `${custom.width}×${custom.height}` }));
			});

			centerInput.addEventListener("change", () => {
				post({ centerOnRestore: centerInput.checked }, centerInput.checked ? tr("center.on") : tr("center.off"));
			});

			applyNowBtn.addEventListener("click", () => {
				applyNowBtn.disabled = true;
				sayKey("busy.applying", undefined, "");
				fetchJson("/apply", { method: "POST", body: "{}" })
					.then((data) => {
						applyState(data);
						const a = data?.applied;
						if (!data || data.ok === false) {
							const why = errorText(locale.lang, a ? { ...data, ...a } : data);
							const text = tr("msg.applyFailed", { error: why });
							return say(text, "err", { key: "msg.applyFailed", params: { error: why }, kind: "err" });
						}
						const r = a?.rect;
						if (a?.already) return sayKey("msg.alreadyNow", undefined, "ok");
						return r
							? sayKey("msg.applied", { width: r.width, height: r.height, x: r.x, y: r.y }, "ok")
							: sayKey("msg.appliedPlain", undefined, "ok");
					})
					.catch((err) => {
						const error = String(err);
						say(tr("msg.applyFailed", { error }), "err", { key: "msg.applyFailed", params: { error }, kind: "err" });
					})
					.finally(() => {
						applyNowBtn.disabled = false;
					});
			});

			refreshBtn.addEventListener("click", refresh);

			function applyState(data) {
				if (!data || data.ok === false && !data.presets) {
					const error = errorText(locale.lang, data);
					say(tr("msg.readFailed", { error }), "err", { key: "msg.readFailed", params: { error }, kind: "err" });
					return;
				}
				locale.sync(data);
				lastPayload = data;
				limits = data.limits ?? limits;
				wIn.min = String(limits.minW);
				hIn.min = String(limits.minH);
				wIn.max = String(limits.maxW);
				hIn.max = String(limits.maxH);
				buildOptions(data.presets);

				const live = data.lastKnown ?? data.lastSaved ?? null;
				current.textContent = live
					? tr("current.line", {
							width: live.width,
							height: live.height,
							x: live.x,
							y: live.y,
							saved: live.savedAt ? tr("current.saved", { at: live.savedAt }) : ""
						})
					: tr("current.none");

				const preset = typeof data.preset === "string" ? data.preset : "";
				const entry = radios.get(preset);
				if (entry) entry.input.checked = true;
				if (preset === CUSTOM) customRow.classList.remove("wsk-hidden");
				if (data.custom && !wIn.value && !hIn.value) {
					wIn.value = String(data.custom.width);
					hIn.value = String(data.custom.height);
				}
				centerInput.checked = Boolean(data.centerOnRestore);

				const target = data.target;
				const targetText = target ? tr("meta.target", { width: target.width, height: target.height, source: target.source }) : tr("meta.lastFallback");
				meta.textContent = [
					tr("meta.next", { target: targetText }),
					tr("meta.limits", { minW: limits.minW, minH: limits.minH, maxW: limits.maxW, maxH: limits.maxH }),
					tr("meta.settingsFile", { path: data.settingsFile || tr("meta.unknown") }),
					tr("meta.stateFile", { path: data.stateFile || tr("meta.unknown") }),
					data.supported === false ? tr("meta.unsupported", { platform: data.platform }) : "",
					// 宿主给的是原因码，这里按当前语言渲染（旧宿主只给字符串时也照样显示）
					...notesText(locale.lang, data)
				].filter(Boolean).join("\n");

				localizeStatic();
			}

			/** 静态文案按当前语言整体重刷一遍：切语言不重建 DOM，输入与勾选保持原样。 */
			function localizeStatic() {
				for (const apply of sinks) apply();
				localizeOptions();
				resay();
			}

			function refresh() {
				return fetchJson("/state")
					.then(applyState)
					.catch((err) => {
						const error = String(err);
						say(tr("msg.readFailed", { error }), "err", { key: "msg.readFailed", params: { error }, kind: "err" });
					});
			}

			refreshRef.current = refresh;
			refreshRef.localize = localizeStatic;
			void lastPayload;
			refresh();

			return page;
		}

		function apply(ctx) {
			// 语言服务是"有它更好、没有也能跑"的东西：写进 inject 会让缺它的客户端运行时
			// 把这半个插件整个丢掉，所以这里可选取，取不到就退回浏览器判定。
			let ctxLocale = null;
			try {
				const candidate = ctx && (ctx.locale || (typeof ctx.get === "function" ? ctx.get("locale") : null));
				if (candidate && typeof candidate === "object") ctxLocale = candidate;
			} catch {
				// 受限 ctx 上访问未声明的服务会抛错：当作"没有语言服务"，不是故障
			}
			if (ctxLocale && typeof ctxLocale.register === "function") {
				try {
					ctx.effect(() => ctxLocale.register(NS, { zh: dictionaries.zh, en: dictionaries.en }), "window-size-keeper: dictionaries");
				} catch {
					// 同命名空间已被注册（热重载两代并存）或框架不接：退回本地词典渲染，功能不降级
				}
			}

			const locale = makeLocale(ctxLocale);
			locale.sync();

			/** 设置页「窗口大小」分区的 React 组件：把上面那份 DOM 挂进宿主，并管好定时器与语言订阅。 */
			function SizeSection() {
				const hostRef = React.useRef(null);
				const refreshRef = React.useRef(null);

				React.useEffect(() => {
					const page = buildPage(refreshRef, locale);
					const host = hostRef.current;
					if (host) host.appendChild(page);
					// DSH 里切语言：不重启、不重建，立刻把文案换过来（订阅是框架给的）
					let unsubscribe = null;
					if (ctxLocale && typeof ctxLocale.subscribe === "function") {
						try {
							unsubscribe = ctxLocale.subscribe(() => {
								locale.sync();
								if (typeof refreshRef.current === "function") refreshRef.current();
							});
						} catch {
							// 订阅失败就退回"下次刷新时自然换语言"，不影响功能
						}
					}
					const timer = window.setInterval(() => {
						const refresh = refreshRef.current;
						if (typeof refresh === "function") refresh();
					}, REFRESH_MS);
					return () => {
						window.clearInterval(timer);
						if (typeof unsubscribe === "function") {
							try {
								unsubscribe();
							} catch {
								// 解绑失败无所谓：fiber 卸载后没人再调它
							}
						}
						if (page.parentNode) page.parentNode.removeChild(page);
					};
				}, []);

				return React.createElement("div", { className: "wsk-host", ref: hostRef });
			}

			ctx.effect(
				() => ctx.slots.inject("settings.section", () => ctx.slots.register(
					// 选项只留白名单内的键；组件是**第二个参数**，且返回 React 元素。
					// `label` 给成 thunk：框架读它时才取文案，所以切语言分区标题也跟着换。
					{
						name: "settings.section",
						id: "window-size-keeper",
						order: 65,
						...(ctxLocale ? { locale: NS } : {}),
						label: () => locale.tr("nav.title")
					},
					() => React.createElement(SizeSection)
				)),
				"window-size-keeper: settings section"
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
