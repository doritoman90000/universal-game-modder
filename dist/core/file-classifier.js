import { statSync } from 'fs';
import { basename, extname } from 'path';
const SOURCE_TOOL = 'file-classifier';
/* ----------------------------------------------------------------------------
 * Extension tables. Lowercase, no leading dot. Order of evaluation in classifyFile:
 *   binary -> data_store -> asset (containers) -> asset (typed) -> asset (other)
 * -------------------------------------------------------------------------- */
const BINARY_EXTS = new Set(['exe', 'dll', 'so', 'dylib', 'a', 'lib', 'bin']);
/** Container archives — catalogued AS containers, never walked/expanded (A7). */
const CONTAINER_EXTS = new Set(['pak', 'pck', 'bundle', 'assets', 'unity3d', 'resource', 'ress', 'asset', 'rpf']);
const TEXTURE_EXTS = new Set(['png', 'dds', 'astc', 'ktx', 'ktx2', 'tga', 'jpg', 'jpeg', 'bmp', 'psd', 'exr', 'hdr', 'webp', 'gif', 'pvr']);
const MESH_EXTS = new Set(['fbx', 'obj', 'gltf', 'glb', 'mesh', 'dae', '3ds', 'blend', 'ply', 'stl']);
const AUDIO_EXTS = new Set(['wav', 'ogg', 'mp3', 'bank', 'fsb', 'flac', 'aiff', 'aif', 'wem', 'xnb', 'm4a', 'opus']);
const SHADER_EXTS = new Set(['shader', 'glsl', 'hlsl', 'cg', 'cginc', 'spv', 'vert', 'frag', 'comp', 'gdshader', 'shadergraph']);
const LEVEL_EXTS = new Set(['umap', 'tscn', 'scn', 'level', 'map', 'world', 'tmx', 'unity']);
const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2', 'fnt', 'fon']);
/** Configuration / save / data stores. */
const JSON_EXTS = new Set(['json', 'json5', 'jsonc']);
const INI_EXTS = new Set(['ini', 'cfg', 'conf', 'toml', 'yaml', 'yml', 'properties']);
const SQLITE_EXTS = new Set(['sqlite', 'sqlite3', 'db', 'db3', 's3db']);
const BLOB_EXTS = new Set(['dat', 'save', 'sav', 'bin', 'blob', 'pref', 'prefs', 'profile', 'slot']);
/**
 * Files we deliberately SKIP — pure documentation/source/noise that is not a binary,
 * asset, or data store the autopsy cares about. Kept narrow on purpose: when in doubt
 * we catalogue as asset/type='other' (A3), we do NOT skip.
 */
const SKIP_EXTS = new Set(['txt', 'md', 'log', 'pdb', 'mdb', 'rtf', 'html', 'htm', 'url', 'lnk', 'cs', 'manifest']);
/* ----------------------------------------------------------------------------
 * Helpers — pure string heuristics over the filename.
 * -------------------------------------------------------------------------- */
/** Lowercased extension with no leading dot. '' when there is no extension. */
function ext(absPath) {
    const e = extname(absPath).toLowerCase();
    return e.startsWith('.') ? e.slice(1) : e;
}
/** Map a binary extension to the schema's binary.kind. Defaults non-exe natives to 'so'. */
function binaryKind(extension) {
    if (extension === 'exe')
        return 'exe';
    if (extension === 'dll')
        return 'dll';
    // .so/.dylib/.a/.lib/.bin native artifacts collapse to the schema's 'so' bucket.
    return 'so';
}
/** Cheap arch hint from the filename. Returns undefined when nothing is implied. */
function archHint(nameLower) {
    if (nameLower.includes('win64') || nameLower.includes('x64') || nameLower.includes('amd64') || nameLower.includes('x86_64'))
        return 'x64';
    if (nameLower.includes('arm64') || nameLower.includes('aarch64'))
        return 'arm64';
    if (nameLower.includes('win32') || nameLower.includes('x86') || nameLower.includes('i386'))
        return 'x86';
    return undefined;
}
/**
 * Heuristic managed-vs-native guess WITHOUT reading the CLR header (PR-1 scope).
 * .NET managed assemblies in game installs are overwhelmingly the well-known names below,
 * or live under a Managed/ directory. Native engine DLLs (UnityPlayer, GameAssembly,
 * d3d*, etc.) are not managed. This is a guess; caller stamps provenance='inferred'.
 */
