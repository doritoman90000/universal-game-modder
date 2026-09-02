# Verification record — v0.1.3

Every call documented in [`README.md`](README.md) is executed against a real binary before
release. This file records the most recent run. If a documented call does not return real
data, the build does not ship.

**Run the gate yourself:**

```bash
node verify-release.mjs
```

It exits non-zero if any documented tool errors, times out, or returns data it cannot
recognize. Point it at a different binary with `UGM_VERIFY_TARGET=/path/to/binary`.

---

## Last run

- **Date:** 2026-09-02
- **Version:** 0.1.3
- **Environment:** the restored release cut, run in place after the 2026-08-31 disk incident. Dependencies resolved from the sibling dev tree's `node_modules` (not a cold install this run; the v0.1.2 cold-install result below still stands for the unchanged tool code).
- **Config:** shipped `ugm.config.json` -- all backend paths empty, exactly as a buyer receives it. Loader order is new in 0.1.3: `UGM_CONFIG` > `ugm.config.local.json` > `ugm.config.json` > defaults.
- **Target binary:** `C:\Windows\System32\notepad.exe`
- **Result:** **PASS** -- 20/20 documented free-edition tools returned real data; 3/3 Pro-backend tools failed cleanly

Additional checks this run:

| Check | Result |
|---|---|
| Server boots over stdio | `universal-game-modder` 0.1.3, 100 tools listed |
| Zero-filled (disk-incident) files in the release tree | 0 remaining; 31 zeroed `.map` / `.d.ts` files purged (not needed to run) |
| Personal or machine paths anywhere in the release tree | none (scan for username, e-mail, `C:\projects`) |
| Tracked config files carry machine paths | no (`ugm.config.json` here and in the dev tree) |
| Docs and gate script | restored from session records; LICENSE, EULA and AUP rewritten to the same terms |

## Previous run (v0.1.2, 2026-08-25)

- **Date:** 2026-08-25
- **Version:** 0.1.2
- **Environment:** clean install (fresh `npm install`, no dev tree on the module path)
- **Config:** shipped `ugm.config.json` — all backend paths empty, exactly as a buyer receives it
- **Target binary:** `C:\Windows\System32\notepad.exe` (x64 PE, 200,704 bytes)
- **Result:** **PASS** — 20/20 documented free-edition tools returned real data; 3/3 Pro-backend tools failed cleanly

### Free-edition tools verified (20/20)

| Tool | Verified result |
|---|---|
| `analyze_file_format` | Identified PE, x64, unmanaged, 7 sections |
| `analyze_pe_full` | Returned headers, architecture, and data directories |
| `analyze_dll_structure` | Returned section count and structure |
| `calculate_checksums` | Real MD5 / SHA1 / SHA256 (sha256 `da5807bb…d7c5b`) |
| `hex_read` | Returned the `4d 5a` (MZ) header at offset 0 |
| `hex_search` | Located the MZ pattern |
| `pattern_scan` | 7 matches for `4D 5A` with byte context |
| `pattern_scan_all` | Whole-file scan returned matches |
| `extract_strings` | 645 strings extracted |
| `extract_strings_advanced` | Filtered extraction returned data |
| `extract_dll_classes` | Targeted name search returned data |
| `search_binary_pattern` | Text pattern search returned data |
| `compare_binaries_detailed` | Byte-level comparison completed |
| `rva_to_offset` | RVA `0x1000` → file offset `0x400`, section `.text` |
| `offset_to_rva` | Reverse mapping completed |
| `disassemble_function` | 34 instructions, terminated on `ret` (capstone 5.0) |
| `disassemble_range` | 60 instructions from `.text` |
| `game_status` | Session state returned |
| `list_available_tools` | Tool inventory returned |
| `find_steam_games` | Library scan completed |

### Pro-backend tools fail cleanly (3/3)

With no backend configured, these return a clear, actionable error rather than hanging or
crashing:

| Tool | Result |
|---|---|
| `decompile_type` | `ERROR: Backend unity-decompiler not configured (missing executable path)` |
| `open_game` | `ERROR: Backend unreal-assets not configured (missing executable path)` |
| `jar_open` | `ERROR: Backend jar-editor not configured (missing script path)` |

---

## What this run fixed

Three defects were found by building this gate and are corrected in v0.1.1:

1. **Every Quickstart example in the v0.1.0 README was wrong.** The docs told buyers to pass
   `path`; every tool requires `file_path` (or `file_path_a`/`file_path_b`, `binary_path`,
   `game_path`). All 9 documented calls failed with
   `The "path" argument must be of type string… Received undefined`. Documentation is now
   generated against the real schemas and executed by this gate.

2. **The server reported the wrong version.** It announced `1.0.0` in the MCP handshake while
   the package and changelog said `0.1.0`, making it impossible to tell which build a buyer
   was running. Now consistent.

3. **`jar_open` failed opaquely.** Its backend command defaults to `python` (never empty), so
   the "is it configured?" check passed and the process spawned and died with
   `MCP error -32000: Connection closed`. It now reports a missing script path like the other
   backends.

## Known limits

- Verification runs against a Windows PE binary. Cross-platform ELF/Mach-O paths are
  supported by the code but are not covered by this gate.
- The Pro-tier Unity, Unreal, and Java backends are not exercised here; this gate proves only
  that they refuse cleanly when absent.
- `disassemble_function` / `disassemble_range` depend on `capstone-wasm`, whose license is
  still being confirmed upstream. They are verified working but may move tiers.

---

## Engine detection (added v0.1.2)

Detection is verified against authentic engine directory layouts, not only against a stock
PE binary. Prior to v0.1.2 this was never tested and two of the three advertised engines
were misidentified.

| Layout | Expected | v0.1.1 | v0.1.2 |
|---|---|---|---|
| Unity Mono (`*_Data/Managed/Assembly-CSharp.dll`) | `unity-mono` | `native` | `unity-mono` (verified) |
| Unity IL2CPP (`GameAssembly.dll` + `global-metadata.dat`) | `unity-il2cpp` | `native` | `unity-il2cpp` (verified) |
| Unreal (`<Game>-Win64-Shipping.exe` + `Content/Paks`) | `unreal` | `null` | `unreal` (verified) |
| Godot (`*.pck`) | `godot` | `godot` | `godot` (verified) |

Real-library sweep across 34 installed Steam directories: **13 detected, up from 9, with zero
regressions and zero crashes.** Directories still reporting uncertainty are installs stripped
of game content (mod scaffolds with the game uninstalled, empty `Paks`) — the detector
correctly declines to guess rather than reporting a false engine.
