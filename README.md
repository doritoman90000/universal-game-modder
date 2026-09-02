# Universal Game Modder

**One MCP server to inspect and mod any game — driven by an AI agent.**

Universal Game Modder (UGM) is a local [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI agent (like Claude in Claude Code) hands for game reverse-engineering and modding: it auto-detects a game's engine, then exposes a toolset for analyzing and patching the binaries — all running locally on your own machine, no cloud, no telemetry.

This is the **free open-core edition (v0.1.3)**.

---

## ⚠️ Responsible-use notice

UGM is a general-purpose binary-analysis and interoperability tool. It is meant for **modding, interoperability, security research, and education on software you legally own or are authorized to analyze.** You are responsible for how you use it. Before installing, read [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md) and [`LICENSE-EULA.md`](LICENSE-EULA.md).

---

## What's in the free edition

- **One stdio MCP server** that an agent connects to and drives.
- **Game-engine auto-detection** — point it at a game directory; it identifies Unity (Mono / IL2CPP), Unreal, Godot, Java, and native binaries from file signatures.
- **Native binary analysis + patching toolset** — PE header analysis, hex read/write/search/replace, IDA-style pattern scanning, string extraction, checksums, and binary diffing, running natively in-process (no external tools required).

The guided `game-modder` workflow skill and the delegated decompilation backends land in a later release; this edition is the MCP server + engine detection + the native toolset.

### Not in the free edition (Pro tier)

The web dashboard, the delegated Unity/Unreal/JAR decompilation backends, and native disassembly are part of the **Pro** tier and are **not** included here. The free edition is fully functional on its own for engine detection and native binary work.

---

## Requirements

- **Node.js 18+** (uses ES modules and `better-sqlite3`)
- **[Claude Code](https://claude.com/claude-code)** or any MCP-capable client
- Windows / macOS / Linux (native tools are cross-platform; the smallest cut ships no OS-specific binaries)

---

## Install

```powershell
# from the repo root
./setup.ps1
```

Or manually (`dist/` ships prebuilt; there is nothing to compile in this edition):

```bash
npm install
```

Then register the server with your MCP client. For Claude Code, add to your MCP config:

```json
{
  "mcpServers": {
    "universal-game-modder": {
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

On first run, `ugm.config.json` ships with **empty placeholders** — the free edition needs no external paths. (The Pro delegate backends are where those get filled in.)

### Config resolution

The server reads the first of these that exists and merges it over built-in defaults:

1. the file named by the `UGM_CONFIG` environment variable
2. `ugm.config.local.json` next to `package.json` — your machine-specific paths; keep it out of version control (the repo's `.gitignore` already does)
3. `ugm.config.json` — the tracked file, placeholders only

So you can fill in backend paths without ever editing a file that could end up in a release or a pull request.

---

## Quickstart

Once connected, ask your agent to work through these. **Every example below is executed against a real binary before each release** — see [Verified examples](#verified-examples).

> **Parameter naming:** file-level tools take **`file_path`** (and `file_path_a` / `file_path_b` for comparisons). Game-directory tools take **`game_path`**. Disassembly tools take **`binary_path`**.

**1. Detect what a game is built with:**
```
detect_engine  { "game_path": "C:\\Path\\To\\Game" }
```

**2. Set it as the active target:**
```
load_game  { "game_path": "C:\\Path\\To\\Game" }
```

**3. Analyze a binary:**
```
analyze_file_format  { "file_path": "...\\SomeBinary.dll" }   # magic bytes, managed vs native
analyze_pe_full      { "file_path": "...\\SomeBinary.exe" }   # PE headers, sections, data directories
```

**4. Search and inspect:**
```
extract_strings          { "file_path": "...", "min_length": 8 }
extract_dll_classes      { "file_path": "...", "search_terms": ["Health","Damage"] }
pattern_scan             { "file_path": "...", "pattern": "48 8B ?? ?? ?? ?? ??" }
search_binary_pattern    { "file_path": "...", "patterns": ["maxHealth"] }
```

**5. Patch and verify:**
```
hex_read       { "file_path": "...", "offset": 4096, "length": 64 }
hex_replace    { "file_path": "...", "search_hex": "90 90", "replace_hex": "EB 00" }
calculate_checksums       { "file_path": "..." }              # before/after integrity
compare_binaries_detailed { "file_path_a": "...", "file_path_b": "..." }
```

**6. Disassemble (native, included):**
```
disassemble_function  { "binary_path": "...\\SomeBinary.exe", "rva": 4096 }
disassemble_range     { "binary_path": "...\\SomeBinary.exe", "rva": 4096 }
```

### Full free-edition tool list

These **29 tools run entirely in-process** and need no external backend.

**Native binary tools (19)** — all take `file_path` unless noted:
Detection / PE: `analyze_pe_full`, `analyze_file_format`, `analyze_dll_structure`, `rva_to_offset` (+`rva`), `offset_to_rva` (+`offset`)
Hex: `hex_read` (+`offset`), `hex_write` (+`offset`,`hex_data`), `hex_search` (+`hex_pattern`), `hex_replace` (+`replace_hex`)
Scanning: `pattern_scan` (+`pattern`), `pattern_scan_all` (+`pattern`), `search_binary_pattern` (+`patterns`)
Strings / classes: `extract_strings`, `extract_strings_advanced`, `extract_dll_classes`
Integrity / diff: `calculate_checksums`, `compare_binaries_detailed` (`file_path_a`,`file_path_b`)
Godot: `analyze_godot_pck`
Disassembly: `disassemble_function` (`binary_path`,`rva`)

**Workflow / session tools (10):**
`detect_engine`, `load_game`, `game_status`, `find_steam_games`, `mod_this_game`, `find_gameplay_values`, `build_and_deploy`, `debug_mod`, `scaffold_mod`, `list_available_tools`

### What the server also lists (Pro backends)

For transparency: the server advertises **100 tools total**. The other **64** are the Unity (27), Unreal (11), and Java/JAR (26) decompilation suites, which **route to external Pro-tier backend executables**. They appear in the tool list, but calling one without a configured backend returns a clear error:

```
ERROR: Backend unity-decompiler not configured (missing executable path)
```

That is expected behavior in the free edition, not a defect. Configure their paths in `ugm.config.json` (Pro) to enable them.

### Verified examples

The Quickstart calls above are not aspirational. Each release is gated on a verification pass that executes them against a real PE binary and requires every one to return real data. The v0.1.3 pass (2026-09-02, on the restored release cut) ran the gate's 20 documented calls plus 3 clean-failure checks; results are recorded in [`VERIFICATION.md`](VERIFICATION.md).

---

## License

The UGM code is released under the [MIT License](LICENSE). Use of the tool is additionally governed by [`LICENSE-EULA.md`](LICENSE-EULA.md) and [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md). Third-party components used by the Pro-tier backends are attributed in [`licenses/`](licenses/).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md). Current version: **v0.1.3** — the config can no longer ship machine paths, and the release was
restored and re-verified after a disk incident. v0.1.2 fixed engine detection; v0.1.1 fixed the docs and added the gate.
