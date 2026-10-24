# 发布现状与投稿清单

**一句话：代码、自检与门禁都已就绪；没做的只有"在 GitHub 建仓 + push"和"往市场数据源仓库提投稿 PR"。**

## 零、本机状态（重要）

本目录是**发布用归档副本**，而桌面端 profile 装的**不是本目录**，是打包产物：

```
%USERPROFILE%\.dsh\profiles\desktop\package.json
  "dsh-window-size-keeper": "file:../../.plugin-sources/dsh-window-size-keeper-<版本>.tgz"
%USERPROFILE%\.dsh\.plugin-sources\dsh-window-size-keeper-<版本>.tgz   <- npm pack 的产物复制到这儿
```

所以改本目录的 `lib/*.js` **不再影响运行时**（profile 吃的是快照）。让改动生效的正式路线：
`npm pack` -> 复制到 `.plugin-sources` -> `dsh plugin --profile desktop add "<绝对路径 tgz>"` -> 重启
桌面端。调试期想跳过打包可以临时退回 `link:<工作区>\dsh-window-size-keeper`（改回 link 也要重启桌面端；
而且客户端那一半是页面加载的，热重载只换宿主侧那一半，页面还得刷新一次）。

2026-10-20 实机撞出来的三条本机口径，别再按旧文档做：

- `dsh plugin` 的每条**写**操作都要带 `--config.minimum-release-age=0`。bundled pnpm 11 的发布年龄闸门
  （24 小时）会在 lockfile 复核阶段拒 `dshmarket@1.66.43`，而 `minimumReleaseAgeExclude` 在 `remove`
  那条复核路径上不被认——这是 profile 里那批 npm registry 依赖的事，与本插件无关。顺手加
  `--prefer-offline` 能躲开 registry 抖动：本机一次 `add` 就是这么失败的（三条 `UND_ERR_DESTROYED`
  重试用尽，失败的安装会被回滚成"已卸未装"）。
- spec 必须传**绝对路径**。写成 `file:../../.plugin-sources/x.tgz` 会被解析成"某盘根下的
  `.plugin-sources\x.tgz`"直接 ENOENT。传绝对路径能装成功，但 pnpm 会把 manifest 的依赖行与 lock 的
  `specifier:` 都写成绝对形式，与 profile 里另外三条 sibling 的相对写法不一致，得手改归一（就这两处；
  `version:` 与 `resolution.tarball` pnpm 自己写出来就是相对的）。
- 卸掉 `link:` 依赖之后，**必须核实 `node_modules` 里的条目真物理消失**再装新的。本机 `pnpm remove`
  报过成功却把目录链接留在原地，随后 `add` 撞 `ERR_PNPM_EPERM`（rename），那次中途失败还把开发目录的
  `.git` 削残（只剩 `objects/` + `refs/` + `packed-refs`，`HEAD`/`config`/`index` 全没），靠
  `git init` + `symbolic-ref` + `git reset` 复原：内容零损失，永久丢掉的是 reflog 与原有 `.git/config`。

## 一、四道自动闸门逐条核对

市场数据源仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `scripts/check-submission.mjs`：

| # | 要求 | 本仓库状态 |
| --- | --- | --- |
| 1 | 仓库内**任意** `package.json` 声明 `dsh.bundle`（只声明 `dsh.client` 会被直接拒） | ✅ `dsh.bundle.patch = ./cordis.patch.yml`，另含 `dsh.client`（CI 里有一条 job 专门钉这个） |
| 2 | 仓库存在满 1 天（≥24 h） | ⏳ 建仓当天会红一次，之后自动转绿；不需要重提、重推或关掉重开 |
| 3 | 仓库存在、未归档、非 fork | ✅ 要新建的独立仓库 |
| 4 | 不是 DSH 本体 | ✅ |

投稿文件已按市场数据格式备好，原样复制即可：

```
submission/data/plugins/ecbob__dsh-window-size-keeper.yml
```

文件名规则：`owner/repo` → `owner__repo.yml`。名字冲突已核过：`plugins.json`（2026-10-19 拉取，
5945 条）里没有 `dsh-window-size-keeper` 这个条目，也没有描述相近的窗口尺寸类插件。`category`
取自市场在用的 23 个分类之一（`ui`）。

## 二、建仓与 push（本机走 SSH）

```bash
cd <工作区>/dsh-window-size-keeper-0.1.0
# 空仓库已在 GitHub 建好：ecbob/dsh-window-size-keeper（建仓时不要勾自动生成 README，否则首推会撞）
git remote add origin git@github.com:ecbob/dsh-window-size-keeper.git
git push -u origin main
```

