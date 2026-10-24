// dsh-window-size-keeper — DSH 桌面端窗口大小保持插件（host 侧，零外部依赖）
//
// 背景：DSH 桌面端（Electron）每次启动都会以固定默认尺寸（1280×820）重建主窗口，
// 用户上次调整的窗口大小丢失。本插件在宿主进程内：
//   1. 启动后**尽早**通过 Win32 把主窗口改成目标尺寸并居中：`apply` 那一刻起一个常驻
//      Win32 代理盯窗口，主窗口一被创建（还藏着的时候）就动手 —— 这早于 Electron 的
//      `show()`，所以窗口第一次露面就是上次的尺寸（`restoreEarly`，默认开）。盯不到才退回
//      `restoreDelayMs` 的轮询路径。目标尺寸：选中了预选项（preset）则用该分辨率，
//      否则用"上次尺寸"（centerOnRestore 关闭时位置不动、只改大小）；
//   2. 之后按**自适应节奏**采样窗口外框矩形：平时每 saveIntervalMs 一次；本轮采到与上一轮不同就转成
//      每 activeSampleMs（默认 1 秒）一次，最后一次变化起算满 activeTailMs 再退回待机节奏。采到变化即
//      持久化到状态文件；开了 followManualResize（默认开）时，**用户手动**改宽高还会把设置页的选择切成
//      「自定义」= 当时的宽高，于是下次启动用的就是刚拖出来的那个尺寸。
//   3. 进程退出（beforeExit/exit）时用内存缓存同步落盘，兜底捕获"最后一次"尺寸。自适应之后这份缓存最多
//      旧 1 秒；过去固定 15 秒时，"拖完马上退出"会把这次拖动整个丢掉（下次启动回到再上一个尺寸）。
//
// 预选项（presets）：内置常用分辨率清单（1024×768 … 3840×2160），选中即在恢复时
// 套用；也可在 config 里整体覆盖 `presets` 列表自定义。
//
// 设置页（2026-10-11 增）：DSH 桌面端「设置 → 窗口大小」分区（客户端半个插件
// lib/client.js，走 slots "settings.section"，与 @dsh-pet/bridge 的「桌宠」分区同一
// 套做法）。分区通过本文件注册的 HTTP 路由 `/window-size-keeper/api` 读写选择：
//   GET  /state            读当前选择、可用分辨率、最近一次窗口矩形与文件路径
//   POST /select           { preset, custom:{width,height}, centerOnRestore } → 落盘 + 立即应用
//   POST /apply            按当前选择立即应用一次（改尺寸 + 居中）
//   POST /reset            选择退回"上次尺寸"（preset=""）并立即应用
// 选择写入运行时设置文件 settings.json（与状态文件同目录，原子写），**选中即生效**
// （马上 resize），下次启动继续沿用；优先级：settings.json（设置页）> patch config > DEFAULTS。
//
// 实现方式：Win32 调用优先走一个**在本机现场编译出来的小助手 exe**（源码就写在
// `buildAgentCSharp()` 里，用系统自带的 .NET Framework csc 编译，缓存到状态文件同目录）：
// 起一次约 90ms，常驻进程内枚举一次只要几毫秒。编译不成、exe 起不来或答不上来，
// 整套退回原来的 `powershell.exe`（Add-Type P/Invoke）路径——那条路实测要 0.8s 起进程
// ＋ 0.45s 现场编译，即首次动手约 1.3s。宿主进程本身无沙箱，可自由 spawn。
//
// 零依赖红线：仅使用 node 内置模块（fs/os/path/crypto/child_process），不声明任何
// 运行时依赖，也**不往包里放任何二进制**——助手 exe 是在使用者本机从可见的 C# 源码
// 现编出来的。profile 经 pnpm link: 链接本目录，pnpm 不会安装被链接包自身的
// 依赖，一旦运行时依赖解析失败会让 Cordis 插件树整体抛错、DSH 无法启动
// （2026-09 事故，见 @dsh-pet/bridge 的同款注释）。
//
// 状态文件：~/.dsh/storages/window-size-keeper/state.json
//   { "version": 1, "width": 1894, "height": 1171, "x": 18, "y": 17, "savedAt": "..." }
//   width/height 为含标题栏与边框的外框尺寸（物理像素，GetWindowRect 原值）。
// 设置文件：~/.dsh/storages/window-size-keeper/settings.json（设置页写入，原子写）
//   { "version": 1, "preset": "1920x1080", "centerOnRestore": true,
//     "custom": { "width": 1600, "height": 1000 }, "updatedAt": "..." }
//   preset 为空串 = 用"上次尺寸"；preset 为 "custom" = 用 custom 里的宽高。
// 伴随文件：state.json.gen —— 代数（每次 apply 递增）。热重载后若旧 fiber 的
//   定时器未被宿主清理（僵尸 cycle），写入前发现代数已变即放弃，防止陈旧尺寸
//   覆盖状态文件。生命周期清理另经 ctx.fiber.effect 正规注册（fiber 卸载时
//   清定时器 + 移除 process 钩子 + 同步落盘）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";

export const name = "window-size-keeper";
export const inject = [];

const DEFAULTS = {
	/** 总开关；false 时插件完全静默。 */
	enabled: true,
	/** 待机采样间隔（毫秒）：窗口一直没变时多久读一次。 */
	saveIntervalMs: 15000,
	/** 快轮询间隔（毫秒）：本轮采到与上一轮不同就改用这个节奏（下限 250 ms）。 */
	activeSampleMs: 1000,
	/** 快轮询尾巴（毫秒）：最后一次采到变化起算，这段时间内保持快轮询，之后退回待机节奏。 */
	activeTailMs: 10000,
	/**
	 * 用户手动改宽高时，自动把「恢复尺寸」选择切成自定义 = 当时的宽高（下次启动就用它）。
	 * 只认宽高变化（只挪位置不动大小不改选择）；插件自己改的那一次（启动恢复、设置页应用）也不算，
	 * 否则用户选的 1920×1080（Full HD）会被自己改成"自定义 1920×1080"。关掉则只记状态、不动选择。
	 */
	followManualResize: true,
	/**
	 * 启动后首次「轮询式恢复」的延迟（毫秒）。
	 * 这是 `restoreEarly` 关闭、或提前恢复失败时的兜底路径，与旧行为一致。
	 */
	restoreDelayMs: 3000,
	/**
	 * 提前恢复（默认开启）：`apply` 那一刻就起一个常驻 Win32 代理进程，在进程内
	 * 反复枚举窗口；一旦主窗口被创建（此刻它还是隐藏的 —— Electron 要等页面
	 * `loadURL` 完成才 `show()`），立刻 `SetWindowPos`。
	 * 于是窗口"第一次出现在屏幕上"就已经是上次的尺寸，启动动画不会播错尺寸。
	 * 关掉它即退回 `restoreDelayMs` 的旧路径。
	 */
	restoreEarly: true,
	/** 提前恢复时，代理进程内两次枚举之间的间隔（毫秒）。 */
	earlyPollMs: 40,
	/** 提前恢复的总预算（毫秒）；到点还没等到窗口就放弃，交给 restoreDelayMs 兜底。 */
	earlyBudgetMs: 10000,
	/**
	 * 提前恢复认"主窗口"的最小外框面积（物理像素²）。
	 * 主窗口在 `createWindow` 里恒为 1280×820 = 1,049,600；欢迎窗 600×700 = 420,000、
	 * 登录窗 720×760 = 547,200 都在其下，所以这条能把它们挡掉 —— 隐藏期标题还
	 * 没变成产品名，提前阶段不能按标题认窗。
	 */
	earlyMinArea: 900000,
	/**
	 * Win32 走哪条路："auto"（默认）= 先试本机现编的助手 exe，不行再退 `powershell.exe`；
	 * "powershell" = 只用老路子（不编译、不落 exe）；"helper" = 只用助手 exe，起不来就当没有
	 * 提前恢复（兜底轮询也随之失败，排障时才这么写）。exe 与它的 C# 源码放在状态文件同目录，
	 * 文件名带源码摘要 —— 源码变了旧缓存自动作废，不需要谁去清。
	 */
	win32Backend: "auto",
	/** 恢复尺寸下限（对齐 Electron 主窗口 minWidth/minHeight）。 */
	minW: 520,
	minH: 600,
	/** 恢复尺寸上限（防状态文件损坏/异常值）。 */
	maxW: 7680,
	maxH: 4320,
	/** 状态文件路径；空串 = 默认 ~/.dsh/storages/window-size-keeper/state.json。 */
	stateFile: "",
	/** 恢复时是否把窗口居中到主屏工作区（默认开启）。 */
	centerOnRestore: true,
	/**
	 * 设置页文案语言："auto" = 跟随 DSH 客户端当前语言（设置 → 通用 → 语言）；
	 * 客户端运行时不提供语言服务时，退到浏览器语言判定，且**只有简体中文**走中文、
	 * 其余（含 zh-TW/zh-Hant）一律英文；要钉死就写 "zh" 或 "en"。
	 * "auto" 下切语言立即生效，不需要重启桌面端。
	 */
	language: "auto",
	/**
	 * 常用分辨率预选项：恢复时可任选其一（覆盖"上次尺寸"）。
	 * 顺序即设置页里的显示顺序（小 → 大）；label 用「宽×高（别名）」统一形状。
	 * `labelEn` 是同一形状的英文别名——设置页按当前语言挑一份显示。
	 * 要增删就在 patch config 里整体覆盖 `presets`（每项 { id, label, labelEn?, width, height }；
	 * 没给 `labelEn` 的项在英文环境下原样显示 `label`，绝不机器翻译用户自己写的别名）。
	 */
	presets: [
		{ id: "1024x768", label: "1024×768（XGA）", labelEn: "1024×768 (XGA)", width: 1024, height: 768 },
		{ id: "1280x720", label: "1280×720（HD）", labelEn: "1280×720 (HD)", width: 1280, height: 720 },
		{ id: "1366x768", label: "1366×768（HD+）", labelEn: "1366×768 (HD+)", width: 1366, height: 768 },
		{ id: "1440x900", label: "1440×900（WXGA）", labelEn: "1440×900 (WXGA)", width: 1440, height: 900 },
		{ id: "1536x864", label: "1536×864（1920 在 125% 缩放下的等效尺寸）", labelEn: "1536×864 (Equivalent of 1920 at 125% scaling)", width: 1536, height: 864 },
		{ id: "1600x900", label: "1600×900（HD+）", labelEn: "1600×900 (HD+)", width: 1600, height: 900 },
		{ id: "1920x1080", label: "1920×1080（Full HD）", labelEn: "1920×1080 (Full HD)", width: 1920, height: 1080 },
		{ id: "1920x1200", label: "1920×1200（WUXGA）", labelEn: "1920×1200 (WUXGA)", width: 1920, height: 1200 },
		{ id: "2560x1080", label: "2560×1080（Ultrawide）", labelEn: "2560×1080 (Ultrawide)", width: 2560, height: 1080 },
		{ id: "2560x1440", label: "2560×1440（QHD）", labelEn: "2560×1440 (QHD)", width: 2560, height: 1440 },
		{ id: "3440x1440", label: "3440×1440（Ultrawide QHD）", labelEn: "3440×1440 (Ultrawide QHD)", width: 3440, height: 1440 },
		{ id: "3840x2160", label: "3840×2160（4K UHD）", labelEn: "3840×2160 (4K UHD)", width: 3840, height: 2160 }
	],
	/** 当前选中的预选项 id；空串 = 用"上次尺寸"（默认）；"custom" = 用设置页里的自定义宽高。 */
	preset: ""
};

