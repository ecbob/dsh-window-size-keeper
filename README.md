# dsh-window-size-keeper

[English](README.md) | [中文](README_zh.md)

Keeps the DSH desktop window the size you left it: host half + a settings-page section, zero external dependencies.

> Changelog: [CHANGELOG.md](CHANGELOG.md) (English) / [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Simplified Chinese) — the two are maintained together.
> The release ledger (`RELEASES.txt`), the publish/submission guide (`PUBLISHING.md`) and the market submission entry (`submission/`) live only in the publish archive directory — see "Two directories on this machine" at the end.

## The problem

DSH desktop (Electron) rebuilds its main window at a fixed default size (1280×820) on every start, so the size you resized to last time is lost. This plugin records the main window's last **outer frame** (title bar and borders included, in physical pixels), restores and centres it on the next start, and adds a **Window size** section to the DSH settings page where you can pick 1920×1080, 1280×720 and other common resolutions, or any custom width×height.

## The “Window size” settings section (added 2026-10-11)

DSH desktop → Settings → **Window size** (the same level as the Plugins and Desk pet sections, `order: 65`). What's in it:

| Control | What it does |
| --- | --- |
| Restore size radio group | "Last size" (default) / 12 common resolutions / "Custom…" |
| Custom width & height inputs | any size (outer frame, physical pixels) via "Apply custom size" |
| Centre on restore switch | centres on the primary work area; off = resize only, position untouched |
| Apply current selection | re-runs one resize with the current selection, changing nothing |
| Current outer frame / next-start size / file paths | status read-out |

**When it takes effect:** immediately — picking a value resizes the main window at once (centring per your setting) and writes it to the settings file, so the next start uses the same size.

About the numbers: every value is the **outer frame** (title bar + borders) in **physical pixels**, identical to what `GetWindowRect` returns. With DPI scaling above 100% the same numbers look smaller than they read (1920×1080 does not fit a 1920-wide screen at 125% scaling and gets clamped to the work area), which is why the list includes `1536×864` (= 1920×1080 at 125% scaling).

## Display language (added 2026-10-19)

All copy in this section is translated; the language is resolved in this order:

| # | Source | Behaviour |
| --- | --- | --- |
| 1 | `language` in patch config (delivered to the page through `GET /state`) | `"zh"` / `"en"` pins the language. Anything unrecognised — including `zh-TW` — is not treated as "pinned Chinese" and falls through |
| 2 | The DSH client's active language (`ctx.locale`, i.e. Settings → General → Language) | follows whatever you selected in DSH, **switching languages takes effect at once** — no reload, no restart, and no rebuild of the section (text already typed into the custom width/height boxes survives the switch) |
| 3 | The plugin's own detection (`navigator` / `Intl`) | used only when the client runtime provides no language service (DSH 0.1.x clients). **Only Simplified Chinese counts as Chinese**: `zh`, `zh-Hans*`, `zh-CN`, `zh-SG`, `zh-MY`; `zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant*` and every other language get English |

The host half does no UI translation. It ships data plus stable machine-readable reasons: failure `code`s (rendered per language by the client), validation `noteCodes`, and both alias spellings of every preset (`label` / `labelEn`). If a preset you defined in patch config has no `labelEn`, it is displayed exactly as you wrote it — your own names are never machine-translated.

Two deliberate choices:

- **`"locale"` is deliberately *not* declared in the client module's `inject`.** Declaring a service the runtime doesn't provide drops this half of the plugin entirely — the section just disappears, without an error. The language service only exists on DSH 0.2 clients, so `ctx.locale` is read optionally and wrapped in try/catch; without it the plugin falls back to rule 3 and nothing else degrades.
- **Unrecognised error codes never reach the user as codes.** Known codes are rendered from the dictionary; an unknown code falls back to whatever text the host supplied, and only if that is missing too does it show a generic failure line.

## How it works