> **本机走 SSH 的前提**：GitHub 账号里必须加着**本机实际会被递出去的那把**公钥（→ Settings → SSH and
> GPG keys → New SSH key）。2026-10-20 实测的本机真实状况：真正认的是 `~/.ssh/id_ed25519_github_ecbob`，
> 而且它是**账号级 key、不是仓库的 Deploy Key** —— 公钥逐字出现在 `api.github.com/users/ecbob/keys` 的
> 清单里（这个端点只列账号 key），所以对该账号有权限的每个仓库都有效，不是只钉某一个仓库。默认名的
> `id_ed25519` 递出去被拒过（GitHub 回 "Key is already in use"，它另有用途）；key 没递对时 22 端口与
> 443 端口都回 `Permission denied (publickey)`（本机两种都实测过）。
>
> **`~/.ssh/config` 已钉好身份（2026-10-20 写入）**：`Host github.com` + `IdentityFile` 指那把专用私钥
> + `IdentitiesOnly yes`。实测不带任何 `-i` 或 `GIT_SSH_COMMAND` 时，`ssh -T git@github.com` 回
> `Hi ecbob!`、仓库里裸 `git ls-remote origin` 读得到远程 ref —— 所以 `git push` 与 pnpm 的 `github:`
> 短写法（它展开成 `git+ssh`，同样吃这份 config）都直接可用。22 端口被网络拦时再补
> `Hostname ssh.github.com` + `Port 443` 两行。
>
> 备用路线是 HTTPS + 个人访问令牌（GitHub 从 2021 年起不接受账号密码推 HTTPS）：
> `git remote add origin https://github.com/ecbob/dsh-window-size-keeper.git` 然后 `git push -u origin main`。
> 网络口径以实测为准：2026-10-19 本机实测 `github.com` 的 git-http 端点与 `api.github.com` **直连与走本机本地
> 代理（`export GIT_PROXY="http://127.0.0.1:<端口>"`，端口自己填，仓库里刻意不写死）都是 200**——早先记录的
> "`github.com:443` 被 SNI 级阻断、HTTPS 必须带代理"已不适用当前网络状态，`-c http.proxy="$GIT_PROXY"` 备着即可。
>
> 首次建仓时的提交身份写法：`git -c user.name=ecbob -c user.email=ecbob@users.noreply.github.com …`
> ——GitHub 的 noreply 地址让你 commit 挂在你的账号下，又不把个人邮箱暴露在公开历史里。
>
> 本机实测过的两条坑（都踩过一次）：① `GIT_SSH_COMMAND` 只作用于 git 自己调起的那个 ssh，
> 你直接跑 `ssh -T git@github.com` 不会带上 `-i`，拿它"验证 key 加没加上"会误判成没加上；
> ② 要多把 key 里指定一把，得写 `-i <私钥路径> -o IdentitiesOnly=yes`；Git Bash 的 `/c/Users/…`
> 与 Windows 的 `<盘符>:\Users\<账号>\…` 两种路径写法，本机 OpenSSH_10.5p1 都收（实测都能认证）。

## 三、装到 profile（两种）

```bash
# A. 装产物（发布口径）
dsh plugin --profile desktop add "<本目录>/dist/dsh-window-size-keeper-0.1.0.tgz"

# B. 开发期热装配（改代码调试）——注意这会 link 到本目录而不是开发目录
dev_install_package  dir=<本目录绝对路径>  profile=desktop
dev_reload_package   dsh-window-size-keeper
```

> **改了 `lib/client.js`（设置页分区）必须重启桌面端 + 刷新页面**：客户端半个插件由页面加载，
> 热重载不会补上新分区。只改 `lib/index.js` 可以 `dev_reload_package`。

## 四、发布前自检清单

- [x] `npm run check` — `lib/index.js` / `lib/client.js` / `scripts/selftest.mjs` 语法过
- [x] `node scripts/selftest.mjs` — **99 项**离线自检全绿：第 [7] 组真 powershell 代理协议、
      第 [7b] 组本机现编的 Win32 助手（选路纯函数 + 真编真跑的握手/`--get`/`--set`/常驻协议 +
      "助手起不来必须退回 powershell"）、
      第 [8] 组文案 i18n（中英词典各 60 条 key 对齐、`{占位符}` 一致、英文表无中日韩残留、
      语言判定优先级全分支、两份 README 章节结构一一对应）、
      第 [9] 组假 DOM 真渲染（英文一遍、中文一遍、无语言服务两遍、词典注册失败也不甩 key、切语言不重建 DOM）
- [x] `npm pack --pack-destination dist` → 11 个文件（下面这组数字是 0.1.1 那次的记录，每版的数字看
      `RELEASES.txt`）：75,239 B、
      SHA-256 `e6ca432cec5ddd98273f3a7a2e07e78527423e9534de826632a2c34838bf09de`；
      产物逐文件摘要 == 工作副本摘要（11/11），逐条记在 `RELEASES.txt`
