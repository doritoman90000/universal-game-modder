import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../core/config.js';
/**
 * Search configured Steam library paths for installed games.
 */
export function findSteamGames(filter) {
    const config = loadConfig();
    const games = [];
    for (const steamPath of config.steamPaths) {
        if (!existsSync(steamPath))
            continue;
        try {
            const entries = readdirSync(steamPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                if (filter && !entry.name.toLowerCase().includes(filter.toLowerCase()))
                    continue;
                games.push({
                    name: entry.name,
                    path: join(steamPath, entry.name),
                });
            }
        }
        catch {
            // Skip inaccessible directories
        }
    }
    return games.sort((a, b) => a.name.localeCompare(b.name));
}
//# sourceMappingURL=steam-finder.js.map