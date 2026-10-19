// dsh-window-size-keeper 的脱敏扫描器（零依赖，node 内置模块）。
//
// 为什么要有这个文件：仓库是要推到 GitHub、也要被 npm pack 打进出口袋的。里面只要写死一条
// 本机绝对路径（`C:\Users\<某人>\…`）或粘进一个真密钥，它就跟着仓库出门。这类东西不该靠人
// 自觉，所以钉成一条可跑的机器检查。
//
// 跑法：
//   node scripts/check-sensitive.mjs            # 扫本仓库，有命中就打印并 exit 1
//   node scripts/check-sensitive.mjs --demo     # 打印规则表与命中样本（自我说明）
//   import { scanPaths, RULES } from "./check-sensitive.mjs"   # 给 scripts/selftest.mjs 第 [10] 组引用
//
// 允许出现、不算泄露的写法（都是通用写法，不含个人身份）：
//   `~/.dsh/…`、`$DSH_HOME`、`%USERPROFILE%`、`<工作区>` / `<workspace>`、`<HOME>` 这类占位符，
//   `127.0.0.1` 不带端口（自检里给测试服务器绑的回环地址），`github.com:443` 这种公服标准端口，
//   以及 SHA-256 摘要（含 64 位十六进制）——那本来就是发布台账的内容，含 sha 的行会被识别出来。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * 规则表。每条 = 一个"出现即算敏感"的判据 + 为什么它在乎。
 * 注：规则用字符串拼出来，避免本文件在自查时把"规则自己的写法"误判成命中；
 * 需要拆写的地方用下面的 MARK 拼接，别直接写成一个字面量。
 */
const SL = "[\\\\/]{1,2}"; // 一个或两个斜杠（Windows 与 POSIX 都收）
const DRIVE = "[A-Za-z]:" + SL;

export const RULES = [
	{
		id: "account-home",
		why: "Windows/POSIX 家目录绝对路径里必然带账号名——那是最直接的个人信息",
		pattern: new RegExp("(?:" + DRIVE + "|[\\s'\"`(=:])[/\\\\]{1,2}(?:Users|Home)[\\\\/][^\\\\/\"'\\s)]+", "i")
	},
	{
		id: "personal-workspace",
		why: "个人工作区的绝对路径会暴露本机目录布局（仓库里该写占位符）；Git Bash 的 /e/… 写法也算",
		pattern: new RegExp("(?:" + DRIVE + "|(?:^|[\\s'\"`(])[/\\\\][A-Za-z][/\\\\])[A-Za-z0-9_.-]*(?:workspace|WorkSpace)[A-Za-z0-9_.-]*(?:" + SL + "|$|[^A-Za-z0-9_-])", "i")
	},
	{
		id: "local-port",
		why: "写死的本机回环端口暴露这台机器的服务拓扑与代理出口",
		pattern: /(?:127\.0\.0\.1|0:0:0:0:0:0:0:1|localhost):\d{2,6}/
	},
	{
		id: "credential-word",
		why: "key/secret/password/token 后面紧跟一个 ASCII 真值才算可疑；值写成 … 或 <占位> 算举例，CJK 不参与",
		pattern: /\b(?:api[_\s-]?key|apikey|secret[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|client[_\s-]?secret|app[_\s-]?secret|password|passwd|credential)\s*[:=]\s*(?!…|\.{3}|<)[A-Za-z0-9+/=_.:-]{3,}/i
	},
	{
		id: "token-shape",
		why: "各家平台的 key 都有固定前缀：要么「前缀 + 分隔符 + 长串」（sk-、ghp_、xoxb-、AIza-），要么「前缀 + 全大写定长串」（AKIA/ASIA）。要求分隔符或全大写，是为了不把 skippedXxx 这种普通英文标识符误判成密钥",
		pattern: /\b(?:(?:sk|ghp|gho|ghu|ghs|github_pat|xox[baprs]|AIza|sheets|oauth2)[-_][A-Za-z0-9]{8,}|(?:AKIA|ASIA)[0-9A-Z]{12,})\b/
	},
	{
		id: "opaque-base64",
		why: "大小写混合 + 数字的 32 位以上长串是随机密钥的典型形状（纯 hex 走 digest-hex 规则）；行里带 SHA256:/指纹/fingerprint/ssh-keygen 的算 SSH key 指纹——那由公钥导出，是公开标识符",
		pattern: /\b(?=[A-Za-z0-9+/]{32,}={0,2}\b)(?=[^ ]*[a-z])(?=[^ ]*[A-Z])(?=[^ ]*\d)[A-Za-z0-9+/]{32,}={0,2}\b/
	},
	{
		id: "digest-hex",
		why: "40 位纯十六进制是 git 对象号、64 位是 SHA-256 摘要的标准形状；其它长度的长 hex 串要确认一眼",
		pattern: /\b(?:[0-9a-f]{41,63}|[0-9a-f]{65,})\b/
	},
	{
		id: "email",
		why: "真实邮箱一粘就进公开仓库；占位域名（example.*）、GitHub 的 noreply 地址、以及 git@host 这种 SSH 固定用户名放行——noreply 由公开 handle 推导，SSH 写法的域名末尾紧跟冒号",
		pattern: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z:])/
	},
	{
		id: "machine-id",
		why: "SID / MachineGuid / 主机名这类机器指纹别留在公开仓库里",
		pattern: /\bS-1-5-21-\d+|MachineGuid|MachineId|computer\s*name\s*[:=]\s*\S/i
	}
];