- [x] 开发目录与本归档目录的 11 个共有文件逐字节相同（这几轮都是「两边都改」）
- [x] 脱敏：仓库里不再写死任何人本机的账号家目录、工作区绝对路径与本机代理端口（占位写法见下）
- [x] owner 与署名统一为 `ecbob`（包、LICENSE、投稿条目文件名与字段、文档一致）；仓库已在 GitHub 建好，待推送
- [x] `npm run scan:sensitive` — 脱敏扫描通过（9 条规则；扫描器自身的「必须判红 / 必须判绿」两组对照全通过（条数运行时自报）；递归覆盖，归档目录实扫 17 个文件）
- [x] CI：Windows × Node 20/22 跑 check + selftest；Ubuntu 跑 check；一条 job 钉 `dsh.bundle` 与零依赖；一条 job 专跑脱敏扫描
- [x] 建仓与 push：`main` = `5b33b7f`、注解 tag `v0.1.0` 已推（远程 refs 实测见 `RELEASES.txt`）
- [x] GitHub Release `v0.1.0`（id 417597383）+ 附件 `dsh-window-size-keeper-0.1.0.tgz`（75,239 B；
      下载回来复算 SHA-256 与本地一致）；[x] 仓库已确认 Public（匿名 API 与 git-http refs 都是 200）
- [ ] Actions 首跑结果（网页看）；提市场投稿 PR（还多一道"仓库满 1 天"的硬门槛）；用完撤销令牌
- [ ] 浏览器里的真机视觉确认：本机 Edge / Chrome 的 headless 被活动会话挡住（stdout 空、
      `--screenshot` 不落盘），所以第 [9] 组只能走假 DOM；要看真的得开桌面端

自检**能证明**：判断与数学（挑窗口、夹取、居中、优先级、输入校验、状态/设置文件读写）正确、
HTTP 路由对非法输入如实拒绝、代理协议失败如实回报、双语词典完整且对齐、语言判定按
"配置 > DSH 当前语言 > 浏览器（只有简体中文算中文）"落地、切语言不丢掉用户正在输入的内容。
自检**不能证明**：真机窗口真的被改成目标尺寸（要重启桌面端看「设置 → 窗口大小」的
"当前外框尺寸 / 下次启动将用"）；以及 DSH 自己的语言开关在这台机器上是否已经把界面切成英文
（那是宿主的事，本插件只是跟随）。

> 一个容易混的点：**新代码**要生效得 profile 重组（重启桌面端）+ 刷新页面——客户端半个插件是页面
> 加载的，`dev_reload_package` 只换宿主侧那一半。但**代码进去之后**，切语言是立即生效的，
> 不需要再重启：那是 DSH 的 locale 服务在推（第 [9] 组里那条订阅就是验这个）。

## 五、逐项回滚

| 改动 | 回滚办法 |
| --- | --- |
| 插件安装 | `dsh plugin --profile desktop remove dsh-window-size-keeper`，或把 profile 的 link 指回开发目录 |
| 恢复的尺寸 | 删 `~/.dsh/storages/window-size-keeper/state.json`（重置"上次尺寸"） |
| 设置页选择 | 删 `~/.dsh/storages/window-size-keeper/settings.json`（回到"用上次尺寸"） |
| 本归档目录 | 直接删：它是复制出来的副本，开发目录与 profile 的 link 都没被改动 |
## 六、本地 GitHub 令牌与 Release 工具（2026-10-20 新增）

`git push` 推得动代码与 tag，**推不出 Release**：Release 是 GitHub 的 API 对象加一次附件上传，而 tarball
本来就不进版本库（`dist/` 被忽略，`files` 白名单里也没它）。本机既没有 `gh` CLI 也没有现成令牌，于是
加两个**只在本地存在**的辅助脚本 —— 目录被 `.gitignore` 挡着，不进版本库、不进包、也不在脱敏清单里：

| 脚本 | 干什么 | 取令牌的顺序 |
| --- | --- | --- |
| `.github_tools/get-token.sh` | 弄到一个可用令牌落到本地 temp 文件，并校验（`GET /user` 必须 200 且 login 对得上，回报 scope） | ① temp 里已有且能用就复用；② 问 git 的凭据助手（Windows 上是 GCM：对 `https://github.com` 跑 `git credential fill`，**首次可能弹一次浏览器登录**，脚本不能替你点；之后缓进 Windows 凭据管理器，本机就能静默取到）；③ 都不行就照脚本尾部提示把令牌粘进 temp 文件 |
| `.github_tools/release.sh` | 按 `package.json` 的版本建或复用 Release、上传 `dist/<name>-<version>.tgz`，再把 GitHub 那份**下载回来复算 SHA-256**，另与 GitHub 回报的 `asset.digests.sha256` 比一次 | 两道复算都过才 `exit 0`；对不上就 `exit 1`，不许当成已完成（可反复跑：已有 Release 就复用，附件同大小就跳过上传） |