function guessManaged(absPath, nameLower, extension) {
    // Only .dll / .exe can be managed CLR images in practice.
    if (extension !== 'dll' && extension !== 'exe')
        return false;
    const pathLower = absPath.toLowerCase().replace(/\\/g, '/');
    // Known-native engine binaries are never managed.
    const knownNative = [
        'unityplayer', 'gameassembly', 'mono-2.0', 'mono-2_0', 'monobdwgc',
        'd3d', 'd3dcompiler', 'xinput', 'openvr', 'openal', 'steam_api',
        'sdl2', 'libcrypto', 'libssl', 'vcruntime', 'msvcp', 'msvcr',
        'concrt', 'ucrtbase', 'cri_', 'fmod', 'wwise', 'physx', 'nvtt',
    ];
    if (knownNative.some((n) => nameLower.includes(n)))
        return false;
    // Anything under a Mono Managed/ directory is a managed assembly.
    if (pathLower.includes('/managed/'))
        return true;
    // Canonical Unity-Mono managed assemblies.
    const knownManaged = [
        'assembly-csharp', 'assembly-unityscript', 'mscorlib', 'system.',
        'unityengine', 'unity.', 'netstandard', 'mono.security', 'mono.cecil',
        'newtonsoft.json', 'protobuf', 'bepinex', 'harmony', '0harmony',
    ];
    if (knownManaged.some((n) => nameLower.includes(n)))
        return true;
    // .NET app exes commonly ship a same-named .deps.json/.runtimeconfig.json beside them,
    // but we don't probe siblings here. Conservative default: native.
    return false;
}
/**
 * Heuristic role for a binary: game-logic | shell | engine | lib | adsdk.
 * Pure name-based; provenance='inferred'.
 */
function guessRole(nameLower, managed) {
    // Ad / analytics SDKs first — these are the noisiest false-"game-logic" sources.
    const adMarkers = [
        'admob', 'admost', 'applovin', 'unityads', 'ironsource', 'vungle',
        'chartboost', 'tapjoy', 'adcolony', 'mopub', 'inmobi', 'facebook.ads',
        'firebase', 'gameanalytics', 'appsflyer', 'adjust', 'mintegral',
        'fyber', 'pangle', 'bytedance', 'analytics', 'crashlytics', 'sentry',
    ];
    if (adMarkers.some((n) => nameLower.includes(n)) || /(^|[^a-z])ad(s|sdk)?([^a-z]|$)/.test(nameLower)) {
        return 'adsdk';
    }
    // Engine runtime binaries.
    const engineMarkers = [
        'unityplayer', 'gameassembly', 'mono-2.0', 'mono-2_0', 'godot', 'libgodot',
        'd3d', 'd3dcompiler', 'dxgi', 'vulkan', 'opengl', 'openvr', 'openal',
        'fmod', 'wwise', 'physx', 'sdl2', 'glfw', 'bink', 'cri_', 'ue4', 'ue5',
    ];
    if (engineMarkers.some((n) => nameLower.includes(n)))
        return 'engine';
    // The primary game-logic assembly.
    const gameLogicMarkers = ['assembly-csharp', 'gameassembly', 'assembly-unityscript'];
    if (gameLogicMarkers.some((n) => nameLower.includes(n)))
        return 'game-logic';
    // Managed shell (the thin UWP/.NET launcher wrapping native logic, e.g. HCR's managed shell).
    if (managed && (nameLower.includes('launcher') || nameLower.includes('bootstrap') || nameLower.includes('shell'))) {
        return 'shell';
    }
    // Generic runtime/support libraries.
    const libMarkers = [
        'vcruntime', 'msvcp', 'msvcr', 'ucrtbase', 'concrt', 'mscorlib', 'system.',
        'netstandard', 'newtonsoft', 'protobuf', 'libcrypto', 'libssl', 'zlib',
        'lua', 'sqlite', 'icu', 'freetype', 'mono.', 'unity.', 'unityengine.',
    ];
    if (libMarkers.some((n) => nameLower.includes(n)))
        return 'lib';
    // A managed assembly we couldn't otherwise place is most likely game logic.
    if (managed)
        return 'game-logic';
    // An unplaced native binary is most likely a support library.
    return 'lib';
}
/**
 * A7 hard-edge heuristic: does this filename smell like an unreadable / possibly-encrypted
 * managed binary (IL2CPP "garbage", obfuscated metadata, packed shell)? This is a NAME-level
 * signal only — the walker that actually fails to read the bytes is the authoritative source.
 * Returns true so classifyFile can stamp provenance='uncertain' + the standard note.
 */