/** 自定义宽高的哨兵 id（设置页的「自定义…」选项）。 */
const CUSTOM_PRESET_ID = "custom";

/**
 * 语言口径归一：只认 "auto" / 强制中文 / 强制英文 三类，其它写法一律退回 "auto"。
 * 注意 `zh-TW`、`zh-Hant` **不算**强制中文（那是繁体，不是简体中文），它们退回 "auto"，
 * 由客户端按"只有简体中文走中文"的规则判成英文。写错配置不会让设置页哑掉，只会退回自动。
 * @param value 配置里的 `language` 原值
 * @returns "auto" | "zh" | "en"
 */
function normalizeLanguageChoice(value) {
	const v = String(value ?? "auto").trim().toLowerCase().replace(/_/g, "-");
	if (v === "en" || v.startsWith("en-")) return "en";
	if (v === "zh" || v === "zh-cn" || v === "zh-sg" || v === "zh-my" || v.startsWith("zh-hans")) return "zh";
	return "auto";
}

/** 设置页用的 HTTP 路由前缀（与 @dsh-pet/bridge、dsh-super-injector 同一套做法）。 */
const API_PREFIX = "/window-size-keeper/api";

const PRODUCT_TITLE = "DeepSeek Harness";
const MAIN_WINDOW_CLASS = "Chrome_WidgetWin_1";
const PS_TIMEOUT_MS = 8000;
// 助手 exe 的两笔一次性开销：现场编译（每个使用者本机只付一次，之后命中缓存）与
// "这 exe 真能起来、真能答"的握手探针。exe 起进程本身约 90ms，所以上限都给得很宽。
const HELPER_COMPILE_TIMEOUT_MS = 20000;
const HELPER_PROBE_TIMEOUT_MS = 8000;
// SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE —— 只改大小，不动位置/层级/焦点
const SWP_SIZE_ONLY = 0x0016;
// SWP_NOZORDER | SWP_NOACTIVATE —— 同时改位置与大小（恢复时居中用）
const SWP_MOVE_SIZE = 0x0014;

// ---------- 状态文件 ----------

function resolveStateFile(cfg) {
	if (cfg.stateFile && typeof cfg.stateFile === "string") return cfg.stateFile;
	return path.join(os.homedir(), ".dsh", "storages", "window-size-keeper", "state.json");
}

function readState(file) {
	try {
		const obj = JSON.parse(fs.readFileSync(file, "utf8"));
		if (obj && Number.isInteger(obj.width) && Number.isInteger(obj.height) && obj.width > 0 && obj.height > 0) {
			return obj;
		}
	} catch {
		/* 文件不存在或损坏 → 视为无历史 */
	}
	return null;
}

function writeState(file, rect) {
	try {
		const dir = path.dirname(file);
		fs.mkdirSync(dir, { recursive: true });
		const payload = {
			version: 1,
			width: rect.width,
			height: rect.height,
			x: rect.x,
			y: rect.y,
			savedAt: new Date().toISOString()
		};
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
		fs.renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

// ---------- 设置文件（设置页写入；与状态文件同目录） ----------

/** 设置文件路径：与状态文件同目录的 settings.json。 */
function resolveSettingsFile(cfg) {
	return path.join(path.dirname(resolveStateFile(cfg)), "settings.json");
}

/** 自定义宽高：只接受正整数，其余一律视为"没有自定义"。 */
function normalizeCustom(raw) {
	if (!raw || typeof raw !== "object") return null;
	const width = Math.round(Number(raw.width));
	const height = Math.round(Number(raw.height));
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return { width, height };
}

/** 读设置文件；不存在/损坏 → 空对象（一切按 patch config 与默认值走）。 */
function readSettings(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const out = {};
		if (typeof raw?.preset === "string") out.preset = raw.preset.trim();
		if (typeof raw?.centerOnRestore === "boolean") out.centerOnRestore = raw.centerOnRestore;
		const custom = normalizeCustom(raw?.custom);
		if (custom) out.custom = custom;
		if (typeof raw?.updatedAt === "string") out.updatedAt = raw.updatedAt;
		return out;
	} catch {
		return {};
	}
}

/**
 * 写设置文件：**原子写**（临时文件 + rename），并保留未在本模块声明的键。
 * 与 @dsh-pet/bridge 的 sync-settings.json 同一教训——两个写入方并发裸写会互相
 * 读到半写文件 → JSON.parse 失败 → 静默回落默认值。
 */
function writeSettings(file, patch) {
	const next = { version: 1, ...readSettings(file), ...(patch ?? {}), updatedAt: new Date().toISOString() };
	if (next.preset === undefined) delete next.preset;
	if (next.custom === null) delete next.custom;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		fs.renameSync(tmp, file);
	} catch {
		/* 写盘失败：本次仍按内存里的值返回，不中断设置页交互 */
	}
	return next;
}

/**
 * 解析"目标尺寸"：设置页选择优先于 patch config。
 * 返回 { width, height, source } 或 null（null = 用"上次尺寸"）。
 */
function resolveTargetSize(cfg, settings, presets) {
	const id = (settings && typeof settings.preset === "string" && settings.preset)
		? settings.preset
		: String(cfg.preset ?? "").trim();
	if (id === CUSTOM_PRESET_ID) {
		const custom = normalizeCustom(settings && settings.custom);
		if (custom) return { width: custom.width, height: custom.height, source: "custom" };
		// 选了「自定义」但还没填过有效宽高 → 不猜尺寸，退回"上次尺寸"。
		return null;
	}
	const preset = findPreset(presets, id);
	if (preset) return { width: preset.width, height: preset.height, source: `preset:${preset.id}` };
	return null;
}

/**
 * 纯函数：由「当前矩形 + 目标尺寸 + 主屏工作区 + 是否居中 + 上下限」算出要 SetWindowPos 的矩形。
 * 目标尺寸为 null 时保持当前尺寸（只可能挪位置）；窗口比工作区大时贴工作区左上角。
 * 导出给离线自检直接调用（不碰 Win32）。
 */
function computeRestoreRect(cur, target, workArea, center, limits) {
	const lo = { w: limits.minW, h: limits.minH, maxW: limits.maxW, maxH: limits.maxH };
	const waL = workArea ? Number(workArea.L) : 0;
	const waT = workArea ? Number(workArea.T) : 0;
	const waW = workArea ? Number(workArea.R) - Number(workArea.L) : lo.maxW;
	const waH = workArea ? Number(workArea.B) - Number(workArea.T) : lo.maxH;
	const wantW = target ? target.width : cur.width;
	const wantH = target ? target.height : cur.height;
	const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(Number(v) || 0)));
	const width = clamp(wantW, lo.w, Math.min(lo.maxW, waW));
	const height = clamp(wantH, lo.h, Math.min(lo.maxH, waH));
	let x = cur.x;
	let y = cur.y;
	if (center && workArea) {
		x = Math.round(waL + Math.max(0, (waW - width) / 2));
		y = Math.round(waT + Math.max(0, (waH - height) / 2));
	}
	return { width, height, x, y };
}

