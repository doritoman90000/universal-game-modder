# Installing Universal Game Modder (for AI agents such as Cline)

Universal Game Modder (UGM) is a local stdio MCP server. It needs Node.js 18+ and nothing else.

## Steps

1. Clone the repository:
   `git clone https://github.com/doritoman90000/universal-game-modder.git`
2. Install dependencies from the repository root (`dist/` is prebuilt; there is nothing to compile):
   `npm install`
3. Register the server with the MCP client. Use the ABSOLUTE path to `dist/index.js` inside the cloned folder. Example MCP settings entry:

```json
{
  "mcpServers": {
    "universal-game-modder": {
      "command": "node",
      "args": ["/absolute/path/to/universal-game-modder/dist/index.js"]
    }
  }
}
```

4. Restart the MCP client. The server announces itself as `universal-game-modder` and lists 100 tools. 29 of them (engine detection, session, and the native binary toolset) run entirely in-process with no configuration. The remaining tools route to optional external backends and return a clear "not configured" error until a path is set in `ugm.config.json`.

## Verify

Ask the agent to call `detect_engine` with `{"game_path": "<a game folder>"}` or `analyze_file_format` with `{"file_path": "<any .exe or .dll>"}`. Both return real data on a fresh install. The full verified call list is in `VERIFICATION.md`; the release gate that produced it is `verify-release.mjs`.

## Notes

- No API keys, no accounts, no network calls. Everything runs on the local machine.
- Optional: a machine-specific `ugm.config.local.json` (git-ignored) holds backend paths; the tracked `ugm.config.json` is placeholders only.
- Read `ACCEPTABLE_USE.md` and `LICENSE-EULA.md` before use. UGM is for modding, interoperability, research and education on software you legally own.
