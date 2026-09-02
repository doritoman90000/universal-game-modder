import { createHash } from 'crypto';
import { readdirSync, readFileSync, realpathSync, statSync, mkdirSync, existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { detectEngine } from '../core/engine-detector.js';
import { AutopsyModel } from '../core/model-db.js';
import { classifyFile } from '../core/file-classifier.js';
import { extractGameName } from '../utils/path-utils.js';
const SHA256_OF_UNREADABLE = ''; // empty hash sentinel; the note carries the real reason
export function getUnpackTools() {
    return [
        {
            name: 'unpack_game',
            description: 'CATALOG-FIRST universal unpacker. Recursively walks an ENTIRE game install, classifies and sha256-hashes EVERY file, and persists the catalog into a SQLite <game>.autopsy.db (game/binary/asset/data_store tables, provenance on every row). Read-only: never writes game files. Containers (.pak/.pck/.bundle/...) are catalogued as single rows, never expanded (per-format extraction is a later slice). Idempotent: re-running on the same game re-opens the DB and upserts, no duplicate rows.',
            inputSchema: {
                type: 'object',
                properties: {
                    game_path: {
                        type: 'string',
                        description: 'Full path to the game install directory to catalog.',
                    },
                    db_path: {
                        type: 'string',
                        description: 'Optional output path for the .autopsy.db. Defaults to <game_path>/.autopsy/<name>.autopsy.db.',
                    },
                },
                required: ['game_path'],
            },
            handler: async (args) => {
                const gamePath = args.game_path;
                const explicitDbPath = args.db_path;
                if (!gamePath || !existsSync(gamePath)) {
                    return JSON.stringify({ error: `game_path does not exist: ${gamePath ?? '(missing)'}` }, null, 2);
                }
                const gameName = extractGameName(gamePath);
                // A4: engine detection result recorded on the game row.
                const detection = detectEngine(gamePath);
                // Resolve DB location (writes confined to .autopsy/ unless caller overrides).
                const dbPath = explicitDbPath ?? defaultDbPath(gamePath, gameName);
                ensureDir(dirname(dbPath));
                // A6: open existing DB if present; model-db upserts make this idempotent.
                const model = new AutopsyModel(dbPath);
                let gameId;
                try {
                    gameId = model.upsertGame({
                        name: gameName,
                        install_path: gamePath,
                        engine: detection.engine,
                        runtime: detection.runtime,
                        arch: null, // arch is per-binary; left null at the header level
                        package_type: inferPackageType(gamePath),
                        autopsy_version: String(1), // V1 schema marker (model owns AUTOPSY_SCHEMA_VERSION)
                        provenance: detection.confidence, // detector self-reports verified|inferred|uncertain
                        source_tool: 'engine-detector',
                    });
                    const counts = {
                        binaries: 0,
                        assets: 0,
                        data_stores: 0,
                        total: 0,
                        skipped: 0,
                        errors: 0,
                    };
                    const visitedDirs = new Set();
                    walk(gamePath, gamePath, gameId, model, counts, visitedDirs);
                    const summary = {
                        game: gameName,
                        engine: detection.engine,
                        runtime: detection.runtime,
                        engine_confidence: detection.confidence,
                        db_path: dbPath,
                        counts: {
                            binaries: counts.binaries,
                            assets: counts.assets,
                            data_stores: counts.data_stores,
                            total: counts.total,
                            skipped: counts.skipped,
                            errors: counts.errors,
                        },
                    };
                    return JSON.stringify(summary, null, 2);
                }
                finally {
                    // Always release the DB handle, even if the walk threw.
                    model.close();
                }
            },
        },
    ];
}
// ---------------------------------------------------------------------------
// Recursive walk
// ---------------------------------------------------------------------------
/**
 * Recursively walk `dir`, cataloguing every file. Containers are NOT descended
 * into (they are files, catalogued as single rows). Symlink loops are broken
 * via a visited-real-path set. No file is ever silently dropped.
 */
function walk(dir, installRoot, gameId, model, counts, visitedDirs) {
    // Symlink-loop guard: resolve the real path; if we've been here, stop.
    let realDir;
    try {
        realDir = realpathSync(dir);
    }
    catch {
        realDir = dir;
    }
    if (visitedDirs.has(realDir))
        return;
    visitedDirs.add(realDir);
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch (err) {
        // Unreadable directory (permissions, TrustedInstaller-locked, etc.) — record
        // the directory itself as a data_store note so the gap is visible, not silent.
        safeCatalogUnreadableDir(dir, gameId, model, counts, errString(err));
        return;
    }
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        // Do not follow symlinks as directories (loop & escape protection). A symlink
        // is catalogued as a file-shaped note rather than traversed.
        if (entry.isSymbolicLink()) {
            catalogFile(fullPath, gameId, model, counts);
            continue;
        }
        if (entry.isDirectory()) {
            walk(fullPath, installRoot, gameId, model, counts, visitedDirs);
        }
        else if (entry.isFile()) {
            catalogFile(fullPath, gameId, model, counts);
        }
        else {
            // Block/char/fifo/socket — exotic, but still account for it (never drop).
            catalogFile(fullPath, gameId, model, counts);
        }
    }
}
/**
 * Catalog a single file. Wrapped so one bad file can never abort the walk (A3/A7).
 * The classifier decides the table; size+sha256 are direct-read facts (verified).
 */