/** 校验设置页 POST /select 的请求体 → 可直接写盘的 patch；非法项被丢弃并回报原因。 */
function normalizeSelectBody(body, cfg, presets, currentSettings) {
	const patch = {};
	// notes 给人读（中文，宿主日志与旧客户端回退用）；noteCodes 给界面读（机器码 + 参数），
	// 由客户端按当前语言渲染——"界面说什么话"是客户端的事，宿主只管数据与原因码。
	const notes = [];
	const noteCodes = [];
	const pushNote = (code, params, text) => {
		noteCodes.push({ code, params: params || {} });
		notes.push(text);
	};
	const raw = body && typeof body === "object" ? body : {};
	if (raw.preset !== undefined) {
		const id = typeof raw.preset === "string" ? raw.preset.trim() : "";
		if (id === "" || id === CUSTOM_PRESET_ID || findPreset(presets, id)) patch.preset = id;
		else pushNote("unknown_preset", { id }, `未知的 preset id：${id}`);
	}
	if (raw.custom !== undefined) {
		const custom = normalizeCustom(raw.custom);
		if (custom) {
			const w = Math.max(cfg.minW, Math.min(cfg.maxW, custom.width));
			const h = Math.max(cfg.minH, Math.min(cfg.maxH, custom.height));
			patch.custom = { width: w, height: h };
			if (w !== custom.width || h !== custom.height) pushNote("custom_clamped", { w, h, minW: cfg.minW, minH: cfg.minH, maxW: cfg.maxW, maxH: cfg.maxH }, `自定义宽高已夹取到 ${w}×${h}（上下限 ${cfg.minW}×${cfg.minH} – ${cfg.maxW}×${cfg.maxH}）`);
		} else if (raw.custom === null) patch.custom = null;
		else pushNote("custom_not_positive", {}, "自定义宽高不是正整数，已忽略");
	}
	if (raw.centerOnRestore !== undefined) patch.centerOnRestore = Boolean(raw.centerOnRestore);
	// 选了「自定义」却没填过有效宽高 → 明确拒绝，否则用户会以为已经生效（实际退回上次尺寸）。
	const pendingPreset = patch.preset !== undefined ? patch.preset : String(currentSettings.preset ?? "");
	if (pendingPreset === CUSTOM_PRESET_ID) {
		const custom = patch.custom !== undefined ? patch.custom : (currentSettings.custom ?? null);
		if (!custom) {
			delete patch.preset;
			pushNote("custom_pending", {}, "自定义尺寸还没有有效宽高，已保持原选择不变");
		}
	}
	return { patch, notes, noteCodes };
}

// ---------- 代数（热重载僵尸防护） ----------

