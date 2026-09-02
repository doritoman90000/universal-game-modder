import { existsSync, readdirSync } from 'fs';
import { join, basename, sep } from 'path';
/**
 * Recursively search for files matching patterns (shallow, max 3 levels deep).
 */
function findFiles(dir, patterns, maxDepth = 3, currentDepth = 0) {
    if (currentDepth >= maxDepth)
        return [];
    const results = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const nameLower = entry.name.toLowerCase();
            if (entry.isFile()) {
                for (const pattern of patterns) {
                    if (nameLower === pattern.toLowerCase() || matchGlob(nameLower, pattern.toLowerCase())) {
                        results.push(fullPath);
                    }
                }
            }
            else if (entry.isDirectory() && !nameLower.startsWith('.')) {
                results.push(...findFiles(fullPath, patterns, maxDepth, currentDepth + 1));
            }
        }
    }
    catch {
        // Permission denied or similar
    }
    return results;
}
function matchGlob(name, pattern) {
    if (pattern.startsWith('*.')) {
        return name.endsWith(pattern.slice(1));
    }
    return name === pattern;
}
function fileExists(dir, name) {
    return existsSync(join(dir, name));
}
/**
 * Find a file anywhere in the directory tree (limited depth).
 */
function findFileAnywhere(dir, name, maxDepth = 4) {
    const results = findFiles(dir, [name], maxDepth);
    return results.length > 0 ? results[0] : null;
}
/**
 * Detect the game engine from a directory path.
 */