function catalogFile(absPath, gameId, model, counts) {
    // 1) size (direct stat => verified fact). Failure is non-fatal.
    let size = 0;
    let sizeOk = true;
    try {
        size = statSync(absPath).size;
    }
    catch {
        sizeOk = false;
    }
    // 2) classification (the classifier owns engine/format heuristics + provenance).
    //    A bad classifier call must not abort — fall back to a generic 'other' asset.
    let cls;
    try {
        cls = classifyFile(absPath);
    }
    catch (err) {
        cls = {
            target: 'asset',
            assetType: 'other',
            provenance: 'uncertain',
            note: `classifier failed: ${errString(err)}`,
        };
        counts.errors++;
    }
    // 3) sha256 (direct read => verified). Containers are hashed too (catalogued as
    //    one row), but never descended into. Unreadable/encrypted => empty hash + note,
    //    the row is STILL written (A7, KB 920f537e).
    let sha256 = SHA256_OF_UNREADABLE;
    let readNote = '';
    if (cls.target !== 'skip') {
        try {
            sha256 = sha256OfFile(absPath);
        }
        catch (err) {
            readNote = `unreadable (no hash): ${errString(err)}`;
            counts.errors++;
        }
    }
    if (!sizeOk) {
        readNote = appendNote(readNote, 'size unavailable (stat failed)');
    }
    // 4) route into the schema. Each branch is itself guarded so a DB hiccup on one
    //    row cannot kill the walk.
    try {
        routeRow(absPath, gameId, size, sizeOk, sha256, cls, readNote, model, counts);
    }
    catch (err) {
        // Last-resort safety net: never let a write error abort the catalog. Try to
        // record it as a bare 'other' asset note so the file is not silently lost.
        counts.errors++;
        try {
            model.addAsset({
                game_id: gameId,
                container_path: absPath, // the file on disk (NOT NULL natural-key part)
                internal_path: '', // standalone file => empty internal path
                type: 'other',
                format: extOf(absPath),
                decoded: false,
                decoded_path: null,
                size,
                notes: appendNote(readNote, `catalog write failed, recorded as fallback: ${errString(err)}`),
                provenance: 'uncertain',
                source_tool: 'unpack_game',
            });
            counts.assets++;
            counts.total++;
        }
        catch {
            // If even the fallback write fails, we've already incremented errors; do not throw.
        }
    }
}
/**
 * Decide which table a classified file lands in and write it. The size/sha256
 * facts are verified (direct reads); the routing provenance comes from the
 * classifier (defaulting to 'inferred' for heuristic classification — A5).
 */