- The host process (DSH host, a child of the Electron main process) **starts watching the main window at `apply` time**: it keeps a resident `powershell.exe` agent that enumerates windows every 40 ms and acts the moment the main window appears. Identification rule: host parent PID + `Chrome_WidgetWin_1` window class + outer-frame area ≥ `earlyMinArea`. While watching, the window is still **hidden** and its title has not become the product name yet, so this stage identifies windows by area (which keeps the 600×700 welcome window and the 720×760 login window out); when two candidates have similar areas it declares "can't tell" and looks again next round — it never guesses.
- **Why that yields "opens at last time's size":** the desktop app creates its main window **hidden → `loadURL` → `show()`** (`createWindow(appPreload, false, true)` and `enterWorkspace` in `lib/main.js`), and Electron only creates it after the host reports `ready`. So there is a window of time where the main window exists but isn't visible, and the agent finishes resizing inside it — the window's very first appearance is already the target size, so the boot animation no longer plays at the wrong resolution. If nothing is found (or `restoreEarly: false`), the plugin falls back to the old `restoreDelayMs` polling path.
- Target size priority: **settings-page selection (`settings.json`) > `preset` in patch config > "last size" (`state.json`)**. Restores via Win32 `SetWindowPos`, centring on the primary work area (`centerOnRestore`, on by default; off = size only), clamped to `[minW,minH]` and to the current work area (a window bigger than the work area is pinned to the top-left). Occasional `SetWindowPos`/PowerShell failures retry up to 3 times (1 s apart); if all fail, the actual size is persisted and retried on next start (self-healing).
- Afterwards the outer frame is sampled on an **adaptive cadence**: `saveIntervalMs` (15 s) while nothing changes; the moment a sample differs from the previous one the next reads move to `activeSampleMs` (1 s) and stay there until `activeTailMs` (10 s) has passed since the last observed change. The next sample is scheduled only after the current one returns, so a slow PowerShell queues instead of stacking up overlapping reads.
- On process exit (`beforeExit`/`exit`) the in-memory cache is flushed synchronously, capturing the "last" size as a backstop - and after a resize that cache is now at most about 1 s stale, not up to 15 s.
- Lifecycle cleanup is registered properly through `ctx.fiber.effect`: unloading the fiber (hot reload / removal) clears timers, **kills the resident agent**, removes the process hooks and flushes state.
- **Hot-reload zombie protection:** every `apply` bumps the generation file `state.json.gen`; the watch loop, the cycle and "apply now" all refuse to write once they notice the generation changed (they belong to a fiber from before the reload), so a stale size can never overwrite the state file.
- **Serialisation:** the start-up restore cycle and the settings page's "apply now" share one `serialize()` queue, so two PowerShell streams never resize the same window concurrently and overwrite each other. Early restore doesn't take that queue (it has a single agent process and re-reads settings before acting), so changing your selection on the settings page can't be stomped back to an old size.
- The decision logic (picking the window, clamping, centring) **stays in pure Node-side functions**; the agent only does Win32. That is why `scripts/selftest.mjs` can verify it offline, plus a run of the agent protocol against a **real `powershell.exe`** with a non-existent handle (`SET` must fail → exactly the check that failures are reported truthfully rather than claimed as done).
- The fallback path still calls Win32 through a short-lived `powershell.exe` (Add-Type P/Invoke), ~300–700 ms each: negligible at the idle 15 s cadence, and during fast sampling that 1 s step is what makes "resize and immediately quit" survive - slow reads queue rather than stack, because the next one is only scheduled once the previous returns.
- Non-Windows platforms: the settings section still appears (you can see the state) but the payload says `supported:false` and no polling/restore runs.
- Note: the app itself enforces a 960 DIP minimum width on the active main window (`setMinimumSize` / resize handlers). Restoring something smaller is clamped by the app, and the state file corrects itself to the actual size on the next poll.

## Sampling cadence and following a manual resize (added 2026-10-20)

- **Cadence is adaptive, not fixed.** Idle: read the outer frame every `saveIntervalMs` (15 s). The moment a sample differs from the previous one (size or position), the next reads switch to `activeSampleMs` (1 s) and keep that pace until `activeTailMs` (10 s) has passed since the last observed change. All three keys accept positive numbers only - 0, negatives and garbage fall back to the defaults, and the floors (1 s idle, 250 ms fast) keep a typo from turning into a 0 ms busy loop.
- **Why it matters:** the state file and the "current outer frame" line on the settings page are only as fresh as the last sample, and the exit hook flushes that same cache. With the old fixed 15 s poll, resizing and immediately restarting DSH lost that resize - the next start went back to the size before it. The adaptive chain bounds the damage to about a second while idle cost stays exactly as before.
- **`followManualResize` (on by default): a manual resize also updates your selection.** When a sample shows the *width or height* changed, the plugin writes `settings.json` itself and the "Restore size" selection becomes `custom` = the size you just made, so the next start uses the size you dragged to and the settings page shows it selected. Only width/height count: moving a window without resizing leaves the selection alone, because `custom` stores a size, not a position.
- **A change the plugin made itself never counts.** Startup restore and "apply now" record the rectangle they set, and the sample that confirms it consumes that record. Without this rule, restoring your `1920x1080 (Full HD)` selection would silently rewrite it into `custom 1920x1080`, and the settings page would look like it had forgotten what you picked.
- Maximising counts as a manual size change: the maximised rectangle is stored as a custom size, and the next start resizes to that size - it does not restore the "maximised" state.
- Set `followManualResize: false` to go back to "only record state": the selection then stays exactly as you set it, and a resize only affects the next start while the selection is "Last size".