/** 含这些字样的行，长十六进制串算"发布摘要"而不是密钥（台账本来就该钉摘要）。 */
export const SHA_HINT = /sha-?256|sha256|sha1|摘要|digest|checksum|hash|certutil|integrity/i;

/** 含这些字样的行算占位说明，不参与本机路径判定（`<工作区>` 之类的写法本身就带尖括号）。 */
export const PLACEHOLDER_HINT = /<[^\s>]{1,24}>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%USERPROFILE%|\$DSH_HOME|~/;

/**
 * 一行的命中判定。占位符与摘要行按规则豁免，避免"为了过关把文档写成乱码"。
 * @param line 待判定的行
 * @param rule 规则
 */
export function lineHits(line, rule) {
	const match = rule.pattern.exec(line);
	if (!match) return null;
	if (rule.id === "opaque-base64" && /(?:SHA(?:256|512):|指纹|fingerprint|ssh-keygen|publickey)/i.test(line)) return null; // SSH key 指纹由公钥导出，是公开标识符，不是秘密
	if (rule.id === "email") {
		// git@github.com 这类是 SSH 协议的固定用户名，不是邮箱；个人邮箱的 local 部分不会是 git
		const at = match[0].indexOf("@");
		if (at > 0 && match[0].slice(0, at).toLowerCase() === "git") return null;
	}
	if (rule.id === "long-opaque" && SHA_HINT.test(line)) return null;
	if ((rule.id === "account-home" || rule.id === "personal-workspace" || rule.id === "local-port") && PLACEHOLDER_HINT.test(line)) return null;
	return match[0];
}

/**
 * 扫若干文件（目录会递归，跳过 .git / node_modules / dist / __pycache__ 与二进制）。
 * @param targets 相对或绝对路径列表
 * @param options.root 相对路径的基准目录（默认 process.cwd()）
 * @returns 命中清单 [{file, rule, line, sample, text}]
 */
export function scanPathsDetailed(targets, options = {}) {
	const root = options.root ? path.resolve(options.root) : process.cwd();
	const files = [];
	const scanned = [];
	let skippedBinary = 0;
	const SKIP_DIRS = new Set([".git", "node_modules", "dist", "__pycache__", ".scratch"]);
	const walk = (abs) => {
		let entries;
		try {
			entries = fs.readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = path.join(abs, entry.name);
			if (entry.isDirectory()) {
				// 必须递归：只展开一层会把 submission/ 与 .github/workflows/ 这类嵌套文件整个漏掉
				if (!SKIP_DIRS.has(entry.name)) walk(child);
				continue;
			}
			if (entry.isFile()) files.push(child);
		}
	};
	for (const target of targets) {
		const abs = path.isAbsolute(target) ? target : path.join(root, target);
		if (!fs.existsSync(abs)) continue; // 开发目录没有发布台账，缺了不算错
		if (fs.statSync(abs).isDirectory()) walk(abs);
		else files.push(abs);
	}
	const findings = [];
	for (const abs of files) {
		let raw;
		try {
			raw = fs.readFileSync(abs);
		} catch {
			continue;
		}
		const rel = path.relative(root, abs).replace(/\\/g, "/");
		if (raw.includes(0)) {
			skippedBinary += 1; // 二进制（图标之类）不在本检查范围
			continue;
		}
		scanned.push(rel);
		const text = raw.toString("utf8");
		const self = rel === "scripts/check-sensitive.mjs";
		text.split(/\r?\n/).forEach((line, index) => {
			// 规则表与反向对照样本都写在判据自己的源码里：那些字面量是判据，不是泄露
			if (self && /(?:id:|pattern|new RegExp|why:|rule:)/.test(line)) return;
			for (const rule of RULES) {
				const hit = lineHits(line, rule);
				if (hit) findings.push({ file: rel, rule: rule.id, line: index + 1, sample: hit, text: line.trim().slice(0, 160) });
			}
		});
	}
	return { findings, scanned, skippedBinary };
}