三条硬规矩（都为"别把秘密泄露出去"服务）：

1. **令牌值永不打印** —— 脚本最多报长度与前缀类型（`ghp_`、`github_pat_` 这类前缀本身不是秘密）。
2. **令牌不进版本库、不进对话** —— 落盘位置 `.github_token_temp/token.txt`（写前 `umask 077`、写后
   `chmod 600`）。临时交给会话用就写进这个文件再说一声，用完删掉。
3. **调 API 用 `curl -K <0600 临时配置>`，不用 `-H`** —— `-H "Authorization: Bearer <令牌>"` 把令牌放进了
   curl 自己的**进程命令行**，同机其它进程读得到；`-K` 从文件里读没这件事。

4. **令牌用完即删（2026-10-20 定的准则，脚本自己执行，不靠人记）** —— `release.sh` 在附件上传完并
   复算完之后立刻删掉 `.github_token_temp/token.txt`，不留存；要再发一版就重跑 `get-token.sh`（本机实测
   GCM 会静默再给一份，不必重新登录）。在上传之前就失败的早退路径**留着**文件，免得白取一次。这条只管
   本地：GitHub 那侧的撤销（Settings → SSH and GPG keys / Applications）仍然另算，删文件不等于撤令牌。

**为什么这两处不会被脱敏闸门绊红（别乱改）**：扫描器 `scripts/check-sensitive.mjs` 的扫描目标是一条条
**显式清单**（`SHIPPED` + `REPO_ONLY`）配自己的 `SKIP_DIRS`，**不是仓库根**，也不听 `.gitignore`。这两个
目录都不在清单里所以不被扫。实测口径：往这两处各塞一份 `ghp_` 形状的文件再跑 `npm run scan:sensitive`
-> 零命中，`npm test` -> 88/88。**别把它们加进 `REPO_ONLY`** —— 那会把真令牌照 `token-shape` 判红，而
`check-sensitive.mjs` 是**随包文件**，为它改扫描器就得重切 tarball、挪 tag。

顺带钉住的一条实测事实：

- `.gitignore` 不在 `files` 白名单里、也不在 npm 的强制打包清单里：加完这几行重打一次包，tarball 摘要
  与台账记的**逐字符相同**，`tar tzf` 里也搜不到这些名字 —— 所以改 `.gitignore` 不需要重切版本。

用之前要知道的两件事：Release 的标题与正文写在 `release.sh` 顶部两行（或用同名环境变量覆盖），**别写
本机绝对路径或账号名** —— 台账与文档都在脱敏清单里，写了就红；附件名必须是 `<name>-<version>.tgz`，
README 里"普通用户装产物"那条路认的就是这个名字。

实测补充（2026-10-20 建 `v0.1.1` 那次撞出来的，别再照直觉做）：

- **附件的 `content_type` 事后改不了**：`PATCH /repos/<owner>/<repo>/releases/assets/<id>` 只收 `name`
  （和 `label`），带上 `content_type` 直接 422，原文是 `"content_type" is not a permitted key`。口径只能
  从上传那一步写对 —— 上传时**只发一个** `Content-Type: application/gzip`。`release.sh` 原先把默认的
  `application/json` 与调用方给的头并排发出，GitHub 取了第一个，附件就被记成 `application/json`（而
  0.1.0 那颗是 `application/gzip`），只能删掉重传（`DELETE` 回 204，再 `POST` 回 201）。
- **GitHub 这个视角不回报 release 附件的 `digests`**：`v0.1.0` 与 `v0.1.1` 两颗都是 `None`（匿名与带
  鉴权都一样）。所以脚本把它判成"不适用"而不是 FAIL；真正算得出的一道是把附件**下载回来复算
  SHA-256**，与本地包逐字符相同才允许说"挂上去的就是本地那个包"。
- **别用 `bash -x` 跑这两个脚本**：`-x` 会把 `TOKEN=` 与那几条 `printf` 的实参原样写进 trace，令牌本体
  就在里面。要调试就把 trace 落在被忽略的 work 目录里并当场删掉（本次就是这么做的）。
- 一次跑完该核对的东西（`v0.1.1` 的实际结果）：Release 与附件的 id 都从 API 回读；`state=uploaded`、
  `content_type=application/gzip`、`size` 与本地包一致；从 `browser_download_url` 下载回来 86,164 B、
  SHA-256 与本地包一致；`/releases/latest` 已指向 `v0.1.1`；CI 五个 job 全绿（`selftest-windows (20)`、
  `selftest-windows (22)`、`syntax-linux`、`desensitization`、`manifest`）。