## State and settings files

Directory: `~/.dsh/storages/window-size-keeper/`

| File | Written by | Contents |
| --- | --- | --- |
| `state.json` | plugin polling / exit backstop | `{ "version": 1, "width": 1894, "height": 1171, "x": 18, "y": 17, "savedAt": "..." }` (outer frame, physical pixels) |
| `settings.json` | settings page; also written by the plugin itself when it adopts a manual resize (`followManualResize`) | `{ "version": 1, "preset": "1920x1080", "centerOnRestore": true, "custom": { "width": 1600, "height": 1000 }, "updatedAt": "..." }`; `preset` empty = use "last size", `"custom"` = use the `custom` width/height |
| `state.json.gen` | plugin | generation counter (bumped per apply, for hot-reload zombie protection); never maintained by hand |

Both JSON files are written **atomically** (temp file + rename) so a concurrent reader can't catch a half-written file.

Deleting `state.json` resets "last size"; deleting `settings.json` returns the settings page to its default (use "last size").

## HTTP routes (the channel between the settings page and the host)

Prefix `/window-size-keeper/api` (registered through the host's `webServer.register({ kind: "prefix" })`; `webServer` is not in `inject`, so headless setups don't hard-depend on it, and registration retries a bounded number of times if the service arrives late).

| Route | Purpose |
| --- | --- |
| `GET /state` | available resolutions, current selection, most recent window rectangle, bounds, both file paths |
| `POST /select` | `{ preset, custom:{width,height}, centerOnRestore }` → validate + persist + apply at once |
| `POST /apply` | apply the current selection once (resize + centre) |
| `POST /reset` | selection back to "last size" (`preset: ""`) and apply |