function looksUnreadableManaged(nameLower) {
    // global-metadata.dat is IL2CPP's metadata blob — it is NOT a managed assembly we can
    // decompile (KB 920f537e). It is handled as a data_store blob elsewhere, but if it ever
    // reaches the binary path we flag it.
    return (nameLower.includes('global-metadata') ||
        nameLower.includes('il2cpp') ||
        nameLower.endsWith('.dll.enc') ||
        nameLower.endsWith('.dll.bytes'));
}
/** data_store.scope guess from path location. Pure path heuristic; provenance='inferred'. */
function guessScope(absPath, nameLower) {
    const pathLower = absPath.toLowerCase().replace(/\\/g, '/');
    // Roaming / per-user appdata locations.
    if (pathLower.includes('/appdata/roaming/') ||
        pathLower.includes('/appdata/local/') ||
        pathLower.includes('/appdata/locallow/') ||
        pathLower.includes('/saved/savegames/') ||
        pathLower.includes('/userdata/')) {
        return 'roaming';
    }
    // Save artifacts by name/dir.
    if (nameLower.includes('save') ||
        nameLower.includes('.sav') ||
        nameLower.includes('profile') ||
        nameLower.includes('slot') ||
        nameLower.includes('progress') ||
        pathLower.includes('/saves/') ||
        pathLower.includes('/savegames/')) {
        return 'save';
    }
    // Everything else co-located with the install is config.
    return 'config';
}
/** data_store.kind guess from extension + name. */
function guessDataStoreKind(extension, nameLower) {
    if (JSON_EXTS.has(extension))
        return 'json';
    if (INI_EXTS.has(extension))
        return 'ini';
    if (SQLITE_EXTS.has(extension))
        return 'sqlite';
    // Windows registry hive (e.g. HCR's settings.dat 512KB hive — KB) tends to be a .dat
    // named like a settings/registry store. We can't confirm without reading magic bytes,
    // so this stays 'binary-blob' unless the name strongly implies a hive.
    if ((extension === 'dat' || extension === '') && (nameLower.includes('settings') || nameLower.includes('registry'))) {
        return 'registry-hive';
    }
    return 'binary-blob';
}
function readSize(absPath) {
    try {
        const st = statSync(absPath);
        return { size: st.size, verified: true };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { verified: false, note: `size unreadable (${msg})` };
    }
}
/** Compose a final notes string, dropping empty fragments. */
function joinNotes(...parts) {
    return parts.filter((p) => !!p && p.trim().length > 0).join('; ');
}
/**
 * Resolve overall provenance for a classification.
 *  - Classification itself is heuristic => baseline 'inferred'.
 *  - If we genuinely could not read the file (statSync failed) OR it smells
 *    unreadable/encrypted => 'uncertain'.
 * Note: the SIZE fact, when read, is 'verified', but the row's *classification*
 * provenance reflects the weakest fact, which is the heuristic itself.
 */
function resolveProvenance(unreadable) {
    return unreadable ? 'uncertain' : 'inferred';
}
/* ----------------------------------------------------------------------------
 * The classifier.
 * -------------------------------------------------------------------------- */
/**
 * Classify a single file by absolute path. Pure aside from one optional statSync (size).
 * NEVER throws — every failure path degrades to a note + provenance, satisfying A3 & A7.
 *
 * @param absPath absolute path to a file inside the game install.
 * @returns a discriminated FileClassification; switch on `.target`.
 */
