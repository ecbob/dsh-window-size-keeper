# Changelog

All notable changes to `dsh-window-size-keeper` are documented in this file.

> 简体中文版：[`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md)

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release ledger (tarball names + SHA-256): `RELEASES.txt` (publish archive directory only).

> **Maintenance rule: every change bumps the version and lands a section here before the
> tarball is packed, and no released tarball is ever deleted. The English and Chinese
> versions of this file are updated together.**

## [0.1.1] - 2026-10-20

Both defects below were found by installing the plugin from the artifact published on GitHub and
using it against a real desktop window. Each one now has an offline nail; the first had been invisible
to all 81 pre-existing checks, because the fake-DOM render never asserted the line that stayed broken.

### Added

- **Adaptive sampling cadence** (`activeSampleMs: 1000`, `activeTailMs: 10000`): the outer frame is read
  every `saveIntervalMs` (15 s) while nothing changes, and the moment a sample differs from the previous
  one the next reads move to 1 s until 10 s has passed since the last observed change. A sample is
  rescheduled only after the previous one returns, so a slow PowerShell queues rather than stacking.
  Before this, resizing and immediately quitting lost that resize: the state file - and the exit hook,
  which flushes the same cache - could be up to 15 s stale, so the next start went back to the size
  from before the drag.
- **`followManualResize` (on by default)**: when a sampled change is judged to be a manual change of
  width/height, the plugin writes `settings.json` itself and the "Restore size" selection becomes
  `custom` = that size, so the next start follows the window you actually dragged to and the settings
  page shows it selected. Only width/height count (moving a window without resizing leaves the selection
  alone), and a rectangle the plugin set itself - start-up restore, "apply now" - never counts: without
  that rule, restoring `1920x1080 (Full HD)` would silently rewrite it into `custom 1920x1080`.
- Self-check group `[5c]`: `nextSampleDelay` and `shouldAdoptManualSize` covered branch by branch
  (boundaries, inverted/zero/negative/garbage config, dirty inputs), plus a `[6]` check that `/state`
  publishes the effective cadence and the switch. Offline checks: 81 -> 88.
- Self-check `[10]` stopped hardcoding "at least 12 files were scanned" - a repository-only file count.
  Coverage was already pinned by the explicit per-file list (all 11 shipped files) plus the recursion
  checks, so the floor is now just "not empty"; running the self-check inside an **installed** package
  (11 files, none of the repo-only ones present) reports 88/88 instead of going red on a number that
  only ever fit the repository layout. A plain user following the README hit exactly that.

### Fixed

- The "current outer frame" line (当前主窗口外框) **never left "Loading…" / "读取中…"** in the settings section -
  a regression from the 2026-10-19
  i18n round that made static text re-render without rebuilding the DOM. That line was registered as a
  `setText(current, "current.loading")` sink, and `applyState` ends with `localizeStatic()`, which
  replays every sink: the size written a moment earlier was overwritten with the loading text on every
  successful poll (every 10 s), so the section looked like a request that never finished even though
  `GET /state` answered 200 in ~1 ms and the console stayed clean. The line is now a sink of its own
  that renders from the latest payload; a new render check asserts it shows the real frame after the
  first refresh, after a timer-driven refresh, and after a language switch replays all sinks.

### Changed

- `saveIntervalMs` now means the **idle** cadence rather than "the only cadence". Its default and the
  value shipped in `cordis.patch.yml` stay `15000`.
- Both READMEs gained a section on cadence and following a manual resize (heading parity between the
  two files is itself a self-check), and the configuration table lists the three new keys.

## [0.1.0] - 2026-10-19

First public release. Nothing was ever published before today, so 0.1.0 is the current state
of the plugin and the development milestones inside it are recorded below, so that the version
number and the history agree. Because no 0.1.0 artifact had ever left this machine (no remote,
no market entry, installed in no profile), the pre-publication work below was folded into 0.1.0
and the tarball re-cut rather than inventing a 0.1.1 — the superseded hash is recorded in
`RELEASES.txt` so the re-cut is traceable.

### Added

- Records the DSH desktop (Electron) main window's last **outer frame** rectangle in physical
  pixels and restores it on the next start, centred on the primary work area — the app itself
  always rebuilds the main window at a fixed 1280×820, so without this your last resize is lost
  on every launch.
- Settings section「窗口大小」/ **Window size** (DSH desktop → Settings, alongside the plugin and
  desk-pet sections, `order: 65`): 12 built-in presets from 1024×768 to 3840×2160 (including
  1536×864 = 1920×1080 at 125% scaling), free-form custom width/height, a "centre on restore"
  switch, and "apply now"; presets can be replaced wholesale via `presets:` in patch config.
  Selection applies immediately and persists.
- Priority order: settings-page choice (`settings.json`) > patch config `preset` > last size
  (`state.json`). Both JSON files are written atomically (temp file + rename) under
  `~/.dsh/storages/window-size-keeper/`.
- Local HTTP routes `/window-size-keeper/api/{state,select,apply,reset}`; invalid input is
  rejected with a reason instead of silently changing settings.
- Lifecycle hygiene: cleanup registered through `ctx.fiber.effect` (kills the resident proxy,
  clears timers, flushes state on unload), a generation file (`state.json.gen`) so a hot-reload
  zombie fiber can never overwrite the state with a stale size, and one `serialize()` queue so
  the startup restore and "apply now" cannot fight over the same window.
- **Bilingual settings-page copy with environment-driven language (2026-10-19).** All UI text
  moved into `zh` / `en` dictionaries in `lib/client.js` and registered with the DSH client's
  locale service (`ctx.locale.register(NS, { zh, en })`). The language is resolved as: explicit
  `language` in patch config → the DSH client's active language (switching it takes effect at
  once, without reload or restart) → the plugin's own `navigator` / `Intl` detection, which
  counts **only Simplified Chinese** as Chinese (`zh`, `zh-Hans*`, `zh-CN`, `zh-SG`, `zh-MY`)
  and gives English to `zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant*` and to everything else.
  Switching language re-renders the text in place instead of rebuilding the DOM, so a custom
  width being typed is not thrown away.
- Host half stays translation-free: failures now carry stable machine-readable `code`s
  (`enum_failed`, `main_window_not_found`, `superseded`, `set_pos_failed`, `windows_only`,
  `no_target`, `bad_json_body`, `unknown_route`, `internal_error`) and validation notes carry
  `noteCodes`, both rendered into the user's language by the client; every built-in preset now
  ships both alias spellings (`label` + `labelEn`). An unrecognised code falls back to the host's
  own text — a code is never shown to a user as-is, and a preset whose `labelEn` you didn't
  provide is displayed exactly as you wrote it rather than machine-translated.
- New patch config key `language` (default `auto`: follow DSH's current language; `zh` / `en` pin
  it). Only `auto` / forced Chinese / forced English are accepted — `zh-TW` and `zh-Hant` are
  deliberately *not* treated as "forced Chinese", and a malformed value falls back to `auto`
  instead of silencing the UI.
- Offline selftest `scripts/selftest.mjs` — **81 cases** covering the pure functions (centring,
  clamping, priority, input validation, main-window identification, settings read/write), the
  HTTP routes against a real http server + real fetch with a fake ctx, the Win32 proxy protocol
  driven by a real `powershell.exe` against a non-existent handle (so a failed `SET` must be
  reported as a failure rather than claimed as done), the i18n dictionaries (key parity between
  `zh` and `en`, identical `{placeholder}` sets, no untranslated CJK leftovers in the English
  table, language-resolution priority table), and **rendering the real section into a fake DOM**
  in both languages — including "switching language must not rebuild the DOM", "the typed custom
  width survives", "the last message is re-rendered in the new language", "the interval timer and
  the locale subscription are released on unload", and "a dictionary that failed to register never shows an internal key like page.title".
- **Desensitization scanner `scripts/check-sensitive.mjs`** (2026-10-19, pre-publication): 9 rules over the shipped files and the repo-only release docs — account home directories (`C:\Users\<someone>`, `/home/<someone>`), personal workspace absolute paths, hard-coded loopback ports, credential-shaped assignments and prefixed keys (`ghp_`, `sk-`, `AKIA`, `xoxb-`, `AIza-`), hex runs of 41–63 characters (40-hex and 64-hex are the shapes of git object ids and SHA-256 digests, so a release ledger can still state checksums), real e-mail addresses, and machine fingerprints (SID / machine GUID / hostname). It ships with must-be-red and must-be-green control samples (the counts are printed by the scanner itself and pinned by selftest group [10]) so it cannot rot into a rubber stamp; it is wired into `npm test`, into selftest group [10] and into its own CI job.
- The same round removed what the scanner had caught: the fake payload paths in `scripts/selftest.mjs` say `<HOME>/…` instead of a real Windows account path, and README / README_zh / RELEASES / PUBLISHING use `<workspace>` / `<工作区>` and `$GIT_PROXY` instead of this machine's absolute workspace path and its proxy port. `ecbob` / `ecbob` stay — a repository URL, a market entry and a copyright line all need an owner.

- **Ownership and naming aligned with the real GitHub account (2026-10-19)**: the repository lives at `ecbob/dsh-window-size-keeper`, so `package.json` (`repository.url`, `author`), the `LICENSE` copyright line, the market submission entry (renamed to `submission/data/plugins/ecbob__dsh-window-size-keeper.yml`, with matching `url:` / `name:`) and every doc reference now say `ecbob`. Commit identity should use `ecbob <ecbob@users.noreply.github.com>` so the commits attach to the account without exposing a personal e-mail address in public history.
- `PUBLISHING.md` documents the SSH route (this machine uses SSH; the local public key has to be added to the account first — without it both port 22 and port 443 answer `Permission denied (publickey)`, measured here) plus the ssh-over-443 fallback and the HTTPS + token alternative.

### Changed during development (same 0.1.0)

- **2026-10-11** — settings section, presets and the priority chain landed.
- **2026-10-16** — early restore: instead of waiting for the app to report `ready`, the plugin
  starts a resident Win32 proxy at `apply` time and fixes the size while the main window is
  still hidden (the desktop app creates it hidden → `loadURL` → `show()`), so the window's very
  first appearance already has the right size and the boot animation no longer plays at the
  wrong resolution. Polling `restoreDelayMs` remains the fallback path. Evidence and reasoning
  are in the workspace report `DSH-BOOT-ANIMATION-REPAIR-2026-10-16.md` (median single
  enumeration round-trip: 29 ms).
- **2026-10-19** — documentation language policy: `README.md` became **English-primary** and
  `README_zh.md` is its Simplified-Chinese counterpart (same structure, same tables, same
  numbers); the package `description` switched to English because GitHub's "About" and the npm
  registry show that single string, while the market submission entry carries `description.en`
  and `description.zh`. `cordis.patch.yml` comments stayed Chinese (its data is unchanged, and it
  is the file the live profile assembles from).

### Not included

No dependencies (Node builtins + system `powershell.exe` only), no telemetry: the plugin never
makes an outbound network request. The English dictionary is deliberately complete — a third
language is not offered, because DSH's own catalog ships exactly `zh` and `en`.
