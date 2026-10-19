// dsh-window-size-keeper 离线自检（零依赖，node 内置模块）。
//
// 跑法：`node scripts/selftest.mjs`（或 `npm run selftest`）。
// 覆盖五层：
//   1. 纯函数：computeRestoreRect（居中/夹取/工作区比窗口小）、resolveTargetSize
//      （设置页 > patch config > 上次尺寸）、normalizeSelectBody（非法输入拒绝与夹取）、
//      pickMainWindow（pid/窗口类/标题筛选）、pickEarlyMainWindow + windowArea
//      （提前恢复阶段：不要求可见、按面积认窗）、readSettings/writeSettings（原子写与合并）；
//   2. HTTP 路由：用假 ctx（get/effect）+ 真 http server + 真 fetch，跑 GET /state、
//      POST /select、POST /apply、POST /reset、未知路由；
//   2b. Win32 代理协议（仅 Windows）：真起一个 powershell.exe 走 ENUM / WA / SET / 连续指令 /
//      close 后请求 —— ENUM 与 WA 只读，SET 打在一个不存在的句柄上，不 resize 任何真实窗口；
//   3. 文案 i18n（假 __ModuleLoader__ 捕获客户端半个插件，只取它的纯 i18n 内核）：
//      中英词典逐 key 对齐、{占位符} 一致、英文表里不许残留中文；语言判定优先级
//      （配置写死 > DSH 当前语言 > 框架探针 > 浏览器判定）与"只有简体中文走中文、繁体一律英文"；
//      宿主原因码渲染成当前语言，认不出的码退回宿主原文而不是把错误码甩给用户。
//   4. 状态/设置文件落在临时目录，**不碰**真实的 ~/.dsh/storages/window-size-keeper。
//   5. 脱敏：调 scripts/check-sensitive.mjs 扫「发布要用的文件 + 只在仓库里的发布文档」，
//      禁账号家目录绝对路径、个人工作区绝对路径、写死的本机回环端口、凭据样式（key/secret/
//      password/token 赋值与前缀 key）、邮箱、机器指纹（SID、机器 GUID、主机名）；
//      扫描器自带"必须判红"与"必须判绿"两组对照，先验它自己不放水也不误报。
//
// 关于「会不会真改窗口」：路由里的 applyNow 会按 `process.ppid` 找 DSH 主窗口。
// 本脚本由普通 node 进程跑，父进程是 shell，名下没有 Chrome_WidgetWin_1 + 产品名标题的
// 窗口 → 定位必然失败 → 只验证「设置已落盘 + 错误如实回报」，不会 resize 任何真实窗口。
// 真机生效验证靠桌面端重启后看「设置 → 窗口大小」（见 README）。

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, internals } from "../lib/index.js";

const {
	DEFAULTS,
	API_PREFIX,
	computeRestoreRect,
	resolveTargetSize,
	normalizeSelectBody,
	readSettings,
	writeSettings,
	resolveSettingsFile,
	pickMainWindow,
	pickEarlyMainWindow,
	windowArea,
	findPreset
} = internals;

let passed = 0;
const failures = [];

