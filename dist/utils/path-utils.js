import { basename } from 'path';
/**
 * Normalize a Windows path for consistent handling.
 * Converts forward slashes to backslashes for Windows APIs,
 * but keeps forward slashes for display/internal use.
 */
export function normalizePath(p) {
    return p.replace(/\\/g, '/');
}
/**
 * Convert to Windows-native backslash path for subprocess calls.
 */
export function toWindowsPath(p) {
    return p.replace(/\//g, '\\');
}
/**
 * Extract a human-readable game name from a path.
 * Handles Steam-style paths like "C:/Steam/steamapps/common/GameName"
 */
export function extractGameName(gamePath) {
    const normalized = normalizePath(gamePath).replace(/\/+$/, '');
    return basename(normalized);
}
//# sourceMappingURL=path-utils.js.map