function readGen(file) {
	try {
		const n = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

function bumpGen(file) {
	const n = readGen(file) + 1;
	try {
		fs.writeFileSync(file, String(n));
	} catch {
		/* 写失败退回内存代数：仅本机单进程使用，无并发写者 */
	}
	return n;
}

// ---------- PowerShell / Win32 ----------

const CSHARP_HELPER = [
	"using System;",
	"using System.Text;",
	"using System.Runtime.InteropServices;",
	"public static class WskWin {",
	"  [StructLayout(LayoutKind.Sequential)]",
	"  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
	"  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
	"  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
	"  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
	"  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
	"  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);",
	"  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);",
	"  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);",
	"  [DllImport(\"user32.dll\")] public static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, out RECT pvParam, uint fWinIni);",
	"}"
].join("\n");

/** 枚举所有可见顶层窗口 + 主屏工作区，输出 JSON。 */
function buildGetScript() {
	return [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"Add-Type -TypeDefinition @'",
		CSHARP_HELPER,
		"'@",
		"$found = New-Object System.Collections.ArrayList",
		"$cb = [WskWin+EnumWindowsProc]{ param($h, $l)",
		"  $procId = 0",
		"  [void][WskWin]::GetWindowThreadProcessId($h, [ref]$procId)",
		"  if ([WskWin]::IsWindowVisible($h)) {",
		"    $r = New-Object WskWin+RECT",
		"    [void][WskWin]::GetWindowRect($h, [ref]$r)",
		"    $t = New-Object System.Text.StringBuilder 512",
		"    [void][WskWin]::GetWindowTextW($h, $t, 512)",
		"    $c = New-Object System.Text.StringBuilder 256",
		"    [void][WskWin]::GetClassNameW($h, $c, 256)",
		"    [void]$found.Add([pscustomobject]@{ H = ([long]$h).ToString(); Pid = [int]$procId; Class = $c.ToString(); Title = $t.ToString(); L = $r.Left; T = $r.Top; R = $r.Right; B = $r.Bottom })",
		"  }",
		"  return $true",
		"}",
		"[void][WskWin]::EnumWindows($cb, [IntPtr]::Zero)",
		"$wa = New-Object WskWin+RECT",
		"[void][WskWin]::SystemParametersInfoW(48, 0, [ref]$wa, 0)",
		"@{ Windows = $found; WorkArea = @{ L = $wa.Left; T = $wa.Top; R = $wa.Right; B = $wa.Bottom } } | ConvertTo-Json -Compress -Depth 6"
	].join("\n");
}

/** 改窗口位置与大小（hwnd/x/y/width/height 均为已校验整数，直接内联，无注入面）。 */
function buildSetScript(hwnd, x, y, width, height) {
	return [
		"Add-Type -TypeDefinition @'",
		"using System;",
		"using System.Runtime.InteropServices;",
		"public static class WskWin {",
		"  [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);",
		"}",
		"'@",
		"$ok = [WskWin]::SetWindowPos([IntPtr]" + hwnd + ", [IntPtr]::Zero, " + x + ", " + y + ", " + width + ", " + height + ", " + SWP_MOVE_SIZE + ")",
		"if ($ok) { 'OK' } else { 'FAIL' }"
	].join("\n");
}

function runPs(script) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let child;
		try {
			child = execFile(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
				{ windowsHide: true, timeout: PS_TIMEOUT_MS },
				(err, stdout) => {
					if (err) {
						done({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
						return;
					}
					done({ ok: true, out: String(stdout).trim() });
				}
			);
		} catch (e) {
			done({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
			return;
		}
		if (child && typeof child.on === "function") {
			child.on("error", (e) => done({ ok: false, error: String((e && e.message) || e).slice(0, 300) }));
		}
	});
}

// ---------- Win32 助手：本机现场编译的小 exe（powershell 是兜底） ----------

/**
 * 助手的 C# 源码。它是同一只机械臂的第三种壳：
 *   `--protocol`       只答一行握手串，用来验证"这 exe 真能起来、真能答"
 *   `--get`            输出一行 JSON：可见顶层窗口 + 主屏工作区（与 `buildGetScript()` 同形状）
 *   `--set …`          SetWindowPos，输出 `OK` / `FAIL`（与 `buildSetScript()` 同形状，永远退出码 0）
 *   不带参数           常驻，按 `ENUM` / `WA` / `SET …` / `EXIT` 一行一条应答（与 `AGENT_SCRIPT` 同协议）
 *
 * 为什么要有它：`powershell.exe` 起进程实测约 0.8s，`Add-Type` 现场编译再加约 0.45s，
 * 首次动手总共约 1.3s —— 而桌面端从主进程起来到 `window.show()` 只有 2~3s，提前恢复抢的就是
 * 这段窗口的毫秒。同一个 P/Invoke 编译成 exe 之后起进程约 90ms。
 *
 * 红线：不往包里放任何二进制。这段源码随包可见，用它本机 `csc.exe` 现编，产物缓存在使用者
 * 自己的存储目录里，旁边留同一份 `.cs` 供人核对。
 */
const AGENT_CSHARP_TEMPLATE = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WskAgent
{
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, out RECT pvParam, uint fWinIni);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  const uint SPI_GETWORKAREA = 48;
  const string PROTOCOL = "wsk-agent-1";

  static EnumWindowsProc callback;
  static List<string> parts;
  static string mainClass = "__WSK_MAIN_CLASS__";
  static bool wantClassFilter;
  static bool wantVisibleOnly;

  static void TryDpiAware()
  {
    // PerMonitorV2 = (IntPtr)(-4)。老系统上这个入口点不存在，退到 SetProcessDPIAware。
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  static string Esc(string s)
  {
    if (s == null) return "";
    StringBuilder b = new StringBuilder(s.Length + 8);
    for (int i = 0; i < s.Length; i++)
    {
      char c = s[i];
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c == '\b') b.Append("\\b");
      else if (c == '\f') b.Append("\\f");
      else if (c == '\n') b.Append("\\n");
      else if (c == '\r') b.Append("\\r");
      else if (c == '\t') b.Append("\\t");
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }

  static string Wa()
  {
    RECT wa = new RECT();
    SystemParametersInfoW(SPI_GETWORKAREA, 0, out wa, 0);
    return "\"L\":" + wa.Left + ",\"T\":" + wa.Top + ",\"R\":" + wa.Right + ",\"B\":" + wa.Bottom;
  }

  static bool Collect(IntPtr h, IntPtr l)
  {
    if (wantVisibleOnly && !IsWindowVisible(h)) return true;
    RECT r = new RECT();
    if (!GetWindowRect(h, out r)) return true;
    StringBuilder c = new StringBuilder(256);
    GetClassNameW(h, c, 256);
    string cls = c.ToString();
    if (wantClassFilter && cls != mainClass) return true;
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    StringBuilder t = new StringBuilder(512);
    GetWindowTextW(h, t, 512);
    parts.Add("{\"H\":\"" + h.ToInt64().ToString() + "\",\"Pid\":" + pid + ",\"Class\":\"" + Esc(cls)
      + "\",\"Title\":\"" + Esc(t.ToString()) + "\",\"L\":" + r.Left + ",\"T\":" + r.Top
      + ",\"R\":" + r.Right + ",\"B\":" + r.Bottom + "}");
    return true;
  }

  static string EnumJson(bool classFilter, bool visibleOnly, bool withWorkArea, string cmd)
  {
    wantClassFilter = classFilter;
    wantVisibleOnly = visibleOnly;
    parts = new List<string>();
    callback = new EnumWindowsProc(Collect);
    EnumWindows(callback, IntPtr.Zero);
    string joined = string.Join(",", parts.ToArray());
    callback = null;
    parts = null;
    string head = cmd == null ? "{\"Windows\":[" : "{\"ok\":true,\"cmd\":\"" + cmd + "\",\"Windows\":[";
    string tail = withWorkArea ? ",\"WorkArea\":{" + Wa() + "}" : "";
    return head + joined + "]" + tail + "}";
  }

  static bool SetFrom(string[] a)
  {
    if (a.Length < 6) return false;
    try
    {
      uint flags = a.Length >= 7 ? uint.Parse(a[6]) : 20u;
      return SetWindowPos(new IntPtr(long.Parse(a[0])), IntPtr.Zero,
        int.Parse(a[1]), int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), flags);
    }
    catch { return false; }
  }

  public static int Main(string[] args)
  {
    TryDpiAware();
    try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
    if (args != null && args.Length > 0)
    {
      if (args[0] == "--protocol") { Console.Out.WriteLine(PROTOCOL); Console.Out.Flush(); return 0; }
      if (args[0] == "--get") { Console.Out.WriteLine(EnumJson(false, true, true, null)); Console.Out.Flush(); return 0; }
      if (args[0] == "--set")
      {
        string[] a = new string[args.Length - 1];
        for (int i = 1; i < args.Length; i++) a[i - 1] = args[i];
        Console.Out.WriteLine(SetFrom(a) ? "OK" : "FAIL");
        Console.Out.Flush();
        return 0;
      }
    }
    while (true)
    {
      string line = Console.In.ReadLine();
      if (line == null) break;
      line = line.Trim();
      if (line.Length == 0) continue;
      if (line == "EXIT") break;
      if (line == "ENUM") { Console.Out.WriteLine(EnumJson(true, false, false, "ENUM")); continue; }
      if (line == "WA") { Console.Out.WriteLine("{\"ok\":true,\"cmd\":\"WA\"," + Wa() + "}"); continue; }
      if (line.StartsWith("SET "))
      {
        Console.Out.WriteLine(SetFrom(line.Substring(4).Trim().Split(' ')) ? "{\"ok\":true,\"cmd\":\"SET\"}" : "{\"ok\":false,\"cmd\":\"SET\"}");
        continue;
      }
      Console.Out.WriteLine("{\"ok\":false}");
    }
    return 0;
  }
}`;

/** 把主窗口类名内联进助手源码（类名是插件内部常量，不是外部输入）。 */
function buildAgentCSharp(mainClass) {
	return AGENT_CSHARP_TEMPLATE.replace("__WSK_MAIN_CLASS__", String(mainClass));
}

/**
 * 纯函数：归一 `win32Backend`。只认 "auto" / "powershell" / "helper"，写错一律退回 "auto"，
 * 免得一个拼写错误让插件既不编译也不轮询。
 */
function normalizeWin32Backend(value) {
	const v = String(value ?? "auto").trim().toLowerCase();
	if (v === "powershell" || v === "ps") return "powershell";
	if (v === "helper" || v === "exe") return "helper";
	return "auto";
}

/**
 * 纯函数：助手 exe 的缓存名带源码摘要 —— 源码一改文件名就变，旧缓存自然作废，
 * 不需要版本号，也不需要谁去清；同时两个不同版本的插件不会互相覆盖对方的助手。
 */
function helperExeName(source) {
	return `wsk-agent-${crypto.createHash("sha256").update(String(source)).digest("hex").slice(0, 16)}.exe`;
}

/** 助手放在状态文件同目录（`stateFile` 指到哪就放到哪），旁边留同名 `.cs` 供人核对。 */
function resolveHelperPaths(cfg, stateFile) {
	const dir = path.dirname(stateFile);
	const exe = path.join(dir, helperExeName(buildAgentCSharp(MAIN_WINDOW_CLASS)));
	return { dir, exe, cs: exe.replace(/\.exe$/u, ".cs") };
}

/**
 * 纯函数：只认**系统自带**的 .NET Framework 编译器（64 位优先），不搜 PATH、不认第三方工具链。
 * 找不到就返回 null —— 那时插件整体退回 powershell 路径，行为与 0.1.2 及以前完全一致。
 */
function findCsc(env, exists) {
	const root = env.SystemRoot || env.windir || env.WINDIR || "";
	if (!root) return null;
	const candidates = [
		path.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
		path.join(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
	];
	for (const candidate of candidates) {
		try {
			if (exists(candidate)) return candidate;
		} catch { /* 探测失败只算"没有" */ }
	}
	return null;
}

/** 起一次助手 exe 的一次性调用（与 `runPs` 同契约：`{ ok, out }`）。 */
function runHelper(exe, args, timeoutMs = PS_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let child;
		try {
			child = execFile(exe, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
				if (err) {
					done({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
					return;
				}
				done({ ok: true, out: String(stdout).trim() });
			});
		} catch (e) {
			done({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
			return;
		}
		if (child && typeof child.on === "function") {
			child.on("error", (e) => done({ ok: false, error: String((e && e.message) || e).slice(0, 300) }));
		}
	});
}

/**
 * 用 csc 把助手编出来：先写到同目录的临时名，再改名落到最终名 —— 免得半截 exe 被当成缓存。
 * 成功返回 exe 路径，任何一步失败返回 null（调用方退回 powershell）。
 */
function compileHelperExe({ csc, source, csPath, exePath, timeoutMs = HELPER_COMPILE_TIMEOUT_MS }) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const tmpExe = `${exePath}.tmp-${process.pid}`;
		const discard = () => {
			try { fs.unlinkSync(tmpExe); } catch { /* 没写出来，或已经被改名拿走 */ }
		};
		try {
			fs.mkdirSync(path.dirname(csPath), { recursive: true });
			fs.writeFileSync(csPath, source, "utf8");
		} catch {
			done(null);
			return;
		}
		let child;
		try {
			child = execFile(
				csc,
				["/nologo", "/target:exe", "/platform:anycpu", "/optimize", `/out:${tmpExe}`, csPath],
				{ windowsHide: true, timeout: timeoutMs },
				(err) => {
					if (err) {
						discard();
						done(null);
						return;
					}
					try {
						if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
						fs.renameSync(tmpExe, exePath);
						done(exePath);
					} catch {
						discard();
						done(null);
					}
				}
			);
		} catch {
			done(null);
			return;
		}
		if (child && typeof child.on === "function") child.on("error", () => { discard(); done(null); });
	});
}

// 每个宿主进程只编一次；结果（含"编不出来"）都记住，不反复付编译的钱。
let helperMemo = null;

/**
 * 拿到可用的助手 exe 路径：命中缓存直接返回；否则现编，并**跑一次 `--protocol` 确认它真能起、
 * 真能答**（杀软拦下新写的 exe 时这一步会失败，于是整体退回 powershell）。
 */
async function ensureHelperExe(paths, source) {
	if (helperMemo && helperMemo.key === paths.exe) return helperMemo.exe;
	let exe = null;
	try {
		if (fs.existsSync(paths.exe) && fs.statSync(paths.exe).size > 1024) exe = paths.exe;
	} catch { /* 读不到就当没有 */ }
	if (!exe) {
		const csc = findCsc(process.env, (p) => fs.existsSync(p));
		if (csc) exe = await compileHelperExe({ csc, source, csPath: paths.cs, exePath: paths.exe });
	}
	if (exe) {
		const probe = await runHelper(exe, ["--protocol"], HELPER_PROBE_TIMEOUT_MS);
		if (!probe.ok || probe.out !== "wsk-agent-1") exe = null;
	}
	helperMemo = { key: paths.exe, exe };
	return exe;
}

// ---------- 常驻 Win32 代理（提前恢复用） ----------

/**
 * 代理进程的指令脚本：它**只做 Win32，不做任何判断**。
 *
 * 协议是「一行一条」：Node 写 `ENUM` / `WA` / `SET <hwnd> <x> <y> <w> <h> <flags>` / `EXIT`，
 * 代理回一行 JSON。挑窗口、夹取、居中的判断全部留在 Node 侧的纯函数里，所以它们能被
 * `scripts/selftest.mjs` 离线验到；代理只是一个可以被随时杀掉的机械臂。
 *
 * 为什么要常驻：兜底的 `powershell.exe -NoProfile` 起进程实测约 0.8s、`Add-Type` 现场编译再加
 * 约 0.45s（首轮动手合计约 1.3s），而现场编译出来的助手 exe 起进程只要约 90ms。不管哪条路，
 * 都只在 `apply` 时付一次起进程的钱，之后进程内枚举一次只要几毫秒，可以 40ms 一轮地盯。
 */
const AGENT_SCRIPT = [
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
	"$ErrorActionPreference = 'Continue'",
	"Add-Type -TypeDefinition @'",
	"using System;",
	"using System.Text;",
	"using System.Runtime.InteropServices;",
	"public static class WskAgent {",
	"  [StructLayout(LayoutKind.Sequential)]",
	"  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
	"  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
	"  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
	"  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
	"  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);",
	"  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);",
	"  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);",
	"  [DllImport(\"user32.dll\")] public static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, out RECT pvParam, uint fWinIni);",
	"  [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);",
	"}",
	"'@",
	"$cls = '" + MAIN_WINDOW_CLASS + "'",
	"while ($true) {",
	"  $line = [Console]::In.ReadLine()",
	"  if ($null -eq $line) { break }",
	"  $line = $line.Trim()",
	"  if ($line -eq '') { continue }",
	"  if ($line -eq 'EXIT') { break }",
	"  if ($line -eq 'ENUM') {",
	"    $found = New-Object System.Collections.ArrayList",
	"    $cb = [WskAgent+EnumWindowsProc]{ param($h, $l)",
	"      $procId = 0",
	"      [void][WskAgent]::GetWindowThreadProcessId($h, [ref]$procId)",
	"      $c = New-Object System.Text.StringBuilder 256",
	"      [void][WskAgent]::GetClassNameW($h, $c, 256)",
	"      if ($c.ToString() -eq $cls) {",
	"        $r = New-Object WskAgent+RECT",
	"        [void][WskAgent]::GetWindowRect($h, [ref]$r)",
	"        $t = New-Object System.Text.StringBuilder 512",
	"        [void][WskAgent]::GetWindowTextW($h, $t, 512)",
	"        [void]$found.Add([pscustomobject]@{ H = ([long]$h).ToString(); Pid = [int]$procId; Class = $c.ToString(); Title = $t.ToString(); L = $r.Left; T = $r.Top; R = $r.Right; B = $r.Bottom })",
	"      }",
	"      return $true",
	"    }",
	"    [void][WskAgent]::EnumWindows($cb, [IntPtr]::Zero)",
	"    [Console]::Out.WriteLine((@{ ok = $true; cmd = 'ENUM'; Windows = $found } | ConvertTo-Json -Compress -Depth 6))",
	"    continue",
	"  }",
	"  if ($line -eq 'WA') {",
	"    $wa = New-Object WskAgent+RECT",
	"    [void][WskAgent]::SystemParametersInfoW(48, 0, [ref]$wa, 0)",
	"    [Console]::Out.WriteLine((@{ ok = $true; cmd = 'WA'; L = $wa.Left; T = $wa.Top; R = $wa.Right; B = $wa.Bottom } | ConvertTo-Json -Compress -Depth 3))",
	"    continue",
	"  }",
	"  if ($line.StartsWith('SET ')) {",
	"    $a = $line.Substring(4).Split(' ')",
	"    if ($a.Count -ge 6) {",
	"      $ok = [WskAgent]::SetWindowPos([IntPtr]([long]$a[0]), [IntPtr]::Zero, [int]$a[1], [int]$a[2], [int]$a[3], [int]$a[4], [uint32]$a[5])",
	"      if ($ok) { [Console]::Out.WriteLine('{\"ok\":true,\"cmd\":\"SET\"}') } else { [Console]::Out.WriteLine('{\"ok\":false,\"cmd\":\"SET\"}') }",
	"    } else {",
	"      [Console]::Out.WriteLine('{\"ok\":false,\"cmd\":\"SET\"}')",
	"    }",
	"    continue",
	"  }",
	"  [Console]::Out.WriteLine('{\"ok\":false}')",
	"}"
].join("\n");

/**
 * 起一个常驻 Win32 代理进程（机械臂）。`command`/`args` 由调用方给，所以同一套 FIFO 行协议
 * 既服务现场编译的助手 exe，也服务兜底的 powershell。起不来返回 null。
 *
 * 请求严格串行：调用方每次都 `await` 完再发下一条，所以应答与请求是一一对应的 FIFO，
 * 不需要给请求编号。任何一条失败都不会抛出到调用方之外 —— 这个代理是可选加速器，
 * 它坏了就等于没有它（旧路径照跑）。
 */
function spawnLineAgent(command, args, backend, agentTimeoutMs = PS_TIMEOUT_MS) {
	let child;
	try {
		child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
	} catch {
		return null;
	}
	if (!child || !child.stdout || !child.stdin) return null;

	let closed = false;
	let buffer = "";
	const pending = [];
	const settle = (value) => {
		const wait = pending.shift();
		if (wait) wait.resolve(value);
	};
	const failAll = () => {
		closed = true;
		while (pending.length > 0) pending.shift().resolve({ ok: false });
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
			if (!line) continue;
			let data = null;
			try {
				data = JSON.parse(line);
			} catch {
				continue; // 代理的杂输出（警告之类）直接丢掉，不干扰协议
			}
			if (data && Array.isArray(data.Windows) === false && data.cmd === "ENUM" && data.Windows) data.Windows = [data.Windows];
			settle(data ?? { ok: false });
		}
	});
	child.on("error", failAll);
	child.on("exit", failAll);
	// 管道上的错误（子进程被杀软当场杀掉、句柄已断）必须就地接掉：stream 上的 'error' 没人听
	// 会把宿主进程整个带崩 —— 这个代理是可选加速器，它的坏不许影响宿主一根毛。
	if (child.stdin && typeof child.stdin.on === "function") child.stdin.on("error", failAll);
	if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("error", failAll);

	const request = (line, timeoutMs = agentTimeoutMs) => new Promise((resolve) => {
		if (closed) { resolve({ ok: false }); return; }
		let settled = false;
		const entry = {
			resolve: (value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			}
		};
		const timer = setTimeout(() => {
			if (settled) return;
			const at = pending.indexOf(entry);
			if (at >= 0) pending.splice(at, 1);
			settled = true;
			resolve({ ok: false });
		}, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		pending.push(entry);
		try {
			child.stdin.write(`${line}\n`);
		} catch {
			entry.resolve({ ok: false });
		}
	});

	return {
		backend,
		enumWindows: () => request("ENUM"),
		workArea: () => request("WA"),
		setWindowPos: (hwnd, x, y, width, height, flags) => request(`SET ${hwnd} ${x} ${y} ${width} ${height} ${flags}`),
		close() {
			if (closed) return;
			try { child.stdin.write("EXIT\n"); } catch { /* 管道已断：下面直接杀 */ }
			closed = true;
			failAll();
			const kill = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 1500);
			if (typeof kill.unref === "function") kill.unref();
		},
		get alive() { return !closed; }
	};
}

/** 兜底路径：老规矩，起一个常驻 `powershell.exe` 代理。 */
function createWinAgent() {
	return spawnLineAgent(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", AGENT_SCRIPT],
		"powershell"
	);
}

/** 首选路径：起本机现编/已缓存的助手 exe（同一个行协议，超时更紧）。 */
function createHelperAgent(exePath) {
	return spawnLineAgent(exePath, [], "helper", HELPER_PROBE_TIMEOUT_MS);
}

/**
 * 起常驻代理：先试助手 exe，第一次 `ENUM` 答不上来就换 powershell，再不行返回 null。
 * 探针那一次枚举**直接当盯窗循环的第一轮用**，所以不白花。
 */
async function openWinAgent(helperExe) {
	if (helperExe) {
		const agent = createHelperAgent(helperExe);
		if (agent) {
			const got = await agent.enumWindows();
			if (got && got.ok && Array.isArray(got.Windows)) return { agent, backend: "helper", windows: got.Windows };
			try { agent.close(); } catch { /* 已经退出了 */ }
		}
	}
	const agent = createWinAgent();
	if (!agent) return null;
	const got = await agent.enumWindows();
	if (got && got.ok && Array.isArray(got.Windows)) return { agent, backend: "powershell", windows: got.Windows };
	try { agent.close(); } catch { /* 已经退出了 */ }
	return null;
}

// ---------- 主窗口识别 ----------

/** 窗口外框面积（物理像素²）；读不到数返回 0。 */
function windowArea(w) {
	if (!w || typeof w !== "object") return 0;
	const l = Number(w.L), t = Number(w.T), r = Number(w.R), b = Number(w.B);
	if (!Number.isFinite(l) || !Number.isFinite(t) || !Number.isFinite(r) || !Number.isFinite(b)) return 0;
	return (r - l) * (b - t);
}

/**
 * 纯函数：**提前恢复**阶段的主窗口识别。与 `pickMainWindow` 的关键区别是**不要求可见**。
 *
 * 主窗口创建时是隐藏的（`createWindow` 的 `show` 默认 false），Electron 要等
 * `loadURL` 完成才 `show()` —— 这段"已存在但还看不见"的时间正是"显示前就把尺寸改对"
 * 的窗口期。所以：
 *   ① 只认 `targetPid` 名下、`Chrome_WidgetWin_1` 类、正面积、且面积 >= `opts.minArea` 的候选；
 *   ② 恰好一个 → 用它；
 *   ③ 多个 → 取面积最大者，但必须比第二名大 1.5 倍以上，否则判为"分不清"返回 null（下一轮再看）。
 *
 * 隐藏期标题还没变成产品名（Electron 此时用的是应用名），所以这一阶段**不按标题认窗**，
 * 改用面积下限把欢迎窗（600×700）与登录窗（720×760）挡掉。
 */
function pickEarlyMainWindow(list, targetPid, opts = {}) {
	if (!Array.isArray(list)) return null;
	const minArea = Number(opts.minArea) > 0 ? Number(opts.minArea) : DEFAULTS.earlyMinArea;
	const cands = list.filter((w) => {
		if (!w || typeof w !== "object") return false;
		if (Number(w.Pid) !== targetPid) return false;
		if (w.Class != null && String(w.Class) !== MAIN_WINDOW_CLASS) return false;
		const area = windowArea(w);
		return area > 0 && area >= minArea;
	});
	if (cands.length === 0) return null;
	if (cands.length === 1) return cands[0];
	const sorted = [...cands].sort((a, b) => windowArea(b) - windowArea(a));
	const top = windowArea(sorted[0]);
	const second = windowArea(sorted[1]);
	return second > 0 && top >= second * 1.5 ? sorted[0] : null;
}

/**
 * 从窗口列表中挑出 DSH 桌面端主窗口。
 * 规则：宿主父进程（Electron 主进程）名下、Chrome_WidgetWin_1 类、可见、正面积；
 * 优先标题含产品名（排除欢迎/登录窗与 DevTools）；无标题命中时仅在候选唯一时采用；
 * 仍多个则取面积最大者（主窗口通常大于 DevTools）。
 */
function pickMainWindow(list, targetPid) {
	if (!Array.isArray(list)) return null;
	const cands = list.filter((w) => {
		if (!w || typeof w !== "object") return false;
		if (Number(w.Pid) !== targetPid) return false;
		if (String(w.Class) !== MAIN_WINDOW_CLASS) return false;
		const l = Number(w.L), t = Number(w.T), r = Number(w.R), b = Number(w.B);
		return Number.isFinite(l) && Number.isFinite(t) && Number.isFinite(r) && Number.isFinite(b) && r - l > 0 && b - t > 0;
	});
	if (cands.length === 0) return null;
	const titled = cands.filter((w) => String(w.Title || "").toLowerCase().includes(PRODUCT_TITLE.toLowerCase()));
	let pool;
	if (titled.length > 0) pool = titled;
	else if (cands.length === 1) pool = cands;
	else return null;
	if (pool.length === 1) return pool[0];
	let best = pool[0];
	let bestArea = -1;
	for (const w of pool) {
		const area = (Number(w.R) - Number(w.L)) * (Number(w.B) - Number(w.T));
		if (area > bestArea) {
			bestArea = area;
			best = w;
		}
	}
	return best;
}

/** 在预选项列表里找指定 id 的项；id 为空或找不到返回 null。 */
function findPreset(presets, id) {
	if (!Array.isArray(presets) || !id || typeof id !== "string") return null;
	for (const p of presets) {
		if (p && p.id === id && Number.isFinite(p.width) && Number.isFinite(p.height) && p.width > 0 && p.height > 0) {
			return p;
		}
	}
	return null;
}

/**
 * 纯函数：下一次采样排多久毫秒。本轮采到过变化就用快轮询；距最后一次变化满 tail 才退回待机节奏。
 * 两条节奏都夹下限，且快轮询不会比待机还慢（active > idle 时取 idle，免得配置写反把 CPU 烧起来）。
 * 离线自检直接调它（scripts/selftest.mjs 第 [1] 组之外的"节奏"那几条）。
 */
function nextSampleDelay(now, lastChangeAt, opts = {}) {
	// 三个键一律"正数才认，否则退回默认"，之后再夹各自下限：写 0 / 负数 / 垃圾都不许把节奏压成
	// 0 毫秒狂采样（采样一次要起一个 Win32 助手进程 —— 走兜底 PowerShell 时更是 1 秒往上 —— 狂采样会白烧 CPU）。
	const positive = (value, def) => {
		const n = Number(value);
		return Number.isFinite(n) && n > 0 ? n : def;
	};
	const idle = Math.max(1000, positive(opts.idleMs, DEFAULTS.saveIntervalMs));
	const active = Math.max(250, positive(opts.activeMs, DEFAULTS.activeSampleMs));
	const tail = Math.max(0, positive(opts.tailMs, DEFAULTS.activeTailMs));
	const changedRecently = Number.isFinite(lastChangeAt) && now - lastChangeAt < tail;
	return changedRecently ? Math.min(active, idle) : idle;
}

/**
 * 纯函数：这一轮采样要不要把「恢复尺寸」选择改成自定义。三条规则都在这里，好被离线逐条钉住：
 *   ① 插件自己刚改的那一次不算手动（吃掉标记）——否则启动恢复会把具名分辨率改成"自定义"；
 *   ② 只认宽高变化——只挪位置不动大小不算（custom 里存的本来就是宽高）；
 *   ③ 本代第一次采样没有基准，也谈不上手动。
 * 容差 2 px 与 applyRect 自己判断"已经是这个尺寸"用的那把尺一致，免得两边口径不同来回抖动。
 */
function shouldAdoptManualSize(prev, cur, selfApplied, opts = {}) {
	if (!cur || typeof cur !== "object") return { adopt: false, consumeSelfApplied: false };
	const applied = selfApplied && typeof selfApplied === "object" ? selfApplied : null;
	if (applied && Math.abs(cur.width - applied.width) <= 2 && Math.abs(cur.height - applied.height) <= 2) {
		return { adopt: false, consumeSelfApplied: true };
	}
	if (opts.followManualResize === false) return { adopt: false, consumeSelfApplied: false };
	if (!prev || typeof prev !== "object") return { adopt: false, consumeSelfApplied: false };
	if (Math.abs(cur.width - prev.width) <= 2 && Math.abs(cur.height - prev.height) <= 2) {
		return { adopt: false, consumeSelfApplied: false };
	}
	return { adopt: true, consumeSelfApplied: false };
}

// ---------- 插件入口 ----------

export function apply(ctx, config = {}) {
	const cfg = { ...DEFAULTS, ...(config && typeof config === "object" ? config : {}) };
	if (cfg.enabled === false) return;

	const isWin = process.platform === "win32";
	const targetPid = process.ppid;
	const file = resolveStateFile(cfg);
	const settingsFile = resolveSettingsFile(cfg);
	// 预选项列表：patch config 里的 `presets` 整体覆盖内置清单（设置页读的就是这一份）。
	const presets = Array.isArray(cfg.presets) ? cfg.presets : DEFAULTS.presets;
	// 代数：每次 apply 递增。热重载后旧 fiber 的定时器若未被清理（僵尸 cycle），
	// 其写入前发现代数已变即放弃，防止用陈旧尺寸覆盖状态文件。
	const genFile = file + ".gen";
	const myGen = bumpGen(genFile);
	const stale = () => readGen(genFile) !== myGen;
	let lastRect = null; // 最近一次已知外框矩形（退出兜底用）
	let lastSample = null; // 上一次采样到的矩形（判断"这一轮是不是变了"的基准）
	let lastChangeAt = 0; // 最近一次采到变化的时刻（决定下一次用快轮询还是待机节奏）
	let selfApplied = null; // 插件自己刚改成的矩形：那一次不算"用户手动
	let restored = false; // 本次启动是否已执行过恢复
	let earlyAgent = null; // 提前恢复用的常驻 Win32 代理（热重载/卸载时要杀掉）
	let busy = false; // 防止 PowerShell 调用重叠
	let stopped = false;

	// 串行化所有「读窗口 → 改窗口」操作：启动恢复 cycle 与设置页的「立即应用」
	// 可能同时触发，两条 PowerShell 并发改同一窗口会互相覆盖后写的那次。
	let chain = Promise.resolve();
	const serialize = (task) => {
		const run = chain.then(task, task);
		chain = run.then(() => undefined, () => undefined);
		return run;
	};

	const sleep = (ms) => new Promise((r) => {
		const t = setTimeout(r, ms);
		if (typeof t.unref === "function") t.unref();
	});

	/** 当前生效的「恢复时居中」：设置页（settings.json）优先于 patch config。 */
	const centerEnabled = () => {
		const s = readSettings(settingsFile);
		if (typeof s.centerOnRestore === "boolean") return s.centerOnRestore;
		return cfg.centerOnRestore !== false;
	};

	/** 一次 PowerShell 枚举：定位主窗口 + 主屏工作区。 */
	const helperPaths = resolveHelperPaths(cfg, file);
	const helperSource = buildAgentCSharp(MAIN_WINDOW_CLASS);
	/**
	 * 这一代的 Win32 走法：助手 exe（现编/缓存）优先，powershell 兜底。
	 * `broken` 一旦置上就不再赌 —— 本代剩下的调用全走 powershell，免得每次采样都先撞一次墙。
	 */
	const win32 = {
		backend: "powershell",
		exe: null,
		tried: false,
		broken: false,
		async path() {
			const mode = normalizeWin32Backend(cfg.win32Backend);
			if (mode === "powershell" || this.broken) return null;
			if (!this.tried) {
				this.tried = true;
				try {
					this.exe = await ensureHelperExe(helperPaths, helperSource);
				} catch {
					this.exe = null;
				}
				if (!this.exe && mode === "helper") this.broken = true;
			}
			return this.exe;
		},
		markBroken() {
			this.broken = true;
			this.backend = "powershell";
		}
	};

	/** 一次「枚举可见窗口 + 工作区」：先试助手，不中就退回老路子（契约与 buildGetScript 一致）。 */
	async function win32Get() {
		const exe = await win32.path();
		if (exe) {
			const got = await runHelper(exe, ["--get"]);
			if (got.ok && got.out) {
				win32.backend = "helper";
				return got;
			}
			win32.markBroken();
		}
		return runPs(buildGetScript());
	}

	/** 一次 SetWindowPos：先试助手，不中就退回老路子（契约与 buildSetScript 一致：`out === "OK"`）。 */
	async function win32Set(hwnd, x, y, width, height) {
		const exe = await win32.path();
		if (exe) {
			const got = await runHelper(exe, ["--set", String(hwnd), String(x), String(y), String(width), String(height), String(SWP_MOVE_SIZE)]);
			if (got.ok && (got.out === "OK" || got.out === "FAIL")) {
				win32.backend = "helper";
				return got;
			}
			win32.markBroken();
		}
		return runPs(buildSetScript(hwnd, x, y, width, height));
	}

	async function locate() {
		const got = await win32Get();
		// 每个失败都带一个稳定的机器码 `code`（界面按当前语言渲染），`error` 仍是中文（宿主日志
		// 与旧客户端回退用），`detail` 放原始系统信息——它本身就是本地化的，只作补充不作判据。
		if (!got.ok) return { ok: false, code: "enum_failed", detail: String(got.error ?? ""), error: `窗口枚举失败：${got.error ?? ""}` };
		let data = null;
		try {
			data = JSON.parse(got.out);
		} catch {
			return { ok: false, code: "enum_bad_json", error: "窗口枚举结果不是合法 JSON" };
		}
		const win = pickMainWindow(data && data.Windows, targetPid);
		if (!win) return { ok: false, code: "main_window_not_found", error: "未定位到 DSH 主窗口（标题/窗口类不匹配，或宿主 PID 已变）" };
		const cur = {
			hwnd: Number(win.H),
			x: Number(win.L),
			y: Number(win.T),
			width: Number(win.R) - Number(win.L),
			height: Number(win.B) - Number(win.T)
		};
		return { ok: true, cur, workArea: data && data.WorkArea };
	}

	/**
	 * 把窗口改成目标尺寸（+ 可选居中），最多重试 3 次、间隔 1s。
	 * 成功即更新 lastRect 并落盘；target 为 null 时只按 `center` 挪位置、不改大小。
	 */
	async function applyRect(cur, workArea, target, center) {
		const rect = computeRestoreRect(cur, target, workArea, center, cfg);
		if (Math.abs(cur.width - rect.width) <= 2 && Math.abs(cur.height - rect.height) <= 2
			&& Math.abs(cur.x - rect.x) <= 2 && Math.abs(cur.y - rect.y) <= 2) {
			return { ok: true, already: true, rect, current: cur };
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				await sleep(1000);
				if (stale()) return { ok: false, stale: true, code: "superseded", error: "已有新的插件实例接管，本次应用已放弃" };
			}
			const set = await win32Set(cur.hwnd, rect.x, rect.y, rect.width, rect.height);
			if (stale()) return { ok: false, stale: true, code: "superseded", error: "已有新的插件实例接管，本次应用已放弃" };
			if (set.ok && set.out === "OK") {
				lastRect = { width: rect.width, height: rect.height, x: rect.x, y: rect.y, hwnd: cur.hwnd };
				// 这一次是插件自己改出来的矩形：下一次采样看到同样的宽高不算"用户手动"。
				selfApplied = { width: rect.width, height: rect.height };
				writeState(file, lastRect);
				return { ok: true, already: false, rect, current: cur };
			}
		}
		return { ok: false, code: "set_pos_failed", error: "SetWindowPos 连续 3 次失败（Win32 助手/PowerShell 起不来，或窗口权限）", current: cur };
	}

	/**
	 * 立即应用一次当前选择（设置页「选中即生效」走这里）。
	 * 目标尺寸优先级：settings.json（设置页）> patch config > "上次尺寸"。
	 */
	async function applyNow() {
		if (!isWin) return { ok: false, code: "windows_only", params: { platform: process.platform }, error: `窗口尺寸调整仅支持 Windows（当前：${process.platform}）` };
		return serialize(async () => {
			const loc = await locate();
			if (!loc.ok) return loc;
			const settings = readSettings(settingsFile);
			let target = resolveTargetSize(cfg, settings, presets);
			if (!target) {
				const saved = readState(file);
				if (saved) target = { width: saved.width, height: saved.height, source: "last" };
			}
			if (!target && !centerEnabled()) return { ok: false, code: "no_target", error: "既没有可用尺寸，也没有开启居中" };
			const result = await applyRect(loc.cur, loc.workArea, target, centerEnabled());
			return { ...result, target, centerOnRestore: centerEnabled() };
		});
	}

	/**
	 * 提前恢复：`apply` 那一刻就起一个常驻 Win32 代理去盯窗口，一旦主窗口被创建
	 * （此刻它还藏着 —— Electron 要等 `loadURL` 完成才 `show()`）立刻 `SetWindowPos`。
	 * 于是窗口"第一次露面"就已经是上次的尺寸，启动动画不会播在错误尺寸上。
	 *
	 * 这条只是加速器：任何一步不成都静默放弃，`restoreDelayMs` 的旧路径照跑，
	 * 插件不会因为代理起不来而少做任何旧行为会做的事。
	 */
	async function earlyRestore() {
		const readTarget = () => {
			const t = resolveTargetSize(cfg, readSettings(settingsFile), presets);
			if (t) return t;
			const saved = readState(file);
			return saved ? { width: saved.width, height: saved.height, source: "last" } : null;
		};
		if (!readTarget()) return; // 没有可用尺寸：没什么可恢复的，让 cycle 去记第一个尺寸
		// 起代理：本机现编的助手 exe（约 90ms）优先，起不来或答不上来就退回 powershell（约 1.3s）。
		const opened = await openWinAgent(await win32.path());
		if (!opened) return;
		const agent = opened.agent;
		win32.backend = opened.backend;
		earlyAgent = agent;
		// openWinAgent 的探针已经枚举过一次，那份结果直接当盯窗循环的第一轮，不白花。
		let seeded = opened.windows;
		const budget = Math.max(1000, Number(cfg.earlyBudgetMs) || DEFAULTS.earlyBudgetMs);
		const poll = Math.max(10, Number(cfg.earlyPollMs) || DEFAULTS.earlyPollMs);
		const deadline = Date.now() + budget;
		try {
			while (!stopped && !stale() && Date.now() < deadline) {
				const got = seeded ? { ok: true, Windows: seeded } : await agent.enumWindows();
				seeded = null;
				if (!got.ok) return; // 代理没了：退回旧路径
				const win = pickEarlyMainWindow(got.Windows, targetPid, { minArea: cfg.earlyMinArea });
				if (win) {
					// 盯窗期间用户可能改了设置页的选择：动手前重读一次，别把旧目标盖上去。
					const target = readTarget();
					if (!target) return;
					const wa = await agent.workArea();
					const cur = {
						hwnd: Number(win.H),
						x: Number(win.L),
						y: Number(win.T),
						width: Number(win.R) - Number(win.L),
						height: Number(win.B) - Number(win.T)
					};
					const workArea = wa.ok ? { L: wa.L, T: wa.T, R: wa.R, B: wa.B } : null;
					const rect = computeRestoreRect(cur, target, workArea, centerEnabled(), cfg);
					lastRect = { width: rect.width, height: rect.height, x: rect.x, y: rect.y, hwnd: cur.hwnd };
					const same = Math.abs(cur.width - rect.width) <= 2 && Math.abs(cur.height - rect.height) <= 2
						&& Math.abs(cur.x - rect.x) <= 2 && Math.abs(cur.y - rect.y) <= 2;
					if (same) {
						restored = true;
						return;
					}
					const set = await agent.setWindowPos(cur.hwnd, rect.x, rect.y, rect.width, rect.height, SWP_MOVE_SIZE);
					if (set.ok && !stale()) {
						restored = true; // cycle 的恢复步骤因此跳过，不会对同一个窗口 resize 两次
						selfApplied = { width: rect.width, height: rect.height }; // 自己改的，不算手动
						writeState(file, lastRect);
						return;
					}
				}
				await sleep(poll);
			}
		} catch {
			/* 代理里的任何异常都不允许影响宿主：旧路径会接手 */
		} finally {
			earlyAgent = null;
			try { agent.close(); } catch { /* 已退出 */ }
		}
	}

	async function cycle() {
		if (stopped || busy || !isWin) return false;
		busy = true;
		try {
			return await serialize(async () => {
				const loc = await locate();
				if (!loc.ok) return false;
				const cur = loc.cur;
				lastRect = { width: cur.width, height: cur.height, x: cur.x, y: cur.y, hwnd: cur.hwnd };

				// 已有更新的 apply 接管（本 cycle 是热重载前的僵尸）→ 放弃一切写入。
				if (stale()) return;

				// ① 恢复：本次启动首次定位到窗口时，把目标尺寸套回去并居中。
				// 目标尺寸优先级：设置页（settings.json）> patch config > "上次尺寸"。
				// SetWindowPos / Win32 调用偶发失败 → 最多重试 3 次、间隔 1s；
				// 全部失败时 ② 会把实际尺寸落盘，下次启动再试（自愈）。
				if (!restored) {
					restored = true; // 无论成败，本次启动只尝试一次，避免每轮都 resize
					let target = resolveTargetSize(cfg, readSettings(settingsFile), presets);
					if (!target) {
						const saved = readState(file);
						if (saved) target = { width: saved.width, height: saved.height, source: "last" };
					}
					if (target) await applyRect(cur, loc.workArea, target, centerEnabled());
				}

				// ② 持久化 + "这一轮是不是用户自己在改窗口"的判定（都基于 lastRect，即恢复后的值）。
				if (stale()) return false;
				const r = lastRect;
				const prev = readState(file);
				const changed = !prev || prev.width !== r.width || prev.height !== r.height || prev.x !== r.x || prev.y !== r.y;
				if (changed) lastChangeAt = Date.now(); // 采到变化 → 下一次起用快轮询，并重置尾巴计时
				const decision = shouldAdoptManualSize(lastSample, r, selfApplied, {
					followManualResize: cfg.followManualResize !== false
				});
				if (decision.consumeSelfApplied || decision.adopt) selfApplied = null; // 自我标记只能用掉，不能滞留
				if (decision.adopt) {
					// 用户手动把窗口拖成了新宽高 → 「恢复尺寸」选择自动跟着切成「自定义」= 这个宽高。
					// 这一步只写设置、不改窗口，所以不会再触发一次恢复，也不会跟用户打架。
					writeSettings(settingsFile, { preset: CUSTOM_PRESET_ID, custom: { width: r.width, height: r.height } });
				}
				if (changed) writeState(file, r);
				lastSample = r;
				return changed;
			});
		} catch {
			/* 吞掉一切异常：插件绝不能影响宿主 */
		} finally {
			busy = false;
		}
	}

	// ---------- 设置页 HTTP 路由（/window-size-keeper/api） ----------

	/** GET /state 的载荷：设置页一次拿到「可选项 + 当前选择 + 最近窗口矩形 + 文件路径」。 */
	function statePayload() {
		const settings = readSettings(settingsFile);
		const saved = readState(file);
		const presetId = (typeof settings.preset === "string" && settings.preset)
			? settings.preset
			: String(cfg.preset ?? "").trim();
		const target = resolveTargetSize(cfg, settings, presets);
		return {
			ok: true,
			supported: isWin,
			platform: process.platform,
			// 宿主侧不做界面翻译：这里把中英文两份别名一起给出去，用哪一份由客户端按当前语言决定。
			// 用户在 patch config 里自定义 `presets` 时通常只写 `label` —— 那种原样显示，不机器翻译。
			presets: presets.map((p) => ({ id: p.id, label: p.label, labelEn: p.labelEn ?? "", width: p.width, height: p.height })),
			// 配置里的语言口径（"auto" | "zh" | "en"）也随载荷下发；"auto" 时客户端跟随 DSH 当前语言。
			language: normalizeLanguageChoice(cfg.language),
			preset: presetId,
			custom: settings.custom ?? null,
			centerOnRestore: centerEnabled(),
			target,
			lastKnown: lastRect,
			lastSaved: saved,
			stateFile: file,
			settingsFile,
			limits: { minW: cfg.minW, minH: cfg.minH, maxW: cfg.maxW, maxH: cfg.maxH },
			saveIntervalMs: cfg.saveIntervalMs,
			activeSampleMs: Math.max(250, Number(cfg.activeSampleMs) || DEFAULTS.activeSampleMs),
			activeTailMs: Math.max(0, Number(cfg.activeTailMs) || DEFAULTS.activeTailMs),
			followManualResize: cfg.followManualResize !== false,
			restoreDelayMs: cfg.restoreDelayMs,
			restoreEarly: cfg.restoreEarly !== false,
			earlyBudgetMs: Math.max(1000, Number(cfg.earlyBudgetMs) || DEFAULTS.earlyBudgetMs),
			earlyActive: earlyAgent != null,
			// Win32 这一步实际走的哪条路（"helper" = 本机现编的助手 exe，"powershell" = 兜底）
			// 加上助手 exe 的路径：排障时先看这两个字段，不用去猜有没有编译成功。
			win32Backend: win32.backend,
			win32HelperExe: win32.exe ?? null,
			win32HelperFallback: win32.broken === true,
			updatedAt: settings.updatedAt ?? ""
		};
	}

	function readRequestBody(req) {
		return new Promise((resolve) => {
			let data = "";
			req.on("data", (chunk) => {
				data += chunk;
				if (data.length > 65536) req.destroy();
			});
			req.on("end", () => resolve(data));
			req.on("error", () => resolve(""));
		});
	}

	/** 设置页的 HTTP 入口：GET /state、POST /select、POST /apply、POST /reset。 */
	async function handleApiRequest(req, res) {
		const send = (code, obj) => {
			res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(obj));
		};
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			const route = url.pathname.startsWith(API_PREFIX)
				? url.pathname.slice(API_PREFIX.length) || "/"
				: url.pathname;
			if (req.method === "GET" && (route === "/state" || route === "/")) {
				return send(200, statePayload());
			}
			if (req.method === "POST" && (route === "/select" || route === "/apply" || route === "/reset")) {
				let body = {};
				if (route === "/select") {
					try {
						body = JSON.parse((await readRequestBody(req)) || "{}");
					} catch {
						return send(400, { ok: false, code: "bad_json_body", error: "请求体不是合法 JSON" });
					}
				} else if (route === "/reset") {
					body = { preset: "" };
				}
				const settings = readSettings(settingsFile);
				const { patch, notes, noteCodes } = normalizeSelectBody(body, cfg, presets, settings);
				if (route === "/select" && Object.keys(patch).length === 0 && notes.length > 0) {
					return send(400, { ok: false, code: noteCodes[0]?.code ?? "invalid_input", noteCodes, error: notes.join("；"), state: statePayload() });
				}
				if (Object.keys(patch).length > 0) writeSettings(settingsFile, patch);
				const applied = await applyNow();
				return send(applied.ok ? 200 : 500, {
					...statePayload(),
					ok: applied.ok,
					applied,
					notes,
					noteCodes,
					// 失败时把原因码一并透传（`applied.code` 来自 locate/applyRect），界面据此选文案
					code: applied.ok ? undefined : (applied.code ?? "apply_failed"),
					error: applied.ok ? undefined : applied.error
				});
			}
			return send(404, { ok: false, code: "unknown_route", params: { method: String(req.method ?? ""), route }, error: `未知路由: ${req.method} ${route}` });
		} catch (err) {
			return send(500, { ok: false, code: "internal_error", error: String(err?.message ?? err) });
		}
	}

	/**
	 * 注册路由。webServer 不写进 inject（headless / 纯 agent 场景不能硬依赖），
	 * apply 那一刻也可能还没就绪 → 「先试一次，再有限重试」，服务晚到不会永久丢掉入口。
	 */
	const registerRoutes = () => {
		try {
			const server = ctx && typeof ctx.get === "function" ? ctx.get("webServer") : null;
			if (!server || typeof server.register !== "function") return false;
			const off = server.register({ kind: "prefix", path: API_PREFIX, handler: handleApiRequest });
			try {
				if (typeof ctx.effect === "function") ctx.effect(() => (typeof off === "function" ? off : () => {}), "window-size-keeper: api routes");
			} catch { /* 受限 ctx 拒绝 effect：路由仍在，卸载时随 fiber 一起消失 */ }
			return true;
		} catch {
			return false;
		}
	};
	if (!registerRoutes()) {
		let attempts = 0;
		const retry = setInterval(() => {
			attempts += 1;
			if (registerRoutes() || attempts >= 10) clearInterval(retry);
		}, 1500);
		if (typeof retry.unref === "function") retry.unref();
		try {
			if (typeof ctx.effect === "function") ctx.effect(() => () => clearInterval(retry), "window-size-keeper: route retry");
		} catch { /* 同上 */ }
	}

	// 非 Windows：设置页入口仍注册（能看到状态），但不启动窗口轮询/恢复。
	if (!isWin) return;

	// 提前恢复先起（这一刻主窗口通常还不存在，助手 exe 的现场编译 + 起进程正好藏在宿主启动的影子里），
	// restoreDelayMs 的轮询路径照旧留着当兜底。
	if (cfg.restoreEarly !== false) void earlyRestore();

	// 采样节奏是自排的（不再是固定 setInterval）：本轮采到变化 → 下一次排 activeSampleMs；
	// 距最后一次变化满 activeTailMs → 退回 saveIntervalMs 的待机节奏。必须跑完一轮才排下一次，
	// 所以 PowerShell 慢的时候不会叠出一串请求来。
	let tickTimer = null;
	const pump = () => {
		Promise.resolve()
			.then(() => cycle())
			.catch(() => { /* cycle 内部已吞掉一切异常：这里只保证排链不断 */ })
			.then(() => {
				if (stopped) return;
				const delay = nextSampleDelay(Date.now(), lastChangeAt, {
					idleMs: cfg.saveIntervalMs,
					activeMs: cfg.activeSampleMs,
					tailMs: cfg.activeTailMs
				});
				tickTimer = setTimeout(pump, delay);
				if (typeof tickTimer.unref === "function") tickTimer.unref();
			});
	};
	const firstTimer = setTimeout(() => {
		pump();
	}, Math.max(500, Number(cfg.restoreDelayMs) || DEFAULTS.restoreDelayMs));
	if (typeof firstTimer.unref === "function") firstTimer.unref();

	// 退出兜底：同步写最近一次已知尺寸（只用同步 fs，不 spawn 子进程）。
	const saveOnExit = () => {
		if (lastRect) writeState(file, lastRect);
	};
	process.on("beforeExit", saveOnExit);
	process.on("exit", saveOnExit);

	// 生命周期清理：热重载/卸载时清定时器、杀掉常驻代理与 process 钩子，并同步落盘最近尺寸。
	const cleanup = () => {
		stopped = true;
		const agent = earlyAgent;
		earlyAgent = null;
		if (agent) {
			try { agent.close(); } catch { /* 已退出 */ }
		}
		clearTimeout(firstTimer);
		if (tickTimer) clearTimeout(tickTimer);
		tickTimer = null;
		process.removeListener("beforeExit", saveOnExit);
		process.removeListener("exit", saveOnExit);
		saveOnExit();
	};
	try {
		// 宿主实际 API 是 ctx.fiber.effect(callback, label)：callback 立即执行，
		// 其返回值即清理函数，在 fiber 卸载（热重载/移除）时被调用。
		const fiber = ctx && ctx.fiber;
		if (fiber && typeof fiber.effect === "function") fiber.effect(() => cleanup, "window-size-keeper");
		else if (ctx && typeof ctx.effect === "function") ctx.effect(() => cleanup, "window-size-keeper");
		else if (ctx && typeof ctx.dispose === "function") ctx.dispose(cleanup);
		else if (ctx && typeof ctx.onDispose === "function") ctx.onDispose(cleanup);
	} catch {
		/* 无生命周期钩子也无妨：timer 已 unref，退出兜底由 beforeExit/exit 覆盖；
		   代数（gen）文件再兜一层，防僵尸 cycle 覆盖状态文件 */
	}
}

/**
 * 离线自检（scripts/selftest.mjs）直接调用的纯函数与常量：不参与运行时行为，
 * 也不改变插件对宿主的暴露面（宿主只读 `apply` / `name` / `inject`）。
 */
export const internals = {
	DEFAULTS,
	CUSTOM_PRESET_ID,
	API_PREFIX,
	resolveStateFile,
	resolveSettingsFile,
	readState,
	writeState,
	readSettings,
	writeSettings,
	normalizeCustom,
	normalizeLanguageChoice,
	resolveTargetSize,
	computeRestoreRect,
	normalizeSelectBody,
	nextSampleDelay,
	shouldAdoptManualSize,
	pickMainWindow,
	pickEarlyMainWindow,
	windowArea,
	findPreset,
	buildGetScript,
	buildSetScript,
	AGENT_SCRIPT,
	createWinAgent,
	// Win32 助手（现场编译 exe）这一层：纯函数部分能被离线逐条钉住，
	// `spawnLineAgent` / `createHelperAgent` / `openWinAgent` 由离线自检在真机上验协议。
	buildAgentCSharp,
	AGENT_CSHARP_TEMPLATE,
	normalizeWin32Backend,
	helperExeName,
	resolveHelperPaths,
	findCsc,
	compileHelperExe,
	ensureHelperExe,
	runHelper,
	spawnLineAgent,
	createHelperAgent,
	openWinAgent,
	HELPER_COMPILE_TIMEOUT_MS,
	HELPER_PROBE_TIMEOUT_MS
};