Invalid input (unknown `preset` id, custom width/height that aren't positive integers, picking “Custom…” without ever entering a size) is rejected with a reason — never silently applied.

## Configuration (cordis.patch.yml)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch (off also stops registering the settings routes) |
| `saveIntervalMs` | `15000` | idle sampling interval: how often the frame is read while nothing is changing |
| `activeSampleMs` | `1000` | sampling interval while a change is in flight (floor 250 ms) |
| `activeTailMs` | `10000` | how long after the last observed change fast sampling continues |
| `followManualResize` | `true` | when a manual width/height change is sampled, set the "Restore size" selection to `custom` = that size (see the section above) |
| `restoreDelayMs` | `3000` | first-restore delay on the fallback path (only used when `restoreEarly` is off or nothing was found) |
| `restoreEarly` | `true` | early restore: watch from `apply` and fix the size before `show()`. Off restores the pure-polling behaviour |
| `earlyPollMs` | `40` | interval between enumerations inside the agent while watching |
| `earlyBudgetMs` | `10000` | total early-restore budget; on expiry it hands over to `restoreDelayMs` |
| `earlyMinArea` | `900000` | minimum outer-frame area (physical px²) accepted as "the main window" while watching (the main window is always created 1280×820 = 1,049,600) |
| `minW` / `minH` | `520` / `600` | lower size bound (matching the Electron main window minimum) |
| `maxW` / `maxH` | `7680` / `4320` | upper size bound (guards against absurd values) |
| `stateFile` | empty | custom state file path (the settings file lives next to it as `settings.json`) |
| `centerOnRestore` | `true` | centre when restoring (the settings-page switch overrides it) |
| `preset` | empty | selected preset id (empty = "last size"; settings-page selection overrides it) |
| `presets` | built-in 12 | preset list, replacing the built-in list wholesale (see below) |
| `language` | `auto` | display language of the settings section: `auto` follows DSH's language, `zh` / `en` pin it (see Display language) |

> Note: `preset`/`presets` belong to the Cordis patch config and need a **DSH restart** (or a profile reassembly) to take effect; `dev_reload_package` does not re-read patch config. Selections made on the settings page go through `settings.json` and need **no** restart.

### Presets

12 built-in common resolutions (shown in this order):

`1024×768`, `1280×720`, `1366×768`, `1440×900`, `1536×864` (1920 at 125% scaling), `1600×900`, `1920×1080`, `1920×1200`, `2560×1080`, `2560×1440`, `3440×1440`, `3840×2160`

To add or remove entries, put a `presets:` list in `config` of `cordis.patch.yml` (each item `{ id, label, labelEn?, width, height }`), which replaces the built-in list wholesale (example in the trailing comment of `cordis.patch.yml`); the settings-page list follows it. `labelEn` is optional — omit it and that entry shows the same text in both languages.

## Installation / reload

```bash
# normal user: install the published artifact
dsh plugin --profile desktop add "<this repo>/dist/dsh-window-size-keeper-0.1.0.tgz"

# development: hot-assemble (no restart)
dev_install_package  dir=<absolute path of this repo>  profile=desktop
dev_reload_package   dsh-window-size-keeper
```

Uninstall: `dsh plugin --profile desktop remove dsh-window-size-keeper`, or `dev_uninject_plugin dsh-window-size-keeper`.

> What goes into `<profile>`? Usually `desktop` for the desktop app and `web` for the web app, but the name is decided by your machine: `dir %USERPROFILE%\.dsh\profiles` (Linux/macOS: `ls ~/.dsh/profiles`). A wrong name doesn't error — the plugin just lands in a different profile and you won't see it here.

> **After adding or changing `lib/client.js`** (the settings-page half): the client half is loaded by the page, so a profile reassembly (restart the DSH desktop app) plus a page refresh is needed before a new section appears. Changes to the host half (`lib/index.js`) can be hot-reloaded with `dev_reload_package`.

## Offline self-check

```bash
node scripts/selftest.mjs                                    # or npm test
node --check lib/index.js && node --check lib/client.js      # or npm run check
```

`scripts/selftest.mjs` is dependency-free and covers 81 cases in ten groups: the pure functions (centring, clamping, priority, input validation, main-window identification, settings/state read-write), the HTTP routes (fake ctx + real http server + real fetch), the Win32 agent protocol against a real `powershell.exe`, the i18n dictionaries (key parity, identical `{placeholders}`, no untranslated leftovers in the English table, language resolution priority), and rendering the actual section into a fake DOM in both languages — including "switching language must not rebuild the DOM, so the custom width you were typing is still there", and "a dictionary that failed to register never shows an internal key".

Group [10] is a desensitization scan (`scripts/check-sensitive.mjs`, runnable on its own as `npm run scan:sensitive`): it refuses account home directories (`C:\Users\<someone>`, `/home/<someone>`), personal workspace absolute paths, hard-coded loopback ports, credential-shaped strings (`api_key: …`, `ghp_…`, `sk-…`, `AKIA…`), real e-mail addresses and machine fingerprints (SID / machine GUID / hostname) anywhere in the shipped files or the repo-only release docs. It carries its own must-be-red and must-be-green control samples — the scanner prints how many at run time and selftest group [10] enforces both halves — so the gate cannot quietly rot into a rubber stamp; `~/.dsh`, `%USERPROFILE%`, `<workspace>` and `<HOME>` plus SHA-256 digests are deliberately allowed — a ledger that cannot write down a checksum is not much of a ledger.

It points the state and settings files at a temporary directory and **never touches** the real `~/.dsh/storages/window-size-keeper`. The script's parent process is not the DSH host, so `applyNow` inside the routes can't find a main window — which is exactly what proves failures are reported honestly instead of being claimed as done, and no real window gets resized. To verify on the real machine: restart the desktop app and look at Settings → Window size.

## The zero-dependency red line

Node builtins + the system `powershell.exe` only; no runtime dependency is declared. The profile links this directory through pnpm `link:`, and pnpm does not install the linked package's own dependencies; an unresolvable runtime dependency makes the whole Cordis plugin tree throw and DSH cannot start (the 2026-09 incident; the same warning is in `@dsh-pet/bridge`). The client half follows the same rule: it only uses the `react` the client module loader already injects, and no third-party package.

## Two directories on this machine

`<workspace>\dsh-window-size-keeper` is the development directory the desktop profile currently links to; `<workspace>\dsh-window-size-keeper-0.1.0` is the publish archive. `<workspace>` stands for "wherever this checkout lives on your machine" — the repo deliberately records no absolute paths from anyone's machine, and a selftest group enforces that. Both directories carry the same code, README and changelog; only the release ledger, `PUBLISHING.md`, the market submission entry, CI and `.git` exist in the archive.

## License

MIT, see LICENSE.