/** 只要命中清单时的简写。 */
export function scanPaths(targets, options = {}) {
	return scanPathsDetailed(targets, options).findings;
}

/** 本仓库要扫的东西：发布用的文件（package.json files[] 那份口径）+ 只存在于仓库的发布文档。 */
export const SHIPPED = ["lib", "scripts", "cordis.patch.yml", "package.json", "README.md", "README_zh.md", "CHANGELOG.md", "CHANGELOG.zh-CN.md", "LICENSE"];
export const REPO_ONLY = ["RELEASES.txt", "PUBLISHING.md", "submission", ".github", ".gitignore", ".gitattributes"];

/**
 * 演示/自检用的反向对照：这些样本必须被判红。
 * 少了这一段，扫描器很容易变成"永远通过的空把戏"。
 */
export const MUST_CATCH = [
	{ line: `stateFile: "C:/Users/zhangsan/.dsh/storages/window-size-keeper/state.json"`, rule: "account-home" },
	{ line: "link 目标在 `/home/zhangsan/.dsh/storages/window-size-keeper`", rule: "account-home" },
	{ line: "开发目录 `D:\\\\My_WorkSpace\\\\dsh-window-size-keeper` 是 link 目标", rule: "personal-workspace" },
	{ line: "cd /e/My_WorkSpace/dsh-window-size-keeper-0.1.0", rule: "personal-workspace" },
	{ line: "git -c http.proxy=http://127.0.0.1:7890 push -u origin main", rule: "local-port" },
	{ line: "接口开在 localhost:19387 上", rule: "local-port" },
	{ line: "api_key: 3f9c1a2b7d8e4f5a6b7c8d9e", rule: "credential-word" },
	{ line: "password = hunter22222", rule: "credential-word" },
	{ line: "token = ghp_A1b2C3d4E5f6G7h8I9j0", rule: "token-shape" },
	{ line: "用 AKIA1B2C3D4E5F6G7H8I 这把 key 复现", rule: "token-shape" },
	{ line: "key 4f8a2c6e9b1d3f5a7c2e9b4d6f1a8c3e5b7d2f9a4c6e8b1d", rule: "digest-hex" },
	{ line: "secret 3f9C1a2B7d8E4f5A6b7C8d9E0f1A2b3C4d5E6f7A8b9C0d1E", rule: "opaque-base64" },
	{ line: "随机串 7hVjUILVjaRL+YfjFbqJMxMbYp1KrViEXSHqDiOBFJY 出现在配置里就要确认", rule: "opaque-base64" },
	{ line: "投稿说明里别直接写 zhangsan@company-mail.cn", rule: "email" },
	{ line: "MachineGuid 从注册表读出来对照", rule: "machine-id" },
	{ line: "域内 SID S-1-5-21-1234567890-123456789-123456789-1001", rule: "machine-id" }
];