export function classifyFile(absPath) {
    // Defensive: a malformed/empty path is skipped rather than throwing.
    if (!absPath || typeof absPath !== 'string') {
        return {
            target: 'skip',
            reason: 'empty or invalid path provided to classifyFile',
            note: 'empty or invalid path provided to classifyFile',
            provenance: 'uncertain',
            source_tool: SOURCE_TOOL,
        };
    }
    const name = basename(absPath);
    const nameLower = name.toLowerCase();
    const extension = ext(absPath);
    const sizeRead = readSize(absPath);
    const sizeNote = sizeRead.note; // undefined unless statSync failed
    const unreadable = !sizeRead.verified;
    /* -------------------- BINARY -------------------- */
    if (BINARY_EXTS.has(extension)) {
        const kind = binaryKind(extension);
        const managed = guessManaged(absPath, nameLower, extension);
        const role = guessRole(nameLower, managed);
        const arch = archHint(nameLower);
        // A7 hard edge: managed binary that looks encrypted/garbage OR that we couldn't read.
        const smellsUnreadable = looksUnreadableManaged(nameLower);
        if (smellsUnreadable || (managed && unreadable)) {
            const notes = joinNotes('unreadable/possibly-encrypted metadata', sizeNote);
            return {
                target: 'binary',
                kind,
                managed: true, // A7: classify as managed even though we can't confirm contents
                role,
                arch,
                size: sizeRead.size,
                notes,
                note: notes,
                provenance: 'uncertain',
                source_tool: SOURCE_TOOL,
                reason: smellsUnreadable
                    ? `${name} matches an IL2CPP/encrypted-metadata signature; catalogued as managed+unreadable, not expanded`
                    : `${name} is a managed binary whose bytes could not be read; catalogued as managed+unreadable`,
            };
        }
        const notes = joinNotes(managed ? 'managed-guess by name/path heuristic (CLR header not read in PR-1)' : 'native-guess by name/path heuristic', sizeNote);
        return {
            target: 'binary',
            kind,
            managed,
            role,
            arch,
            size: sizeRead.size,
            notes,
            note: notes,
            // The managed flag is a heuristic; size (if read) is verified, but the row's
            // classification rests on the heuristic => 'inferred' (or 'uncertain' if unreadable).
            provenance: resolveProvenance(unreadable),
            source_tool: SOURCE_TOOL,
            reason: `extension .${extension} -> binary kind=${kind}, role=${role}, managed=${managed} (name/path heuristic)`,
        };
    }
    /* -------------------- CONTAINERS (catalogue, never expand) — A7 -------------------- */
    // Checked BEFORE generic data_store/asset so a .pck/.pak/.bundle is flagged as a container
    // asset and is never walked as Unity content (KB b0175341).
    if (CONTAINER_EXTS.has(extension)) {
        const notes = joinNotes(`CONTAINER (.${extension}) catalogued as container, NOT expanded in PR-1`, sizeNote);
        return {
            target: 'asset',
            type: 'other',
            assetType: 'other',
            format: extension,
            decoded: false,
            isContainer: true,
            size: sizeRead.size,
            notes,
            note: notes,
            provenance: resolveProvenance(unreadable),
            source_tool: SOURCE_TOOL,
            reason: `.${extension} is a known container/archive format; catalogued as a container (decoded=false), expansion deferred to P1.2`,
        };
    }
    /* -------------------- DATA_STORE -------------------- */
    if (JSON_EXTS.has(extension) ||
        INI_EXTS.has(extension) ||
        SQLITE_EXTS.has(extension) ||
        BLOB_EXTS.has(extension)) {
        const kind = guessDataStoreKind(extension, nameLower);
        const scope = guessScope(absPath, nameLower);
        const notes = joinNotes(`data store kind=${kind}, scope=${scope} (name/path heuristic; contents not parsed in PR-1)`, sizeNote);
        return {
            target: 'data_store',
            kind,
            storeKind: kind,
            scope,
            schema_known: false,
            size: sizeRead.size,
            notes,
            note: notes,
            provenance: resolveProvenance(unreadable),
            source_tool: SOURCE_TOOL,
            reason: `extension .${extension} -> data_store kind=${kind}, scope=${scope}`,
        };
    }
    /* -------------------- TYPED ASSETS -------------------- */
    const assetType = assetTypeFor(extension);
    if (assetType) {
        const notes = joinNotes(`asset type=${assetType} by extension`, sizeNote);
        return {
            target: 'asset',
            type: assetType,
            assetType,
            format: extension,
            decoded: false,
            isContainer: false,
            size: sizeRead.size,
            notes,
            note: notes,
            provenance: resolveProvenance(unreadable),
            source_tool: SOURCE_TOOL,
            reason: `extension .${extension} -> asset type=${assetType}`,
        };
    }
    /* -------------------- SKIP (documentation / source / noise) -------------------- */
    if (SKIP_EXTS.has(extension)) {
        const reason = `extension .${extension} is documentation/source/noise (not a binary, asset, or data store)`;
        return {
            target: 'skip',
            reason,
            note: reason,
            provenance: 'inferred',
            source_tool: SOURCE_TOOL,
        };
    }
    /* -------------------- UNKNOWN -> asset/type='other' (A3: never silently dropped) ----- */
    const unknownNotes = joinNotes(extension
        ? `unknown extension .${extension}; catalogued as asset/type=other so nothing is dropped (A3)`
        : `no file extension; catalogued as asset/type=other so nothing is dropped (A3)`, sizeNote);
    return {
        target: 'asset',
        type: 'other',
        assetType: 'other',
        format: extension,
        decoded: false,
        isContainer: false,
        size: sizeRead.size,
        notes: unknownNotes,
        note: unknownNotes,
        provenance: resolveProvenance(unreadable),
        source_tool: SOURCE_TOOL,
        reason: extension
            ? `unrecognized extension .${extension}; catalogued as asset/type=other (A3 — never silently dropped)`
            : `file has no extension; catalogued as asset/type=other (A3 — never silently dropped)`,
    };
}
/** Map an extension to a typed asset.type, or null if not a known typed asset. */
function assetTypeFor(extension) {
    if (TEXTURE_EXTS.has(extension))
        return 'texture';
    if (MESH_EXTS.has(extension))
        return 'mesh';
    if (AUDIO_EXTS.has(extension))
        return 'audio';
    if (SHADER_EXTS.has(extension))
        return 'shader';
    if (LEVEL_EXTS.has(extension))
        return 'level';
    if (FONT_EXTS.has(extension))
        return 'font';
    return null;
}
//# sourceMappingURL=file-classifier.js.map