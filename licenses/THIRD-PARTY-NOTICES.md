# Third-Party Notices

Universal Game Modder uses the following third-party components. This file records their licenses and attribution.

## Runtime dependencies (bundled in the free open-core edition)

The free edition's native tools run in-process via these npm packages (installed by `npm install`, not vendored in this repo):

| Component | Purpose | License |
|-----------|---------|---------|
| @modelcontextprotocol/sdk | MCP protocol implementation | MIT |
| better-sqlite3 | Session state storage | MIT |
| express | Local web server (Pro dashboard) | MIT |
| ws | WebSocket transport (Pro dashboard) | MIT |
| pngjs | PNG handling | MIT |
| texture2ddecoder-wasm | Texture decoding | MIT |

## Pro-tier delegate backends (NOT bundled in this free edition)

The Pro tier delegates to external decompilation/asset engines. Their licenses are recorded here for completeness. **None of these binaries ship in the free open-core edition** — they are separate, user-installed or Pro-bundled components. When bundled in the Pro tier, each engine's own LICENSE and NOTICE file must accompany it.

| Engine | Used by | License | Obligation on redistribution |
|--------|---------|---------|------------------------------|
| ICSharpCode.Decompiler (ILSpy) | Unity Mono/IL2CPP decompilation | MIT | Include MIT license text |
| CUE4Parse / CUE4Parse-Conversion | Unreal asset reading | Apache-2.0 | Include license text + NOTICE, document modifications |
| CFR | Java JAR decompilation | MIT | Include MIT license text |
| Lib.Harmony | Runtime patching (Unreal test path) | MIT / LGPL-2.1 (dual) | Use the MIT path; include license text |

## Known pending item

- **capstone-wasm** (native disassembly binding, from the `disasm-web` monorepo): **license undeclared** at the package level. The underlying Capstone engine is BSD-3, but the wasm wrapper carries no explicit license. Native disassembly is therefore **excluded from any shipped bundle** until this is resolved (confirm the monorepo's LICENSE, swap the binding, or make disassembly an optional user-installed capability). It is not part of the free open-core edition.

---

*Every license listed above is permissive (MIT / Apache-2.0). None imposes a copyleft source-disclosure obligation on Universal Game Modder's own code.*
