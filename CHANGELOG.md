# Changelog

All notable changes to Universal Game Modder are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## [0.1.4] - 2026-09-02

Packaging release for npm and the official MCP Registry. No tool behavior changes.

### Added
- `bin` entry so `npx universal-game-modder` starts the server; `#!/usr/bin/env node` on `dist/index.js`.
- `mcpName`, `repository`, `homepage`, `bugs`, `keywords` and `files` in `package.json`.
- `server.json` (MCP Registry manifest, schema 2025-12-11) and `llms-install.md` (agent-facing install steps).

## [0.1.3] - 2026-09-02

Privacy + recovery release. No tool behavior changes.

### Fixed
- **Machine-specific paths can no longer ship in the config.** The loader now resolves
  `$UGM_CONFIG` (explicit path) -> `ugm.config.local.json` (developer/machine paths,
  git-ignored, never in a release) -> `ugm.config.json` (the tracked file, placeholders
  only) -> built-in defaults, merging each file over the defaults. This closes the
  Gatekeeper privacy finding that had blocked a clean ship since 2026-06-17.

### Recovered
- On 2026-08-31 a TRIM incident zeroed this release's README, CHANGELOG, VERIFICATION,
  LICENSE, EULA, acceptable-use policy, package.json, lock file and gate script, plus
  21 of 39 TypeScript source files. The compiled `dist/` survived byte-intact. Docs and
  the gate were restored from session records; LICENSE, EULA and AUP were rewritten to
  the same terms. The full release gate was re-run on the restored cut (see
  `VERIFICATION.md`). The TypeScript rebuild is a v0.2 task, not a ship blocker.

## [0.1.2] - 2026-08-25

Engine-detection correctness release. v0.1.1 passed its tool gate but misidentified two of
the three major engines it advertises; detection is now verified against real engine layouts.

### Fixed
- **Unreal Engine games were not detected at all.** Detection looked for files literally named
  `UE4-Win64-Shipping.exe` / `UE5-Win64-Shipping.exe`, but shipped Unreal titles name that
  binary `<GameName>-Win64-Shipping.exe` (e.g. `Subnautica2-Win64-Shipping.exe`), so the
  marker never matched a real game. The search was also capped at depth 2 while the binary
  lives at `<Game>/Binaries/Win64/` (depth 3), and the `.pak` fallback required a
  `shipping`-named exe at that same too-shallow depth. A standard Unreal install returned
  `null` — no engine, not even `native`. Detection now globs `*-Win64-Shipping.exe`
  (plus Win32/WinGDK variants) to depth 4 and recognizes the `Content/Paks` layout.
- **Unity games without `UnityPlayer.dll` were reported as `native`.** All Unity detection
  was gated behind `UnityPlayer.dll`; if it was absent, `Assembly-CSharp.dll`,
  `GameAssembly.dll`, `global-metadata.dat` and the `*_Data` directory were never
  examined. Unity is now identified by any of its definitive markers, and an IL2CPP build
  whose metadata cannot be located is reported as `unity-il2cpp` (inferred) rather than
  falling through.

### Verified
- Engine detection: 4/4 on authentic Unity Mono / Unity IL2CPP / Unreal / Godot layouts
  (was 1/4).
- Real Steam library sweep: 13/34 directories detected, up from 9/34, with **zero regressions**
  — every previously-detected title resolves identically — and zero crashes. The remaining
  undetected directories are installs stripped of game content (mod scaffolds, empty
  `Paks`), which correctly report uncertainty rather than guessing.
- Full release gate re-run from a true cold install: 20/20 free-edition tools returning real
  data, 3/3 Pro backends failing cleanly.

## [0.1.1] - 2026-07-27

Correctness and honesty release. v0.1.0 shipped documentation that did not match the code;
every documented call is now executed by a release gate before shipping.

### Fixed
- **Every Quickstart example in the README was wrong.** The docs told users to pass `path`,
  but the tools require `file_path` (or `file_path_a`/`file_path_b`, `binary_path`,
  `game_path`). All 9 documented calls failed with
  `The "path" argument must be of type string… Received undefined`. Anyone copying the
  README verbatim hit an immediate error. Documentation now matches the real schemas.
- **The server announced the wrong version.** It reported `1.0.0` in the MCP handshake while
  the package and changelog said `0.1.0`. The version is now read from `package.json`, so it
  cannot drift again — and the release gate fails the build if it does.
- **`jar_open` failed opaquely.** Its backend command defaults to `python` (never empty), so
  the configuration check passed, the process spawned, and it died with
  `MCP error -32000: Connection closed`. Unconfigured backends now report a missing script
  path, matching the Unity and Unreal backends.

### Added
- **`verify-release.mjs`** — a pre-ship gate that executes every README-documented
  free-edition tool against a real binary, asserts each returns recognizable data, and
  confirms Pro-tier tools fail cleanly rather than hanging. Non-zero exit blocks a release.
  Run it yourself: `node verify-release.mjs`.
- **`VERIFICATION.md`** — the recorded result of the latest gate run, including the exact
  binary analyzed and what each tool returned.

### Changed
- The README now states the honest tool inventory: **29 tools run standalone** (19 native +
  10 workflow) out of the **100** the server lists. The other 64 route to Pro-tier backends
  and say so explicitly, rather than appearing to be included.
- **Native disassembly is documented as included**, not Pro-deferred — `disassemble_function`
  and `disassemble_range` work in-process via capstone 5.0 and are verified. (The
  `capstone-wasm` license is still being confirmed upstream; these may move tiers.)

## [0.1.0] - 2026-07-12

First public open-core release.

### Included (free edition)
- Stdio MCP server that an AI agent connects to and drives.
- Game-engine auto-detection (`detect_engine`, `load_game`) — Unity Mono/IL2CPP, Unreal, Godot, Java, native.
- Native binary analysis + patching toolset (19 in-process tools): PE analysis, hex read/write/search/replace, pattern scanning, string/class extraction, checksums, binary diffing, Godot PCK analysis. *(v0.1.0 said 22; the verified count is 19 — corrected in 0.1.1.)*
- MIT license + buyer-responsibility EULA + Acceptable Use Policy + third-party attribution.
- Ships from a scrubbed release set (no personal machine paths; empty-placeholder config).

### Deferred to a later release
- The `game-modder` guided-workflow skill (needs portable template resolution before shipping).

### Not included (deferred to Pro tier)
- Local web dashboard (port 7777).
- Delegated Unity/Unreal/JAR decompilation backends.
- Native disassembly (pending `capstone-wasm` license resolution).

[0.1.0]: first release