function routeRow(absPath, gameId, size, sizeOk, sha256, cls, readNote, model, counts) {
    // A5 provenance rule — the row's provenance reflects its strongest LOCATING fact:
    //  - 'verified'  : we successfully size+sha256'd the file (direct byte-level read).
    //                  The file demonstrably exists and we have proof of its contents.
    //  - 'uncertain' : the read failed (unreadable/encrypted/locked) OR the classifier
    //                  itself flagged the routing uncertain (A7 garbage-managed case).
    //  - else        : fall back to the classifier's own provenance (heuristic 'inferred').
    // The *classification* (texture vs other, role guess) stays a heuristic and is
    // expressed via type/role/notes — not by downgrading a verified file to 'inferred'.
    const hashOk = sha256 !== SHA256_OF_UNREADABLE && sizeOk;
    const classifierProv = cls.provenance ?? 'inferred';
    const routingProv = classifierProv === 'uncertain' ? 'uncertain' : hashOk ? 'verified' : 'uncertain';
    if (cls.target === 'skip') {
        counts.skipped++;
        return;
    }
    if (cls.target === 'binary') {
        const managed = cls.managed === true;
        // KB 920f537e: an unreadable/garbage managed binary (e.g. IL2CPP) is catalogued
        // as managed+unreadable via the note, NOT thrown.
        const notes = mergeNotes(cls.note, readNote);
        model.addBinary({
            game_id: gameId,
            path: absPath,
            kind: cls.kind ?? guessBinaryKind(absPath),
            managed,
            arch: cls.arch ?? null,
            size,
            sha256, // '' when the file could not be read — note explains why
            role: cls.role ?? null,
            notes,
            // size/hash are verified reads; routing/role is the classifier's call.
            provenance: routingProv,
            source_tool: 'file-classifier',
        });
        counts.binaries++;
        counts.total++;
        return;
    }
    if (cls.target === 'data_store') {
        const notes = mergeNotes(cls.note, readNote);
        model.addDataStore({
            game_id: gameId,
            path: absPath,
            kind: cls.storeKind ?? 'binary-blob',
            scope: cls.scope ?? null,
            schema_known: false, // schema discovery is a later slice; never assumed here
            notes,
            provenance: routingProv,
            source_tool: 'file-classifier',
        });
        counts.data_stores++;
        counts.total++;
        return;
    }
    // Default + explicit 'asset'. A7: a container (.pak/.bundle/.pck) lands here as a
    // single asset row (or as a data_store above, classifier's choice) — NEVER walked.
    const baseNote = cls.isContainer
        ? appendNote(cls.note ?? '', 'container catalogued as single row; not expanded (extraction deferred to P1.2)')
        : cls.note ?? '';
    // A3: an unknown type is NEVER dropped — it becomes type='other' WITH a reason.
    const assetType = cls.assetType ?? 'other';
    const notes = assetType === 'other' && !baseNote
        ? mergeNotes('unrecognized file type — catalogued as other', readNote)
        : mergeNotes(baseNote, readNote);
    model.addAsset({
        game_id: gameId,
        container_path: absPath, // this IS the on-disk file (NOT NULL natural-key part)
        internal_path: '', // standalone file => empty internal path; members come in P1.2
        type: assetType,
        format: cls.format ?? extOf(absPath),
        decoded: false,
        decoded_path: null,
        size,
        notes,
        provenance: routingProv,
        source_tool: 'file-classifier',
    });
    counts.assets++;
    counts.total++;
}
/**
 * Record an unreadable directory as a data_store note so a permission gap (e.g.
 * TrustedInstaller-locked content) is visible in the catalog rather than silent.
 */
function safeCatalogUnreadableDir(dir, gameId, model, counts, reason) {
    try {
        model.addDataStore({
            game_id: gameId,
            path: dir,
            kind: 'binary-blob',
            scope: null,
            schema_known: false,
            notes: `directory not enumerable: ${reason}`,
            provenance: 'uncertain',
            source_tool: 'unpack_game',
        });
        counts.data_stores++;
        counts.total++;
    }
    catch {
        // even this failed — count it, never throw.
    }
    counts.errors++;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256OfFile(absPath) {
    // Synchronous full read; for catalog purposes a whole-file hash is correct.
    // (Streaming optimization can come later; correctness first.)
    const buf = readFileSync(absPath);
    return createHash('sha256').update(buf).digest('hex');
}
function defaultDbPath(gamePath, gameName) {
    const safeName = gameName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'game';
    return join(gamePath, '.autopsy', `${safeName}.autopsy.db`);
}
function ensureDir(dir) {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}
function inferPackageType(gamePath) {
    const lower = gamePath.toLowerCase();
    if (lower.includes('steamapps'))
        return 'steam';
    if (lower.includes('windowsapps') || lower.includes('packages'))
        return 'uwp';
    return 'standalone';
}
function extOf(absPath) {
    const name = basename(absPath);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
function guessBinaryKind(absPath) {
    const ext = extOf(absPath);
    if (ext === 'exe')
        return 'exe';
    if (ext === 'so')
        return 'so';
    return 'dll';
}
function errString(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function appendNote(existing, addition) {
    if (!existing)
        return addition;
    if (!addition)
        return existing;
    return `${existing}; ${addition}`;
}
function mergeNotes(a, b) {
    const merged = appendNote(a ?? '', b ?? '');
    return merged.length > 0 ? merged : null;
}
//# sourceMappingURL=unpack-tools.js.map