function check(label, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ok   ${label}`);
	} catch (err) {
		failures.push({ label, message: String(err?.message ?? err) });
		console.log(`  FAIL ${label}\n       ${String(err?.message ?? err).split("\n")[0]}`);
	}
}

const WA = { L: 0, T: 0, R: 2560, B: 1400 };
const CUR = { hwnd: 1, x: 0, y: 0, width: 1280, height: 820 };

console.log("[1] computeRestoreRect（居中 / 夹取 / 工作区）");
check("选中 1920×1080 → 尺寸照搬 + 工作区居中", () => {
	const r = computeRestoreRect(CUR, { width: 1920, height: 1080 }, WA, true, DEFAULTS);
	assert.deepEqual(r, { width: 1920, height: 1080, x: 320, y: 160 });
});
check("选中 1280×720 → 居中到 (640, 340)", () => {
	const r = computeRestoreRect(CUR, { width: 1280, height: 720 }, WA, true, DEFAULTS);
	assert.deepEqual(r, { width: 1280, height: 720, x: 640, y: 340 });
});
check("3840×2160 比工作区大 → 夹到工作区大小并贴左上角", () => {
	const r = computeRestoreRect(CUR, { width: 3840, height: 2160 }, WA, true, DEFAULTS);
	assert.deepEqual(r, { width: 2560, height: 1400, x: 0, y: 0 });
});
check("100×100 低于下限 → 夹到 minW×minH", () => {
	const r = computeRestoreRect(CUR, { width: 100, height: 100 }, WA, true, DEFAULTS);
	assert.equal(r.width, DEFAULTS.minW);
	assert.equal(r.height, DEFAULTS.minH);
});
check("centerOnRestore=false → 只改大小，位置不动", () => {
	const cur = { ...CUR, x: 120, y: 80 };
	const r = computeRestoreRect(cur, { width: 1600, height: 900 }, WA, false, DEFAULTS);
	assert.deepEqual(r, { width: 1600, height: 900, x: 120, y: 80 });
});
check("target=null（上次尺寸缺失）→ 保持当前尺寸，只居中", () => {
	const r = computeRestoreRect({ ...CUR, x: 10, y: 10 }, null, WA, true, DEFAULTS);
	assert.deepEqual(r, { width: 1280, height: 820, x: 640, y: 290 });
});
check("多屏偏移工作区（L/T 非 0）→ 居中在副屏内", () => {
	const wa = { L: 2560, T: 0, R: 4480, B: 1440 };
	const r = computeRestoreRect(CUR, { width: 1920, height: 1080 }, wa, true, DEFAULTS);
	assert.deepEqual(r, { width: 1920, height: 1080, x: 2560, y: 180 });
});

console.log("[2] resolveTargetSize（优先级：设置页 > patch config > 上次尺寸）");
const PRESETS = DEFAULTS.presets;
check("设置页选了 1920×1080 → 用它，忽略 patch config 的 1280×720", () => {
	const t = resolveTargetSize({ preset: "1280x720" }, { preset: "1920x1080" }, PRESETS);
	assert.deepEqual(t, { width: 1920, height: 1080, source: "preset:1920x1080" });
});
check("设置页没选 → 回落 patch config 的 1280×720", () => {
	const t = resolveTargetSize({ preset: "1280x720" }, {}, PRESETS);
	assert.deepEqual(t, { width: 1280, height: 720, source: "preset:1280x720" });
});
check("设置页选 custom → 用 custom 宽高", () => {
	const t = resolveTargetSize({ preset: "" }, { preset: "custom", custom: { width: 1600, height: 1000 } }, PRESETS);
	assert.deepEqual(t, { width: 1600, height: 1000, source: "custom" });
});
check("设置页选 custom 但没填宽高 → null（退回上次尺寸，不乱猜）", () => {
	assert.equal(resolveTargetSize({ preset: "" }, { preset: "custom" }, PRESETS), null);
});
check("未知 preset id → null", () => {
	assert.equal(resolveTargetSize({ preset: "" }, { preset: "9999x9999" }, PRESETS), null);
});
check("内置清单含 1920×1080 / 1280×720 / 2560×1440 且不少于 10 项", () => {
	assert.ok(PRESETS.length >= 10, `内置清单只有 ${PRESETS.length} 项`);
	for (const id of ["1280x720", "1920x1080", "2560x1440", "1024x768", "3840x2160"]) {
		assert.ok(findPreset(PRESETS, id), `缺少预选项 ${id}`);
	}
});

console.log("[3] normalizeSelectBody（非法输入拒绝 / 夹取）");
check("未知 preset id → 丢弃并回报", () => {
	const { patch, notes } = normalizeSelectBody({ preset: "bogus" }, DEFAULTS, PRESETS, {});
	assert.equal(patch.preset, undefined);
	assert.match(notes.join(" "), /未知的 preset/);
});
check("合法 preset id → 接受", () => {
	const { patch } = normalizeSelectBody({ preset: "1920x1080" }, DEFAULTS, PRESETS, {});
	assert.equal(patch.preset, "1920x1080");
});
check("选 custom 但从未填过宽高 → 保持原选择不变", () => {
	const { patch, notes } = normalizeSelectBody({ preset: "custom" }, DEFAULTS, PRESETS, {});
	assert.equal(patch.preset, undefined);
	assert.match(notes.join(" "), /自定义/);
});
check("选 custom 且此前已有有效宽高 → 接受", () => {
	const { patch } = normalizeSelectBody({ preset: "custom" }, DEFAULTS, PRESETS, { custom: { width: 1500, height: 950 } });
	assert.equal(patch.preset, "custom");
});
check("自定义宽高越界 → 夹到上下限并回报", () => {
	const { patch, notes } = normalizeSelectBody({ preset: "custom", custom: { width: 99999, height: 10 } }, DEFAULTS, PRESETS, {});
	assert.deepEqual(patch.custom, { width: DEFAULTS.maxW, height: DEFAULTS.minH });
	assert.match(notes.join(" "), /夹取/);
});
check("自定义宽高不是数字 → 忽略", () => {
	const { patch, notes } = normalizeSelectBody({ custom: { width: "abc", height: null } }, DEFAULTS, PRESETS, {});
	assert.equal(patch.custom, undefined);
	assert.match(notes.join(" "), /自定义宽高/);
});
check("centerOnRestore 布尔化", () => {
	assert.equal(normalizeSelectBody({ centerOnRestore: false }, DEFAULTS, PRESETS, {}).patch.centerOnRestore, false);
	assert.equal(normalizeSelectBody({ centerOnRestore: 1 }, DEFAULTS, PRESETS, {}).patch.centerOnRestore, true);
});

console.log("[4] settings.json 读写（原子写 + 合并 + 保留未知键）");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsk-selftest-"));
const stateFile = path.join(tmp, "state.json");
const settingsFile = resolveSettingsFile({ stateFile });
check("settings.json 与状态文件同目录", () => {
	assert.equal(settingsFile, path.join(tmp, "settings.json"));
});
check("分次写入会合并，custom:null 会删除该键", () => {
	writeSettings(settingsFile, { preset: "1920x1080" });
	writeSettings(settingsFile, { centerOnRestore: false });
	const s = readSettings(settingsFile);
	assert.equal(s.preset, "1920x1080");
	assert.equal(s.centerOnRestore, false);
	writeSettings(settingsFile, { custom: { width: 1600, height: 1000 } });
	assert.deepEqual(readSettings(settingsFile).custom, { width: 1600, height: 1000 });
	writeSettings(settingsFile, { custom: null });
	assert.equal(readSettings(settingsFile).custom, undefined);
});
check("损坏的 settings.json → 空对象（不抛错）", () => {
	fs.writeFileSync(settingsFile, "{ 这不是 JSON", "utf8");
	assert.deepEqual(readSettings(settingsFile), {});
});
check("非整数自定义宽高被规整 / 非法值丢弃", () => {
	writeSettings(settingsFile, { custom: { width: 1600.6, height: 900.2 } });
	assert.deepEqual(readSettings(settingsFile).custom, { width: 1601, height: 900 });
	writeSettings(settingsFile, { custom: { width: -5, height: 900 } });
	assert.equal(readSettings(settingsFile).custom, undefined);
});

console.log("[5] pickMainWindow（pid / 窗口类 / 标题）");
const PID = 4242;
const win = (over) => ({ Pid: PID, Class: "Chrome_WidgetWin_1", Title: "DeepSeek Harness", L: 0, T: 0, R: 1280, B: 820, H: 1, ...over });
check("pid 不符 → null", () => {
	assert.equal(pickMainWindow([win({ Pid: 1 })], PID), null);
});
check("窗口类不符 → null", () => {
	assert.equal(pickMainWindow([win({ Class: "CASCADIA_HOSTING_WINDOW_CLASS" })], PID), null);
});
check("零面积（隐藏窗）→ null", () => {
	assert.equal(pickMainWindow([win({ R: 0, B: 0 })], PID), null);
});
check("标题命中优先于无标题候选", () => {
	const got = pickMainWindow([win({ Title: "DevTools" }), win({ Title: "DeepSeek Harness · 会话" })], PID);
	assert.equal(got?.Title, "DeepSeek Harness · 会话");
});
check("多个标题命中 → 取面积最大者", () => {
	const got = pickMainWindow([win({ H: 1 }), win({ H: 2, R: 1920, B: 1080 })], PID);
	assert.equal(got?.H, 2);
});

console.log("[5b] pickEarlyMainWindow（提前恢复：不要求可见，按面积认窗）");

const EPID = 4242;
const earlyWin = (over) => ({ H: "1", Pid: EPID, Class: "Chrome_WidgetWin_1", Title: "", L: 0, T: 0, R: 1280, B: 820, ...over });
const MAIN_WIN = earlyWin({});
const WELCOME_WIN = earlyWin({ H: "2", Title: "DeepSeek Harness", L: 900, T: 100, R: 1500, B: 800 }); // 600×700 = 420,000

check("pid 不符 → null", () => {
	assert.equal(pickEarlyMainWindow([earlyWin({ Pid: 999 })], EPID), null);
});
check("窗口类不符 → null", () => {
	assert.equal(pickEarlyMainWindow([earlyWin({ Class: "Not_a_Widget" })], EPID), null);
});
check("面积低于 earlyMinArea（欢迎窗 600×700）→ null", () => {
	assert.equal(pickEarlyMainWindow([WELCOME_WIN], EPID), null);
});
check("唯一候选即使标题为空（隐藏期标题还没变成产品名）→ 命中", () => {
	assert.equal(pickEarlyMainWindow([MAIN_WIN], EPID), MAIN_WIN);
});
check("主窗与欢迎窗并存 → 取面积最大者，不被欢迎窗的产品名标题带跑", () => {
	assert.equal(pickEarlyMainWindow([WELCOME_WIN, MAIN_WIN], EPID), MAIN_WIN);
});
check("两个面积接近的候选 → 判为分不清，返回 null（下一轮再看）", () => {
	const big = earlyWin({ H: "a", R: 1280, B: 820 });
	const near = earlyWin({ H: "b", L: 10, T: 10, R: 1210, B: 910 }); // 1200×900 = 1,080,000
	assert.ok(windowArea(big) > 0 && windowArea(near) > 0);
	assert.equal(pickEarlyMainWindow([big, near], EPID), null);
});
check("零面积 / 负面积候选 → null", () => {
	assert.equal(pickEarlyMainWindow([earlyWin({ R: 0, B: 0 })], EPID), null);
});
check("空表与非数组 → null", () => {
	assert.equal(pickEarlyMainWindow([], EPID), null);
	assert.equal(pickEarlyMainWindow(undefined, EPID), null);
});
check("minArea 可以被调用方覆盖", () => {
	assert.equal(pickEarlyMainWindow([WELCOME_WIN], EPID, { minArea: 1000 }), WELCOME_WIN);
});
check("windowArea：缺数字段与脏值都算 0，不抛错", () => {
	assert.equal(windowArea({ L: "x", T: 0, R: 10, B: 10 }), 0);
	assert.equal(windowArea(null), 0);
	assert.equal(windowArea({ L: 0, T: 0, R: 10, B: 20 }), 200);
});

console.log("[6] HTTP 路由（假 ctx + 真 http server + 真 fetch）");

async function main() {
	const routes = [];
	const effects = [];
	const ctx = {
		get: (name) => (name === "webServer" ? { register: (entry) => { routes.push(entry); return () => {}; } } : undefined),
		effect: (fn, label) => { effects.push(label); }
	};
	// restoreDelayMs / saveIntervalMs 拉到极大、restoreEarly 关掉：自检期间不触发任何窗口轮询，
	// 也不会为了盯窗口而真起一个 PowerShell 代理进程。
	apply(ctx, { stateFile, restoreDelayMs: 1e9, saveIntervalMs: 1e9, restoreEarly: false });
	assert.equal(routes.length, 1, `路由注册数 = ${routes.length}`);
	assert.equal(routes[0].kind, "prefix");
	assert.equal(routes[0].path, API_PREFIX);

	const server = http.createServer((req, res) => routes[0].handler(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
	const get = async (p) => {
		const res = await fetch(base + p);
		return { code: res.status, body: await res.json() };
	};
	const post = async (p, body) => {
		const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
		return { code: res.status, body: await res.json() };
	};

	let state = null;
	const run = async (label, fn) => {
		try {
			await fn();
			passed += 1;
			console.log(`  ok   ${label}`);
		} catch (err) {
			failures.push({ label, message: String(err?.message ?? err) });
			console.log(`  FAIL ${label}\n       ${String(err?.message ?? err).split("\n")[0]}`);
		}
	};

	await run("GET /state：ok + 12 项预设 + 默认 preset 为空", async () => {
		const r = await get("/state");
		state = r.body;
		assert.equal(r.code, 200);
		assert.equal(state.ok, true);
		assert.ok(Array.isArray(state.presets) && state.presets.length >= 10, `presets=${state.presets?.length}`);
		assert.equal(state.preset, "");
		assert.equal(state.centerOnRestore, true);
		assert.equal(state.stateFile, stateFile);
		assert.equal(state.settingsFile, settingsFile);
		assert.equal(state.supported, process.platform === "win32");
	});

	await run("POST /select {preset:1920x1080} → 落盘并在 state 里回显", async () => {
		const r = await post("/select", { preset: "1920x1080" });
		assert.ok(r.code === 200 || r.code === 500, `code=${r.code}`);
		assert.equal(r.body.preset, "1920x1080");
		assert.deepEqual(readSettings(settingsFile).preset, "1920x1080");
		assert.deepEqual(r.body.target, { width: 1920, height: 1080, source: "preset:1920x1080" });
		// 本脚本的父进程不是 DSH 宿主 → 定位不到主窗口，错误必须如实回报而不是谎报成功
		if (process.platform === "win32") {
			assert.equal(r.body.ok, false, "不该谎报已改窗口");
			assert.match(String(r.body.error), /未定位到|窗口枚举失败/);
		}
	});

	await run("POST /select 未知 preset → 400 且不改设置", async () => {
		const r = await post("/select", { preset: "bogus" });
		assert.equal(r.code, 400);
		assert.equal(r.body.ok, false);
		assert.equal(readSettings(settingsFile).preset, "1920x1080");
	});

	await run("POST /select custom（无宽高）→ 400", async () => {
		const r = await post("/select", { preset: "custom" });
		assert.equal(r.code, 400);
		assert.equal(readSettings(settingsFile).preset, "1920x1080");
	});

	await run("POST /select custom（带宽高）→ 接受并回显 custom", async () => {
		const r = await post("/select", { preset: "custom", custom: { width: 1600, height: 1000 } });
		assert.equal(r.body.preset, "custom");
		assert.deepEqual(r.body.custom, { width: 1600, height: 1000 });
		assert.deepEqual(r.body.target, { width: 1600, height: 1000, source: "custom" });
	});

	await run("POST /select centerOnRestore:false → 生效并回显", async () => {
		const r = await post("/select", { centerOnRestore: false });
		assert.equal(r.body.centerOnRestore, false);
		assert.equal(readSettings(settingsFile).centerOnRestore, false);
	});

	await run("POST /reset → preset 退回空串（上次尺寸）", async () => {
		const r = await post("/reset", {});
		assert.equal(r.body.preset, "");
		assert.equal(readSettings(settingsFile).preset, "");
	});

	await run("POST /apply → 无窗口时如实失败，不谎报", async () => {
		const r = await post("/apply", {});
		assert.ok(r.code === 200 || r.code === 500, `code=${r.code}`);
		if (process.platform === "win32") {
			assert.equal(r.body.ok, false);
			assert.match(String(r.body.error), /未定位到|窗口枚举失败/);
		}
	});

	await run("非法 JSON 请求体 → 400", async () => {
		const res = await fetch(`${base}/select`, { method: "POST", headers: { "content-type": "application/json" }, body: "{ 坏 JSON" });
		assert.equal(res.status, 400);
	});

	await run("未知路由 → 404", async () => {
		const r = await get("/nope");
		assert.equal(r.code, 404);
	});

	await run("默认路径就是 ~/.dsh/storages/window-size-keeper（自检只写临时目录）", async () => {
		const defState = path.join(os.homedir(), ".dsh", "storages", "window-size-keeper", "state.json");
		assert.equal(internals.resolveStateFile({}), defState);
		assert.equal(resolveSettingsFile({}), path.join(path.dirname(defState), "settings.json"));
		// 自检写入的一切都在 tmp 下：stateFile 的目录就是 tmp
		assert.equal(path.dirname(stateFile), tmp);
	});

	// [7] Win32 代理协议：真起一个 powershell.exe 走一遍 ENUM / WA / SET / 未知指令 / EXIT。
	// ENUM 与 WA 只读；SET 打在一个不存在的句柄上（SetWindowPos 返回 false），
	// 所以这段不会 resize 任何真实窗口。非 Windows 上整段跳过。
	if (process.platform === "win32") {
		console.log("[7] Win32 代理协议（真 powershell.exe，只读 + 假句柄）");
		const withAgent = async (label, fn) => {
			await run(label, async () => {
				const agent = internals.createWinAgent();
				assert.ok(agent, "代理起不来（powershell.exe 不可用？）");
				try {
					await fn(agent);
				} finally {
					agent.close();
				}
			});
		};

		await withAgent("ENUM 回一行 JSON，Windows 字段是数组", async (agent) => {
			const got = await agent.enumWindows();
			assert.equal(got.ok, true);
			assert.ok(Array.isArray(got.Windows), `Windows 不是数组：${JSON.stringify(got.Windows).slice(0, 80)}`);
		});

		await withAgent("WA 回主屏工作区四个数", async (agent) => {
			const wa = await agent.workArea();
			assert.equal(wa.ok, true);
			for (const k of ["L", "T", "R", "B"]) assert.ok(Number.isFinite(Number(wa[k])), `${k} 不是数：${JSON.stringify(wa)}`);
			assert.ok(Number(wa.R) > Number(wa.L) && Number(wa.B) > Number(wa.T), `工作区面积非正：${JSON.stringify(wa)}`);
		});

		await withAgent("SET 打不存在的句柄 → 如实报失败，不谎报已改窗口", async (agent) => {
			const set = await agent.setWindowPos(1, 0, 0, 100, 100, 0x0014);
			assert.equal(set.ok, false);
		});

		await withAgent("连续多条指令在同一条 FIFO 上按序应答，不串台", async (agent) => {
			const wa = await agent.workArea();
			const got = await agent.enumWindows();
			assert.equal(wa.ok, true);
			assert.equal(got.ok, true);
			assert.equal(got.cmd, "ENUM");
			assert.equal(wa.cmd, "WA");
		});

		await run("close 之后的请求立刻判失败，不悬挂", async () => {
			const agent = internals.createWinAgent();
			assert.ok(agent, "代理起不来");
			const got = await agent.enumWindows();
			assert.equal(got.ok, true);
			agent.close();
			const started = Date.now();
			const after = await agent.enumWindows();
			assert.equal(after.ok, false);
			assert.ok(Date.now() - started < 2000, `close 后请求等了 ${Date.now() - started}ms`);
		});
	}

	// [8] 文案 i18n：词典对齐、语言判定优先级、原因码渲染。客户端半个插件是浏览器模块，
	// 这里用假 __ModuleLoader__ 捕获工厂，只取它的纯 i18n 内核——不碰 DOM、不发请求、不起进程。
	console.log("[8] 文案 i18n（词典对齐 / 语言判定 / 原因码渲染）");
	let clientDef = null;
	globalThis.window = { __ModuleLoader__: { load: (def) => { clientDef = def; } } };
	await import("../lib/client.js");
	assert.ok(clientDef, "客户端模块没被 __ModuleLoader__ 捕获");
	const clientModule = clientDef.factory(() => ({ createElement: () => null, useRef: () => ({}), useEffect: () => {} }));
	const i18n = clientModule.__i18n;
	delete globalThis.window;

	check("客户端模块 id 与 inject 不变（**没有**硬依赖 locale 服务）", () => {
		assert.equal(clientDef.id, "dsh-window-size-keeper");
		assert.deepEqual(clientModule.inject, ["slots"]);
		assert.deepEqual(i18n.LANGS, ["zh", "en"]);
	});
	check("词典只有中英两份，key 集逐条对齐", () => {
		const zh = Object.keys(i18n.dictionaries.zh).sort();
		const en = Object.keys(i18n.dictionaries.en).sort();
		assert.deepEqual(en, zh);
		assert.ok(zh.length >= 50, `词典只有 ${zh.length} 条，明显被删薄了`);
	});
	check("英文词典里不许残留中日韩字符（漏翻当场红）", () => {
		for (const [key, value] of Object.entries(i18n.dictionaries.en)) {
			assert.ok(!/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(String(value)), `${key} 残留中文：${value}`);
		}
	});
	check("中英两份的 {占位符} 必须一模一样（少一个就把花括号甩给用户）", () => {
		const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(",");
		for (const key of Object.keys(i18n.dictionaries.zh)) {
			assert.equal(ph(i18n.dictionaries.en[key]), ph(i18n.dictionaries.zh[key]), `key ${key} 的占位符不一致`);
		}
	});
	check("detectLanguage：只有简体中文走中文，繁体与其它语言一律英文", () => {
		assert.equal(i18n.detectLanguage({ languages: ["zh-CN", "zh"] }), "zh");
		assert.equal(i18n.detectLanguage({ languages: ["zh-Hans-CN"] }), "zh");
		assert.equal(i18n.detectLanguage({ language: "zh-SG" }), "zh");
		assert.equal(i18n.detectLanguage({ languages: ["zh-TW", "zh"] }), "en");
		assert.equal(i18n.detectLanguage({ languages: ["zh-Hant", "en-US"] }), "en");
		assert.equal(i18n.detectLanguage({ languages: ["en-GB", "zh-CN"] }), "en");
		assert.equal(i18n.detectLanguage({ languages: ["fr-FR", "zh-Hans-CN"] }), "zh");
		assert.equal(i18n.detectLanguage({ languages: ["de-DE"] }), "en");
		assert.equal(i18n.detectLanguage({}), "en");
	});
	check("resolveLanguage 优先级：配置写死 > DSH 当前语言 > 框架探针 > 浏览器兜底", () => {
		const env = { languages: ["zh-CN"] };
		assert.equal(i18n.resolveLanguage({ override: "en", active: "zh", env }), "en");
		assert.equal(i18n.resolveLanguage({ active: "en", probe: "zh", env }), "en");
		assert.equal(i18n.resolveLanguage({ probe: "zh", env }), "zh");
		assert.equal(i18n.resolveLanguage({ env: { languages: ["zh-TW"] } }), "en");
		// 认不出的写死值不许把框架语言顶掉（配置写错 ≠ 界面换语言）
		assert.equal(i18n.resolveLanguage({ override: "zh-TW", active: "en", env }), "en");
	});
	check("预选项别名按语言挑；缺 labelEn 就原样显示，绝不机器翻译", () => {
		const p = { id: "1536x864", label: "1536×864（1920 在 125% 缩放下的等效尺寸）", labelEn: "1536×864 (Equivalent of 1920 at 125% scaling)", width: 1536, height: 864 };
		assert.equal(i18n.presetLabel(p, "zh"), p.label);
		assert.equal(i18n.presetLabel(p, "en"), p.labelEn);
		assert.equal(i18n.presetLabel({ label: "我的小窗" }, "en"), "我的小窗");
		assert.equal(i18n.presetAlias(p.label), "1920 在 125% 缩放下的等效尺寸");
		assert.equal(i18n.presetAlias(p.labelEn), "Equivalent of 1920 at 125% scaling");
	});
	check("宿主给的每个内置预选项都带英文别名，且别名取得出来", () => {
		for (const p of DEFAULTS.presets) {
			assert.ok(p.labelEn, `${p.id} 缺 labelEn`);
			assert.ok(!/[\u3400-\u9fff]/.test(p.labelEn), `${p.id} 的 labelEn 里有中文：${p.labelEn}`);
			assert.ok(i18n.presetAlias(i18n.presetLabel(p, "en")).length > 0, `${p.id} 的英文别名取不出来`);
		}
	});
	check("原因码渲染成当前语言；认不出的码退回宿主原文，绝不把码甩给用户", () => {
		const payload = { code: "main_window_not_found", error: "未定位到 DSH 主窗口（标题/窗口类不匹配，或宿主 PID 已变）" };
		assert.equal(i18n.errorText("zh", payload), payload.error);
		const en = i18n.errorText("en", payload);
		assert.ok(/Could not find the DSH main window/.test(en), en);
		assert.ok(!/[\u3400-\u9fff]/.test(en), en);
		assert.equal(i18n.errorText("en", { code: "no_such_code_from_another_plugin", error: "旧宿主的一句话" }), "旧宿主的一句话");
		assert.equal(i18n.errorText("en", { code: "no_such_code" }), "unknown error");
		assert.equal(i18n.errorText("en", {}), "unknown error");
	});
	check("带 detail 的失败走「带详情」那条文案，详情原样附上（不翻译系统报错）", () => {
		assert.equal(i18n.errorText("en", { code: "enum_failed", detail: "Access is denied" }), "Window enumeration failed: Access is denied");
		assert.equal(i18n.errorText("zh", { code: "enum_failed", detail: "拒绝访问" }), "窗口枚举失败：拒绝访问");
		assert.equal(i18n.errorText("en", { code: "enum_failed" }), "Window enumeration failed");
	});
	check("校验提示按 noteCodes 渲染；旧宿主只给字符串时也照样显示", () => {
		const { noteCodes, notes } = normalizeSelectBody({ preset: "bogus" }, DEFAULTS, PRESETS, {});
		assert.equal(noteCodes[0].code, "unknown_preset");
		assert.deepEqual(i18n.notesText("en", { noteCodes, notes }), ["Unknown preset id: bogus"]);
		assert.deepEqual(i18n.notesText("zh", { noteCodes, notes }), ["未知的 preset id：bogus"]);
		assert.deepEqual(i18n.notesText("en", { notes: ["只有字符串的旧宿主"] }), ["只有字符串的旧宿主"]);
	});
	check("夹取提示带得动六个数字参数", () => {
		const { noteCodes, notes } = normalizeSelectBody({ custom: { width: 99999, height: 10 } }, DEFAULTS, PRESETS, {});
		assert.deepEqual(i18n.notesText("en", { noteCodes, notes }), [
			`Custom size clamped to ${DEFAULTS.maxW}×${DEFAULTS.minH} (bounds ${DEFAULTS.minW}×${DEFAULTS.minH} – ${DEFAULTS.maxW}×${DEFAULTS.maxH})`
		]);
	});
	check("宿主语言口径归一：只认三类，zh-TW/zh-Hant 不算强制中文", () => {
		const pick = internals.normalizeLanguageChoice;
		assert.equal(pick("auto"), "auto");
		assert.equal(pick(undefined), "auto");
		assert.equal(pick("ZH-CN"), "zh");
		assert.equal(pick("zh_Hans_SG"), "zh");
		assert.equal(pick("en-GB"), "en");
		assert.equal(pick("zh-TW"), "auto");
		assert.equal(pick("zh-Hant"), "auto");
		assert.equal(pick("日本語"), "auto");
	});
	// 双语主文档的硬规矩也钉进自检：README.md 是英文主文档，README_zh.md 是简体中文对应版，
	// 章节结构必须一一对应（改一边忘另一边当场红）。
	check("README.md 是英文主文档（除语言切换那一行，正文不许有中日韩字符）", () => {
		const lines = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n");
		const cjk = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
		lines.forEach((line, index) => {
			if (index === 2) return; // 第 3 行是 [English](README.md) | [中文](README_zh.md)：那种语言的名字就该用那种语言写
			assert.ok(!cjk.test(line), `README.md 第 ${index + 1} 行残留中日韩字符：${line.slice(0, 80)}`);
		});
	});
	check("README_zh.md 是真正的简体中文版（不是空壳，也要链回英文版）", () => {
		const text = fs.readFileSync(new URL("../README_zh.md", import.meta.url), "utf8");
		assert.ok(/\]\(README\.md\)/.test(text), "README_zh.md 没链回 README.md");
		const zhLines = text.split("\n").filter((line) => /[\u3400-\u9fff]/.test(line)).length;
		assert.ok(zhLines >= 40, `只有 ${zhLines} 行含中文，不像一份中文文档`);
	});
	check("两份 README 的章节结构一一对应（段数与层级都必须一致，改一边要带上另一边）", () => {
		const heads = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8").split("\n").filter((line) => /^#{2,3} /.test(line));
		const en = heads("../README.md");
		const zh = heads("../README_zh.md");
		assert.equal(zh.length, en.length, `章节数不一致：英文 ${en.length} 段 / 中文 ${zh.length} 段`);
		for (let i = 0; i < en.length; i += 1) {
			assert.equal(zh[i][0], en[i][0], `第 ${i + 1} 个章节层级不一致：英文「${en[i]}」对中文「${zh[i]}」`);
			assert.notEqual(zh[i], en[i], `第 ${i + 1} 个章节标题两份一模一样（有一边没翻）`);
		}
	});
	await run("GET /state 载荷带 language 与中英两份预选项别名", async () => {
		const state = await get("/state");
		assert.equal(state.body.language, "auto");
		assert.ok(state.body.presets.every((p) => typeof p.labelEn === "string" && p.labelEn.length > 0));
	});

	// [9] 客户端渲染：假 DOM 跑真 lib/client.js，验"中英文真渲染出来"而不是只验词典数据。
	// 只实现这个分区用到的那几种 DOM 能力；切语言时要求**同一批节点**还在（不重建），
	// 用户正在输入的自定义宽高不能丢。
	console.log("[9] 客户端渲染（假 DOM：双语、切语言不重建、提示跟着换语言）");
	const tick = () => new Promise((resolve) => setImmediate(resolve));
	const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;
	// 失败时别把整页文本糊到控制台上，截一段够看的
	const clip = (value) => String(value).replace(/\s+/g, " ").trim().slice(0, 200);

	class FakeNode {
		constructor(tag) {
			this.tagName = String(tag).toUpperCase();
			this.children = [];
			this.parentNode = null;
			this._own = "";
			this.className = "";
			this.listeners = {};
			this.disabled = false;
			this.checked = false;
			this.value = "";
			this.placeholder = "";
			this.type = "";
			this.min = "";
			this.max = "";
			this.focused = 0;
		}
		get textContent() {
			return this.children.length ? this.children.map((c) => c.textContent).join("") : this._own;
		}
		set textContent(value) {
			this.children = [];
			this._own = value === undefined || value === null ? "" : String(value);
		}
		append(...nodes) {
			for (const node of nodes) {
				if (!node) continue;
				if (node.parentNode) node.parentNode.removeChild(node);
				node.parentNode = this;
				this.children.push(node);
			}
		}
		appendChild(node) { this.append(node); return node; }
		removeChild(node) {
			const index = this.children.indexOf(node);
			if (index >= 0) { this.children.splice(index, 1); node.parentNode = null; }
			return node;
		}
		remove() { if (this.parentNode) this.parentNode.removeChild(this); }
		addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
		dispatch(type) { for (const fn of this.listeners[type] || []) fn({ target: this, currentTarget: this }); }
		focus() { this.focused += 1; }
		get classList() {
			const self = this;
			const set = () => new Set(String(self.className).split(/\s+/).filter(Boolean));
			const put = (next) => { self.className = [...next].join(" "); };
			return {
				add: (cls) => put(new Set([...set(), cls])),
				remove: (cls) => { const s = set(); s.delete(cls); put(s); },
				contains: (cls) => set().has(cls)
			};
		}
	}
	const collectByClass = (node, cls, out = []) => {
		if (String(node.className).split(/\s+/).includes(cls)) out.push(node);
		for (const child of node.children) collectByClass(child, cls, out);
		return out;
	};

	const savedGlobals = {};
	for (const key of ["document", "navigator", "window", "Intl", "fetch"]) savedGlobals[key] = globalThis[key];

	const fakeReact = {
		createElement(type, props, ...children) {
			if (typeof type === "function") return type(props || {});
			const node = new FakeNode(type);
			if (props) {
				for (const key of Object.keys(props)) {
					if (key === "children") continue;
					if (key === "ref") { props.ref.current = node; continue; }
					node[key] = props[key];
				}
			}
			node.append(...children.flat(6).filter((c) => c !== null && c !== undefined && c !== false).map((c) => (typeof c === "object" ? c : Object.assign(new FakeNode("#text"), { _own: String(c) }))));
			return node;
		},
		useRef(initial) {
			if (!hookSlots[hookIndex]) hookSlots[hookIndex] = { current: initial };
			return hookSlots[hookIndex++];
		},
		useEffect(fn) { pendingEffects.push(fn); }
	};
	let hookSlots = [];
	let hookIndex = 0;
	let pendingEffects = [];

	const STATE_BASE = {
		ok: true, supported: true, platform: "win32", language: "auto",
		presets: [
			{ id: "1024x768", label: "1024×768（XGA）", labelEn: "1024×768 (XGA)", width: 1024, height: 768 },
			{ id: "1536x864", label: "1536×864（1920 在 125% 缩放下的等效尺寸）", labelEn: "1536×864 (Equivalent of 1920 at 125% scaling)", width: 1536, height: 864 },
			{ id: "1920x1080", label: "1920×1080（Full HD）", labelEn: "1920×1080 (Full HD)", width: 1920, height: 1080 }
		],
		preset: "1920x1080", custom: null, centerOnRestore: true,
		target: { width: 1920, height: 1080, source: "preset:1920x1080" },
		lastKnown: { width: 1920, height: 1080, x: 320, y: 160, savedAt: "2026-10-19T12:34:56.789Z" },
		lastSaved: null,
		// 这两条只是给人看的显示数据（断言不依赖它）：写占位符，仓库里不留任何人的账号名
		stateFile: "<HOME>/.dsh/storages/window-size-keeper/state.json",
		settingsFile: "<HOME>/.dsh/storages/window-size-keeper/settings.json",
		limits: { minW: 200, minH: 120, maxW: 4320, maxH: 4320 },
		notes: [], noteCodes: []
	};

	/**
	 * 装一次运行环境并渲染设置页。
	 * @param options.active  DSH 当前语言（给了就同时提供语言服务，模拟 0.2 客户端）
	 * @param options.nav     浏览器语言线索（没有语言服务时才会被用到）
	 * @param options.reply   POST 回报的覆盖（用来演"改窗口失败"与"未知错误码"）
	 */
	const renderSection = async ({ active, nav, reply = {}, registerThrows = false } = {}) => {
		hookSlots = []; hookIndex = 0; pendingEffects = [];
		const body = new FakeNode("body");
		const timers = [];
		globalThis.document = { createElement: (tag) => new FakeNode(tag), body, head: new FakeNode("head") };
		globalThis.window = {
			setInterval: (fn, ms) => { const entry = { fn, ms, cleared: false }; timers.push(entry); return entry; },
			clearInterval: (entry) => { if (entry) entry.cleared = true; }
		};
		if (nav) Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
		else if (savedGlobals.navigator) Object.defineProperty(globalThis, "navigator", { value: savedGlobals.navigator, configurable: true, writable: true });
		Object.defineProperty(globalThis, "Intl", { value: { DateTimeFormat: () => ({ resolvedOptions: () => ({ locale: (nav && (nav.languages && nav.languages[0])) || (nav && nav.language) || "en-US" }) }) }, configurable: true, writable: true });

		const requests = [];
		globalThis.fetch = (url, init) => {
			requests.push(`${init && init.method ? init.method : "GET"} ${url}`);
			let payload = STATE_BASE;
			if (init && init.method === "POST") {
				const sent = JSON.parse(init.body || "{}");
				payload = { ...STATE_BASE, preset: String(sent.preset || STATE_BASE.preset), applied: { ok: true, already: false, rect: { width: 1920, height: 1080, x: 320, y: 160 } }, ...reply };
			}
			return Promise.resolve({ json: () => Promise.resolve({ ...payload, language: active ? "auto" : "auto" }) });
		};

		let dictStore = null;
		let fireLang = null;
		let unsubscribeCalls = 0;
		let registration = null;
		const disposers = [];
		const localeService = !active ? null : {
			register: (ns, dicts) => {
				// 演一遍"同命名空间已被上一代注册占了"：真框架就是抛这个错（热重载两代并存时）
				if (registerThrows) throw new Error(`locale namespace "${ns}" already has locale "zh"`);
				dictStore = { ns, dicts };
				return () => { dictStore = null; };
			},
			bind: (ns) => (key, params) => {
				const table = (dictStore && dictStore.ns === ns ? dictStore.dicts : null) || {};
				const value = (table[currentActive()] || {})[key] ?? (table.en || {})[key] ?? key;
				return String(value).replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m));
			},
			getSnapshot: () => ({ active: currentActive(), locales: ["zh", "en"], revision: 1 }),
			subscribe: (cb) => { fireLang = cb; return () => { unsubscribeCalls += 1; }; }
		};
		let currentActiveState = active || "";
		const currentActive = () => currentActiveState;
		const ctx = {
			effect: (fn) => { disposers.push(fn()); },
			get: (name) => (name === "locale" ? localeService : undefined),
			slots: { inject: (seat, factory) => { factory(); }, register: (options, component) => { registration = { options, component }; } }
		};
		if (localeService) ctx.locale = localeService;

		const mod = clientDef.factory((id) => (id === "react" ? fakeReact : {}));
		mod.apply(ctx);
		const sectionNode = registration.component();
		const cleanups = [];
		for (const effect of pendingEffects.splice(0)) {
			const cleanup = effect();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		}
		body.appendChild(sectionNode);
		await tick(); await tick();

		const text = () => sectionNode.textContent;
		return {
			mod, ctx, sectionNode, registration, timers, requests, disposers, cleanups,
			text,
			byClass: (cls) => collectByClass(sectionNode, cls),
			setActive: (next) => { currentActiveState = next; },
			fireLang: async () => { if (fireLang) { fireLang(); await tick(); await tick(); } },
			kill: () => { for (const cleanup of cleanups) cleanup(); for (const d of disposers) if (typeof d === "function") d(); },
			unsubscribed: () => unsubscribeCalls,
			dictRegistered: () => (dictStore ? Object.keys(dictStore.dicts).sort().join(",") : "")
		};
	};

	const restoreGlobals = () => {
		for (const key of ["document", "navigator", "window", "Intl", "fetch"]) {
			if (savedGlobals[key] === undefined) delete globalThis[key];
			else Object.defineProperty(globalThis, key, { value: savedGlobals[key], configurable: true, writable: true });
		}
	};

	await run("英文环境（DSH 当前语言 en）：整页没有中文，标题/按钮/选项都是英文", async () => {
		const page = await renderSection({ active: "en", nav: { languages: ["zh-CN"] } });
		try {
			assert.equal(page.byClass("wsk-page")[0].children.length > 0, true);
			assert.equal(page.text().includes("Window size"), true);
			assert.equal(CJK.test(page.text()), false, `页面里残留中文：${page.text()}`);
			assert.equal(page.byClass("wsk-btn").map((n) => n.textContent).includes("Apply current selection"), true);
			assert.equal(page.byClass("wsk-btn").map((n) => n.textContent).includes("Refresh"), true);
			assert.equal(page.text().includes("Equivalent of 1920 at 125% scaling"), true);
			assert.equal(page.text().includes("Next start will use: 1920×1080 (source: preset:1920x1080)"), true);
			assert.equal(page.byClass("wsk-input")[0].placeholder, "Width");
			// 故意把浏览器写成 zh-CN：有语言服务时必须听 DSH 的，不能听浏览器的
			assert.equal(page.registration.options.label(), "Window size");
			assert.equal(page.dictRegistered(), "en,zh");
		} finally { page.kill(); restoreGlobals(); }
	});

	await run("中文环境（DSH 当前语言 zh）：标题/按钮/别名/静态行全是中文", async () => {
		const page = await renderSection({ active: "zh", nav: { languages: ["en-US"] } });
		try {
			assert.equal(page.registration.options.label(), "窗口大小");
			assert.equal(page.byClass("wsk-btn").map((n) => n.textContent).includes("立即应用当前选择"), true);
			assert.equal(page.text().includes("1920 在 125% 缩放下的等效尺寸"), true);
			assert.equal(page.text().includes("下次启动将用：1920×1080（来源 preset:1920x1080）"), true);
			assert.equal(page.byClass("wsk-input")[0].placeholder, "宽");
			assert.equal(page.text().includes("Window size"), false);
		} finally { page.kill(); restoreGlobals(); }
	});

	await run("没有语言服务的老客户端：浏览器 zh-TW 判成英文，zh-Hans-CN 判成中文", async () => {
		const traditional = await renderSection({ nav: { languages: ["zh-TW", "zh"], language: "zh-TW" } });
		try {
			assert.equal(traditional.registration.options.label(), "Window size");
			assert.equal(CJK.test(traditional.text()), false, traditional.text());
		} finally { traditional.kill(); }
		const hans = await renderSection({ nav: { languages: ["zh-Hans-CN"], language: "zh-Hans-CN" } });
		try {
			assert.equal(hans.registration.options.label(), "窗口大小");
		} finally { hans.kill(); restoreGlobals(); }
	});

	await run("词典没注册上但 bind 仍可用（热重载两代并存）：不许把内部 key 甩到界面上，自动退回本地词典", async () => {
		const page = await renderSection({ active: "en", nav: { languages: ["en-US"] }, registerThrows: true });
		try {
			const text = page.text();
			assert.equal(text.includes("Window size"), true, clip(text));
			for (const key of Object.keys(clientModule.__i18n.dictionaries.en)) {
				assert.equal(text.includes(key), false, `界面里露出了内部 key：${key}`);
			}
			assert.equal(page.byClass("wsk-input")[0].placeholder, "Width");
			assert.equal(page.registration.options.label(), "Window size");
			assert.equal(CJK.test(text), false, clip(text));
		} finally { page.kill(); restoreGlobals(); }
	});

	await run("切语言不重建 DOM：文案立刻换、正在输入的自定义宽高留着、提示也换成新语言", async () => {
		const page = await renderSection({ active: "zh", nav: { languages: ["en-US"] } });
		try {
			const inputs = page.byClass("wsk-input");
			inputs[0].value = "1600";
			assert.equal(page.registration.options.label(), "窗口大小");
			const before = page.sectionNode;
			page.setActive("en");
			await page.fireLang();
			assert.equal(page.sectionNode, before, "整页节点被换掉了（说明重建了 DOM）");
			assert.equal(page.sectionNode.textContent.includes("Window size"), true);
			assert.equal(CJK.test(page.sectionNode.textContent), false, page.sectionNode.textContent);
			assert.equal(page.byClass("wsk-input")[0].value, "1600", "用户输入的自定义宽被冲掉了");
			assert.equal(page.registration.options.label(), "Window size");
			assert.equal(page.timers.every((t) => !t.cleared), true, "刷新定时器还在（没重复建）");
			page.kill();
			assert.equal(page.timers.every((t) => t.cleared), true, "卸载时没清定时器");
			assert.equal(page.unsubscribed(), 1, "语言订阅没解绑");
		} finally { restoreGlobals(); }
	});

	await run("改窗口失败时：提示按当前语言说，原因码渲染成英文；未知码退回宿主原文", async () => {
		const en = await renderSection({
			active: "en", nav: { languages: ["zh-CN"] },
			reply: { ok: false, applied: { ok: false, code: "main_window_not_found", error: "未定位到 DSH 主窗口（标题/窗口类不匹配，或宿主 PID 已变）" } }
		});
		try {
			// 「立即应用当前选择」是那颗 ghost 按钮（wsk-btn 里第一颗是「应用自定义尺寸」）
			en.byClass("ghost")[0].dispatch("click");
			await tick(); await tick();
			const msg = en.byClass("wsk-msg")[0].textContent;
			assert.equal(msg.includes("Apply failed:"), true, msg);
			assert.equal(msg.includes("Could not find the DSH main window"), true, msg);
			assert.equal(CJK.test(msg), false, `英文界面里出现了中文：${msg}`);
		} finally { en.kill(); }
		const weird = await renderSection({
			active: "en", nav: { languages: ["en-US"] },
			reply: { ok: false, applied: { ok: false, code: "brand_new_code_from_the_future", error: "宿主说的一句中文" } }
		});
		try {
			weird.byClass("ghost")[0].dispatch("click");
			await tick(); await tick();
			const msg = weird.byClass("wsk-msg")[0].textContent;
			assert.equal(msg.includes("宿主说的一句中文"), true, msg);
			assert.equal(msg.includes("brand_new_code_from_the_future"), false, "错误码被原样甩给用户了");
		} finally { weird.kill(); restoreGlobals(); }
	});

	// [10] 脱敏：仓库要推 GitHub、也会被 npm pack 打进出口袋，本机账号名 / 工作区绝对路径 /
	// 回环端口 / 凭据样式 / 邮箱 / 机器指纹都不该留在里面。扫描器自带"必须判红"与"必须判绿"
	// 两组对照——先验它自己不放水也不误报，再用它扫本仓库（见 scripts/check-sensitive.mjs）。
	console.log("[10] 脱敏（账号名 / 本机绝对路径 / 本机端口 / 凭据样式 / 邮箱 / 机器指纹）");
	const pii = await import("./check-sensitive.mjs");
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));

	check(`扫描器先验自己：${pii.MUST_CATCH.length} 条敏感样本必须全判红、${pii.MUST_NOT_CATCH.length} 条通用写法必须全判绿`, () => {
		assert.deepEqual(pii.checkMustCatch().map((m) => `${m.rule} <- ${m.line}`), [], "扫描器在放水：有敏感样本判不出来");
		assert.deepEqual(pii.checkMustNotCatch().map((n) => `${n.rule} <- ${n.line}`), [], "扫描器误报：通用写法或标准摘要形状被判成敏感，那样文档没法写");
	});
	check("发布文件与仓库文档零敏感命中", () => {
		const findings = pii.scanPaths([...pii.SHIPPED, ...pii.REPO_ONLY], { root: repoRoot });
		assert.deepEqual(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`), [],
			`发现 ${findings.length} 处敏感内容：\n${findings.map((f) => `  ${f.file}:${f.line} [${f.rule}] ${f.text}`).join("\n")}`);
	});
	check("扫描确实覆盖到发布清单里的每个文件（连扫描器自己也在内），不是扫了个空", () => {
		const report = pii.scanPathsDetailed([...pii.SHIPPED, ...pii.REPO_ONLY], { root: repoRoot });
		assert.ok(report.scanned.length >= 12, `只扫了 ${report.scanned.length} 个文件：${report.scanned.join(", ")}`);
		for (const entry of ["lib/index.js", "lib/client.js", "scripts/selftest.mjs", "scripts/check-sensitive.mjs", "cordis.patch.yml", "package.json", "README.md", "README_zh.md", "CHANGELOG.md", "CHANGELOG.zh-CN.md", "LICENSE"]) {
			assert.ok(report.scanned.includes(entry), `扫描没覆盖到 ${entry}`);
		}
		// 嵌套目录必须真递归：这个扫描器曾经的缺陷就是只展开一层，submission/ 与 .github/workflows/ 整个漏掉
		for (const nested of [".github/workflows/ci.yml", "submission/data/plugins/ecbob__dsh-window-size-keeper.yml"]) {
			if (!fs.existsSync(path.join(repoRoot, nested))) continue; // 开发目录没有仓库专属件
			assert.ok(report.scanned.includes(nested), `嵌套文件没被扫到（递归又退化了）：${nested}`);
		}
	});

	server.close();
	console.log(`\n合计 ${passed} 项通过，失败 ${failures.length} 项`);
	if (failures.length > 0) {
		for (const f of failures) console.log(`FAIL: ${f.label} — ${f.message}`);
		process.exitCode = 1;
	}
	fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
	console.error("自检脚本自身出错：", err);
	process.exitCode = 1;
});
