import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const DEFAULTS = {
    unityDecompilerExe: '',
    unrealAssetExe: '',
    pythonExe: 'python',
    jarEditorScript: '',
    webPort: 7777,
    steamPaths: [],
    modTemplatesDir: '',
};
let cachedConfig = null;
/**
 * Config resolution order (privacy fix, 2026-09-02 -- Gatekeeper finding):
 *   1. $UGM_CONFIG            explicit path, wins outright
 *   2. ugm.config.local.json  developer / machine-specific paths (git-ignored, NEVER shipped)
 *   3. ugm.config.json        the tracked, shippable file -- placeholders only
 *   4. built-in defaults
 * Every loaded file is merged OVER the defaults, so a partial file is fine.
 */
export function loadConfig() {
    if (cachedConfig)
        return cachedConfig;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const projectRoot = resolve(__dirname, '..', '..');
    const candidates = [
        process.env.UGM_CONFIG,
        resolve(projectRoot, 'ugm.config.local.json'),
        resolve(projectRoot, 'ugm.config.json'),
    ].filter((p) => !!p);
    for (const configPath of candidates) {
        if (!existsSync(configPath))
            continue;
        try {
            const raw = readFileSync(configPath, 'utf-8');
            cachedConfig = { ...DEFAULTS, ...JSON.parse(raw) };
            return cachedConfig;
        }
        catch (err) {
            // unreadable / malformed -> try the next candidate
        }
    }
    cachedConfig = { ...DEFAULTS };
    return cachedConfig;
}
//# sourceMappingURL=config.js.map