/** 这些写法是通用写法或标准摘要形状，必须判绿——否则文档根本没法写。 */
export const MUST_NOT_CATCH = [
	`stateFile: "<HOME>/.dsh/storages/window-size-keeper/state.json"`,
	"目录：`~/.dsh/storages/window-size-keeper/`",
	"`%USERPROFILE%\\\\.dsh\\\\profiles\\\\desktop\\\\package.json`",
	"开发目录 `<工作区>\\\\dsh-window-size-keeper` 是 link 目标",
	"archive: `<workspace>/dsh-window-size-keeper-0.1.0` 是发布副本",
	"SHA-256 `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` 摘要一致",
	"git 对象号 `0123456789abcdef0123456789abcdef01234567` 对得上",
	"台账里的 16 位前缀 `c23cc38c132000f2` 也够用",
	"server.listen(0, \"127.0.0.1\", resolve)",
	"const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;",
	"`github.com:443` 被阻断时走本地代理",
	"export GIT_PROXY=\"http://127.0.0.1:<端口>\"",
	"邮箱占位写法 you@example.com 不算泄露",
	"提交身份写成 ecbob <ecbob@users.noreply.github.com> 也不算个人邮箱",
	"SSH 写法 git@github.com:ecbob/dsh-window-size-keeper.git 不是邮箱",
	"命令 `ssh -T git@github.com` 里的 git@github.com 也不是邮箱",
	"SSH key 指纹 `SHA256:7hVjUILVjaRL+YfjFbqJMxMbYp1KrViEXSHqDiOBFJY` 由公钥导出，算公开标识符",
	"npm run check 里是 node --check",
	"文档里写 `api_key: …` 与 `password = <占位>` 都算举例，不是凭据",
	"临时目录前缀是 wsk-selftest-，它不是密钥",
	"跳过的二进制计数变量叫 skippedBinary，不是 sk- 开头的 key",
	"窗口类名 Chrome_WidgetWin_1 与凭据无关"
];

/**
 * 反向对照检查：每条样本都要被它声明的规则命中。
 * @returns 没命中的样本列表（空数组 = 扫描器不是空把戏）
 */
export function checkMustCatch() {
	const misses = [];
	for (const sample of MUST_CATCH) {
		const hit = RULES.some((rule) => rule.id === sample.rule && lineHits(sample.line, rule));
		if (!hit) misses.push(sample);
	}
	return misses;
}

/**
 * 形状对照检查：通用写法与标准摘要形状不许被误判。
 * @returns 被误判的 {line, rule, hit} 列表（空数组 = 文档写得下去）
 */
export function checkMustNotCatch() {
	const falsePositives = [];
	for (const line of MUST_NOT_CATCH) {
		for (const rule of RULES) {
			const hit = lineHits(line, rule);
			if (hit) {
				falsePositives.push({ line, rule: rule.id, hit });
				break;
			}
		}
	}
	return falsePositives;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const demo = process.argv.includes("--demo");
	if (demo) {
		for (const rule of RULES) console.log(`[${rule.id}] ${rule.why}`);
		console.log("\n反向对照（每条都必须命中自己的规则）：");
		for (const sample of MUST_CATCH) console.log(`  ${(lineHits(sample.line, RULES.find((r) => r.id === sample.rule)) ?? "MISS").padEnd(28)} ${sample.rule} <- ${sample.line.slice(0, 60)}`);
	}
	const findings = scanPaths([...SHIPPED, ...REPO_ONLY]);
	const misses = checkMustCatch();
	const noise = checkMustNotCatch();
	console.log(`扫描器：${RULES.length} 条规则；反向对照 ${MUST_CATCH.length - misses.length}/${MUST_CATCH.length} 判红、通用写法 ${MUST_NOT_CATCH.length - noise.length}/${MUST_NOT_CATCH.length} 判绿`);
	if (misses.length) {
		for (const m of misses) console.log(`  该判红却漏了：规则 ${m.rule} <- ${m.line}`);
		process.exitCode = 1;
	}
	if (noise.length) {
		for (const n of noise) console.log(`  该判绿却误报：规则 ${n.rule} <- ${n.line.slice(0, 70)}`);
		process.exitCode = 1;
	}
	if (findings.length) {
		console.log(`脱敏检查：${findings.length} 处需要处理`);
		for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.rule}] ${f.text}`);
		if (!process.exitCode) process.exitCode = 1;
	} else if (!process.exitCode) {
		console.log("脱敏检查：通过（发布文件与仓库文档里没有账号家目录、个人工作区路径、本机端口、凭据样式、邮箱与机器指纹）");
	}
}