export function detectEngine(gamePath) {
    if (!existsSync(gamePath)) {
        return { engine: null, runtime: 'unknown', confidence: 'uncertain', details: `Path does not exist: ${gamePath}` };
    }
    // --- Unity Detection ---
    // Unity is identified by its definitive data markers, NOT by UnityPlayer.dll alone:
    // some Unity builds (older Mono titles, certain packagings) ship without UnityPlayer.dll
    // while still carrying GameAssembly.dll / Assembly-CSharp.dll / a *_Data directory.
    const unityPlayer = findFileAnywhere(gamePath, 'UnityPlayer.dll', 2);
    const gameAssembly = findFileAnywhere(gamePath, 'GameAssembly.dll', 2);
    const globalMetadata = findFileAnywhere(gamePath, 'global-metadata.dat', 4);
    const assemblyCSharp = findFileAnywhere(gamePath, 'Assembly-CSharp.dll', 4);
    // A "*_Data" directory sitting beside the executable is the Unity player layout.
    let unityDataDir = null;
    try {
        for (const entry of readdirSync(gamePath, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.endsWith('_Data')) {
                unityDataDir = join(gamePath, entry.name);
                break;
            }
        }
    }
    catch {
        // Permission denied or similar
    }
    const isUnity = Boolean(unityPlayer || gameAssembly || assemblyCSharp || unityDataDir);
    if (isUnity) {
        // IL2CPP: the native assembly plus its metadata blob.
        if (gameAssembly && globalMetadata) {
            return {
                engine: 'unity-il2cpp',
                runtime: 'IL2CPP',
                confidence: 'verified',
                details: `Unity IL2CPP game. GameAssembly.dll found at ${gameAssembly}`,
                primaryAssembly: gameAssembly,
                metadataPath: globalMetadata,
            };
        }
        // Mono: managed Assembly-CSharp.dll.
        if (assemblyCSharp) {
            return {
                engine: 'unity-mono',
                runtime: 'Mono',
                confidence: 'verified',
                details: `Unity Mono game. Assembly-CSharp.dll found at ${assemblyCSharp}`,
                primaryAssembly: assemblyCSharp,
            };
        }
        // IL2CPP assembly present but metadata not located: still IL2CPP, lower confidence.
        if (gameAssembly) {
            return {
                engine: 'unity-il2cpp',
                runtime: 'IL2CPP',
                confidence: 'inferred',
                details: `Unity IL2CPP game. GameAssembly.dll found at ${gameAssembly}, but global-metadata.dat was not located.`,
                primaryAssembly: gameAssembly,
            };
        }
        // Unity layout confirmed, runtime undetermined.
        return {
            engine: 'unity-mono',
            runtime: 'unknown',
            confidence: 'inferred',
            details: unityPlayer
                ? 'UnityPlayer.dll found but could not locate Assembly-CSharp.dll or GameAssembly.dll'
                : `Unity data directory found at ${unityDataDir}, but could not locate Assembly-CSharp.dll or GameAssembly.dll`,
        };
    }
    // --- Unreal Detection ---
    // Real Unreal titles name their shipping binary "<GameName>-Win64-Shipping.exe"
    // (e.g. Subnautica2-Win64-Shipping.exe), NOT a literal "UE4-/UE5-" prefix, and it lives at
    // <Game>/Binaries/Win64/ -- depth 3 from the install root. Match the pattern, search deep enough.
    const shippingBinaries = findFiles(gamePath, ['*-win64-shipping.exe', '*-win32-shipping.exe', '*-winGDK-shipping.exe'], 4);
    if (shippingBinaries.length > 0) {
        return {
            engine: 'unreal',
            runtime: 'Native',
            confidence: 'verified',
            details: `Unreal Engine game detected via shipping binary ${basename(shippingBinaries[0])}`,
            primaryAssembly: shippingBinaries[0],
        };
    }
    // Content/Paks is the canonical Unreal cooked-content layout.
    const unrealPaksDir = findFiles(gamePath, ['*.pak'], 4).find((f) => f.toLowerCase().split(sep).join('/').includes('content/paks'));
    if (unrealPaksDir) {
        return {
            engine: 'unreal',
            runtime: 'Native',
            confidence: 'verified',
            details: `Unreal Engine game detected via Content/Paks layout (${basename(unrealPaksDir)})`,
            primaryAssembly: unrealPaksDir,
        };
    }
    // Check for Engine/Binaries directory
    if (existsSync(join(gamePath, 'Engine', 'Binaries'))) {
        return {
            engine: 'unreal',
            runtime: 'Native',
            confidence: 'verified',
            details: 'Unreal Engine game detected via Engine/Binaries directory',
        };
    }
    // Check for .pak files (common in Unreal)
    const pakFiles = findFiles(gamePath, ['*.pak'], 3);
    if (pakFiles.length > 0 && !findFileAnywhere(gamePath, 'UnityPlayer.dll', 2)) {
        // Look for additional Unreal markers
        const hasUnrealExe = findFiles(gamePath, ['*.exe'], 2).some(f => {
            const name = basename(f).toLowerCase();
            return name.includes('shipping') || name.includes('ue4') || name.includes('ue5');
        });
        if (hasUnrealExe || existsSync(join(gamePath, 'Engine'))) {
            return {
                engine: 'unreal',
                runtime: 'Native',
                confidence: 'inferred',
                details: `Likely Unreal Engine game. Found ${pakFiles.length} .pak files`,
            };
        }
    }
    // --- Godot Detection ---
    const pckFiles = findFiles(gamePath, ['*.pck'], 2);
    if (pckFiles.length > 0) {
        return {
            engine: 'godot',
            runtime: 'GDScript',
            confidence: 'verified',
            details: `Godot game detected. Found ${pckFiles.length} .pck file(s): ${pckFiles[0]}`,
            primaryAssembly: pckFiles[0],
        };
    }
    // Godot with embedded PCK (no .pck file, but Godot DLLs present)
    const godotDlls = findFiles(gamePath, ['*.dll'], 2).filter(f => {
        const name = basename(f).toLowerCase();
        return name.includes('godot') || name.startsWith('libgd');
    });
    if (godotDlls.length > 0) {
        // Resources are embedded in the exe
        const exeFiles = findFiles(gamePath, ['*.exe'], 1);
        const mainExe = exeFiles.find(f => !basename(f).toLowerCase().includes('crash'));
        return {
            engine: 'godot',
            runtime: 'GDScript (embedded PCK)',
            confidence: 'verified',
            details: `Godot game detected via DLLs: ${godotDlls.map(f => basename(f)).join(', ')}. Resources embedded in executable.`,
            primaryAssembly: mainExe || exeFiles[0],
        };
    }
    // --- Java Detection ---
    const jarFiles = findFiles(gamePath, ['*.jar'], 2);
    if (jarFiles.length > 0) {
        return {
            engine: 'java',
            runtime: 'JVM',
            confidence: 'inferred',
            details: `Java game detected. Found ${jarFiles.length} .jar file(s)`,
            primaryAssembly: jarFiles[0],
        };
    }
    // --- Electron/NW.js Detection ---
    if (fileExists(gamePath, 'electron.exe') || fileExists(gamePath, 'nw.exe')) {
        const runtime = fileExists(gamePath, 'electron.exe') ? 'Electron' : 'NW.js';
        return {
            engine: 'electron',
            runtime,
            confidence: 'verified',
            details: `${runtime}-based game detected`,
        };
    }
    // --- Lua Detection ---
    const luaDlls = findFiles(gamePath, ['lua51.dll', 'lua52.dll', 'lua53.dll', 'lua54.dll'], 2);
    if (luaDlls.length > 0) {
        return {
            engine: 'lua',
            runtime: 'Lua',
            confidence: 'inferred',
            details: `Lua-scripted game detected. Found: ${basename(luaDlls[0])}`,
        };
    }
    // --- Native/Unknown ---
    const exeFiles = findFiles(gamePath, ['*.exe'], 1);
    if (exeFiles.length > 0) {
        return {
            engine: 'native',
            runtime: 'Native',
            confidence: 'uncertain',
            details: `Unknown engine. Found ${exeFiles.length} executable(s). Use analyze_pe_full for deeper inspection.`,
            primaryAssembly: exeFiles[0],
        };
    }
    return {
        engine: null,
        runtime: 'unknown',
        confidence: 'uncertain',
        details: 'Could not detect any known game engine in this directory.',
    };
}
//# sourceMappingURL=engine-detector.js.map