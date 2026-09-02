/**
 * decode-tools.ts — PR-2 "Universal Asset Decoder" (texture-first slice).
 *
 * decode_assets(db_path | game_path): reads the PR-1 catalog (The Model), finds the Unity
 * .assets container rows PR-1 catalogued as un-expanded, cracks each one open with our
 * serialized-file walker, extracts every Texture2D (pulling streamed pixels from the
 * sibling .resS), decodes to RGBA via the wrapped codec, writes a PNG, and writes the
 * decoded asset back into The Model as its own row:
 *
 *   asset(container_path = the .assets file, internal_path = "<TexName>#<pathID>",
 *         type = 'texture', format = <TextureFormat>, decoded = 1,
 *         decoded_path = <png>, provenance = 'verified', source_tool = 'decode_assets')
 *
 * This uses the container_path/internal_path seam PR-1 built for exactly this (PR-1 rows
 * have internal_path = '' for standalone files; PR-2 members get a non-empty internal_path,
 * so the UNIQUE (game_id, container_path, internal_path) key never collides with the
 * container's own catalog row).
 *
 * RAILS (honored):
 *  - READ-ONLY on game files. The ONLY writes are: the decoded PNGs (jailed to the output
 *    dir, default <game>/.autopsy/decoded/, overridable for write-protected installs) and
 *    the .autopsy.db rows. Never a byte into the game's own assets.
 *  - VERIFY-AFTER-WRITE: each PNG is re-read/validated; each DB row is read back.
 *  - NEVER SILENTLY DROP: an unsupported format / unreadable stream becomes a decoded=0
 *    row with a note, and the run continues (A3-class).
 *  - PROVENANCE: a byte-level decoded texture is 'verified'; a failed one is 'uncertain'.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import Database from 'better-sqlite3';
import { AutopsyModel } from '../core/model-db.js';
import { parseSerializedFile, ClassID } from '../decoders/unity/serialized-file.js';
import { parseTexture2D, TextureFormat } from '../decoders/unity/texture2d.js';
import { ResSReader } from '../decoders/unity/ress-reader.js';
import { decodeTexture } from '../decoders/texture-decode.js';
import { encodePng } from '../decoders/png-encode.js';
import { parseMesh } from '../decoders/unity/mesh.js';
import { exportGlb, exportObj } from '../decoders/mesh-export.js';
import { parseAudioClip } from '../decoders/unity/audioclip.js';
import { exportAudio } from '../decoders/audio-export.js';
import { PNG } from 'pngjs';
/** Sanitize a texture name into a safe filename fragment. */
function safeName(name) {
    return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'texture';
}
export function getDecodeTools() {
    return [
        {
            name: 'decode_assets',
            description: 'Universal Asset Decoder. Reads a PR-1 autopsy catalog, cracks open Unity .assets containers, and decodes their members back into The Model (decoded=1, decoded_path set): Texture2D -> PNG (streamed pixels from sibling .resS), Mesh -> glTF .glb + .obj (plain/uncompressed; compressed noted+deferred), and AudioClip -> WAV (PCM) / OGG (bare Vorbis); FSB5-wrapped Vorbis + other codecs are noted+deferred. Read-only on game files; decoded files + DB rows are the only writes. Pass either db_path (the .autopsy.db) or game_path (whose default .autopsy/ DB is used). Optional out_dir overrides where decoded files land; asset_kinds restricts to textures, meshes, or audio.',
            inputSchema: {
                type: 'object',
                properties: {
                    db_path: { type: 'string', description: 'Path to the <game>.autopsy.db produced by unpack_game.' },
                    game_path: {
                        type: 'string',
                        description: 'Game install dir; its default .autopsy/<name>.autopsy.db is used if db_path is omitted.',
                    },
                    out_dir: {
                        type: 'string',
                        description: 'Optional output dir for decoded PNGs. Defaults to <db_dir>/decoded/.',
                    },
                    limit: { type: 'number', description: 'Optional cap on textures decoded (for quick smoke runs).' },
                    asset_kinds: {
                        type: 'string',
                        enum: ['all', 'textures', 'meshes', 'audio'],
                        description: "Which asset kinds to decode. 'all' (default) does textures + meshes + audio; restrict with 'textures', 'meshes', or 'audio'.",
                    },
                },
            },
            handler: async (args) => {
                const dbPath = resolveDbPath(args.db_path, args.game_path);
                if (!dbPath || !existsSync(dbPath)) {
                    return JSON.stringify({ error: `autopsy DB not found. db_path=${args.db_path ?? ''} game_path=${args.game_path ?? ''}` }, null, 2);
                }
                const limit = typeof args.limit === 'number' ? args.limit : Infinity;
                // Output dir: jailed under the DB's dir by default (which is .autopsy/), overridable.
                const outDir = args.out_dir ?? join(dirname(dbPath), 'decoded');
                mkdirSync(outDir, { recursive: true });
                // Read catalog: find the game_id and the .assets container rows.
                const readDb = new Database(dbPath, { readonly: true });
                let gameId;
                let containerRows;
                try {
                    const game = readDb.prepare('SELECT id FROM game LIMIT 1').get();
                    if (!game) {
                        readDb.close();
                        return JSON.stringify({ error: 'catalog has no game row — run unpack_game first.' }, null, 2);
                    }
                    gameId = game.id;
                    // DISTINCT: a container may now have many decoded member rows (textures/meshes)
                    // whose container_path is the .assets file — we want each .assets file ONCE.
                    // Also require internal_path='' so we select the original PR-1 container catalog
                    // row, never a decoded member row.
                    containerRows = readDb
                        .prepare(`SELECT DISTINCT container_path FROM asset
               WHERE game_id = ? AND lower(container_path) LIKE '%.assets'
                 AND internal_path = ''
               ORDER BY container_path`)
                        .all(gameId);
                }
                finally {
                    readDb.close();
                }
                const counts = {
                    containers_seen: containerRows.length,
                    containers_parsed: 0,
                    textures_found: 0,
                    textures_decoded: 0,
                    textures_failed: 0,
                    pngs_written: 0,
                    meshes_found: 0,
                    meshes_decoded: 0,
                    meshes_failed: 0,
                    meshes_deferred_compressed: 0,
                    audio_found: 0,
                    audio_decoded: 0,
                    audio_failed: 0,
                    audio_deferred_unsupported: 0,
                    rows_written: 0,
                };
                const failures = [];
                // Which asset kinds to decode (default all). 'all' | 'textures' | 'meshes' | 'audio'.
                const kindsArg = args.asset_kinds ?? 'all';
                if (!['all', 'textures', 'meshes', 'audio'].includes(kindsArg)) {
                    return JSON.stringify({ error: `invalid asset_kinds '${kindsArg}' — expected 'all', 'textures', 'meshes', or 'audio'` }, null, 2);
                }
                const doTextures = kindsArg === 'all' || kindsArg === 'textures';
                const doMeshes = kindsArg === 'all' || kindsArg === 'meshes';
                const doAudio = kindsArg === 'all' || kindsArg === 'audio';
                // Open the Model for writes (writeback rows). Same DB file; writer reopens it.
                const model = new AutopsyModel(dbPath);
                try {
                    for (const row of containerRows) {
                        const assetsPath = row.container_path;
                        if (!existsSync(assetsPath)) {
                            failures.push({ texture: '(container)', container: assetsPath, reason: 'container file missing on disk' });
                            continue;
                        }
                        let parsed;
                        try {
                            parsed = parseSerializedFile(readFileSync(assetsPath));
                        }
                        catch (e) {
                            failures.push({ texture: '(container)', container: assetsPath, reason: `parse failed: ${e.message}` });
                            continue;
                        }
                        counts.containers_parsed++;
                        const ress = new ResSReader(assetsPath);
                        const containerOutDir = join(outDir, basename(assetsPath));
                        const texObjs = parsed.objects.filter((o) => o.classID === ClassID.Texture2D);
                        try {
                            if (doTextures) {
                                for (const obj of texObjs) {
                                    if (counts.textures_decoded >= limit)
                                        break;
                                    counts.textures_found++;
                                    // 1) parse the Texture2D fields
                                    let tex;
                                    try {
                                        tex = parseTexture2D(parsed.buf, parsed.header, obj);
                                    }
                                    catch (e) {
                                        counts.textures_failed++;
                                        recordFailedRow(model, gameId, assetsPath, `tex@${obj.pathID}`, e.message);
                                        counts.rows_written++;
                                        failures.push({ texture: `pathID ${obj.pathID}`, container: basename(assetsPath), reason: `parse: ${e.message}` });
                                        continue;
                                    }
                                    const internalPath = `${tex.name}#${obj.pathID}`;
                                    const fmtName = TextureFormat[tex.textureFormat] ?? `Unknown(${tex.textureFormat})`;
                                    // 2) get raw pixel bytes (streamed or inline)
                                    const raw = tex.streamData ? ress.read(tex.streamData) : tex.inlineData;
                                    if (!raw || raw.length === 0) {
                                        counts.textures_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, `no pixel data (stream=${!!tex.streamData})`, fmtName);
                                        counts.rows_written++;
                                        failures.push({ texture: tex.name, container: basename(assetsPath), reason: 'no pixel data' });
                                        continue;
                                    }
                                    // 3) decode -> RGBA
                                    const dec = await decodeTexture(raw, tex.textureFormat, tex.width, tex.height);
                                    if (!dec.ok || !dec.rgba) {
                                        counts.textures_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, dec.reason ?? 'decode failed', fmtName);
                                        counts.rows_written++;
                                        failures.push({ texture: tex.name, container: basename(assetsPath), reason: dec.reason ?? 'decode failed' });
                                        continue;
                                    }
                                    // 4) encode PNG + write (jailed to outDir)
                                    mkdirSync(containerOutDir, { recursive: true });
                                    const pngPath = join(containerOutDir, `${safeName(tex.name)}_${obj.pathID}.png`);
                                    const png = encodePng(dec.rgba, tex.width, tex.height);
                                    writeFileSync(pngPath, png);
                                    // 5) VERIFY-AFTER-WRITE: re-read the PNG and confirm dimensions.
                                    let verified = false;
                                    try {
                                        const rt = PNG.sync.read(readFileSync(pngPath));
                                        verified = rt.width === tex.width && rt.height === tex.height;
                                    }
                                    catch {
                                        verified = false;
                                    }
                                    if (!verified) {
                                        counts.textures_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, 'PNG verify-after-write failed', fmtName);
                                        counts.rows_written++;
                                        failures.push({ texture: tex.name, container: basename(assetsPath), reason: 'png verify failed' });
                                        continue;
                                    }
                                    counts.pngs_written++;
                                    counts.textures_decoded++;
                                    // 6) writeback: decoded asset row (verified)
                                    model.addAsset({
                                        game_id: gameId,
                                        container_path: assetsPath,
                                        internal_path: internalPath,
                                        type: 'texture',
                                        format: fmtName,
                                        decoded: true,
                                        decoded_path: pngPath,
                                        // size = byte size of the decoded artifact on disk (the PNG this row points at),
                                        // matching the convention that asset.size is a real on-disk byte count. The source
                                        // texture's pixel dimensions live in notes.
                                        size: png.length,
                                        notes: `${tex.width}x${tex.height} ${fmtName}; decoded by decode_assets`,
                                        provenance: 'verified',
                                        source_tool: 'decode_assets',
                                    });
                                    counts.rows_written++;
                                }
                            } // end doTextures
                            // ---- MESHES ----
                            if (doMeshes) {
                                const meshObjs = parsed.objects.filter((o) => o.classID === ClassID.Mesh);
                                for (const obj of meshObjs) {
                                    counts.meshes_found++;
                                    let mesh;
                                    try {
                                        mesh = parseMesh(parsed.buf, parsed.header, obj);
                                    }
                                    catch (e) {
                                        counts.meshes_failed++;
                                        recordFailedRow(model, gameId, assetsPath, `mesh@${obj.pathID}`, `parse: ${e.message}`, 'mesh', 'mesh');
                                        counts.rows_written++;
                                        failures.push({ texture: `mesh pathID ${obj.pathID}`, container: basename(assetsPath), reason: `parse: ${e.message}` });
                                        continue;
                                    }
                                    const internalPath = `${mesh.name}#${obj.pathID}`;
                                    // Compressed meshes (PackedBitVector) are a deferred slice — note, don't mis-decode.
                                    if (mesh.compressed) {
                                        counts.meshes_deferred_compressed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, 'compressed mesh (PackedBitVector) — deferred to a later slice', 'mesh', 'mesh');
                                        counts.rows_written++;
                                        continue;
                                    }
                                    if (!mesh.positions || mesh.vertexCount === 0) {
                                        counts.meshes_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, 'no vertex positions (streamed vertex data not yet supported)', 'mesh', 'mesh');
                                        counts.rows_written++;
                                        failures.push({ texture: mesh.name, container: basename(assetsPath), reason: 'no positions' });
                                        continue;
                                    }
                                    // export glb (primary) + obj (fallback), jailed to outDir
                                    mkdirSync(containerOutDir, { recursive: true });
                                    const glbPath = join(containerOutDir, `${safeName(mesh.name)}_${obj.pathID}.glb`);
                                    const objPath = join(containerOutDir, `${safeName(mesh.name)}_${obj.pathID}.obj`);
                                    let glb;
                                    try {
                                        glb = exportGlb(mesh);
                                        writeFileSync(glbPath, glb);
                                        writeFileSync(objPath, exportObj(mesh));
                                    }
                                    catch (e) {
                                        counts.meshes_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, `export failed: ${e.message}`, 'mesh', 'mesh');
                                        counts.rows_written++;
                                        failures.push({ texture: mesh.name, container: basename(assetsPath), reason: `export: ${e.message}` });
                                        continue;
                                    }
                                    // VERIFY-AFTER-WRITE: re-parse the glb header + accessor counts.
                                    let verified = false;
                                    try {
                                        const g = readFileSync(glbPath);
                                        const magic = g.readUInt32LE(0);
                                        const jsonLen = g.readUInt32LE(12);
                                        const gltf = JSON.parse(g.toString('utf8', 20, 20 + jsonLen));
                                        const posAcc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
                                        verified = magic === 0x46546c67 && posAcc.count === mesh.vertexCount;
                                    }
                                    catch {
                                        verified = false;
                                    }
                                    if (!verified) {
                                        counts.meshes_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, 'glb verify-after-write failed', 'mesh', 'mesh');
                                        counts.rows_written++;
                                        failures.push({ texture: mesh.name, container: basename(assetsPath), reason: 'glb verify failed' });
                                        continue;
                                    }
                                    counts.meshes_decoded++;
                                    model.addAsset({
                                        game_id: gameId,
                                        container_path: assetsPath,
                                        internal_path: internalPath,
                                        type: 'mesh',
                                        format: 'gltf',
                                        decoded: true,
                                        decoded_path: glbPath,
                                        size: glb.length,
                                        notes: `${mesh.vertexCount} verts, ${mesh.indices.length / 3} tris, attrs=[${mesh.attributesExported.join(',')}]; obj at ${objPath}; decoded by decode_assets`,
                                        provenance: 'verified',
                                        source_tool: 'decode_assets',
                                    });
                                    counts.rows_written++;
                                }
                            }
                            // ---- AUDIO ----
                            if (doAudio) {
                                const audioObjs = parsed.objects.filter((o) => o.classID === ClassID.AudioClip);
                                for (const obj of audioObjs) {
                                    counts.audio_found++;
                                    let clip;
                                    try {
                                        clip = parseAudioClip(parsed.buf, parsed.header, obj);
                                    }
                                    catch (e) {
                                        counts.audio_failed++;
                                        recordFailedRow(model, gameId, assetsPath, `audio@${obj.pathID}`, `parse: ${e.message}`, 'audio', 'audio');
                                        counts.rows_written++;
                                        failures.push({ texture: `audio pathID ${obj.pathID}`, container: basename(assetsPath), reason: `parse: ${e.message}` });
                                        continue;
                                    }
                                    const internalPath = `${clip.name}#${obj.pathID}`;
                                    // Pull the streamed samples from the sibling .resource via ResSReader.
                                    const raw = clip.size > 0 ? ress.read({ offset: clip.offset, size: clip.size, path: clip.source }) : null;
                                    if (!raw || raw.length === 0) {
                                        counts.audio_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, `no stream bytes (source=${basename(clip.source)} size=${clip.size})`, clip.compressionName, 'audio');
                                        counts.rows_written++;
                                        failures.push({ texture: clip.name, container: basename(assetsPath), reason: 'no stream bytes' });
                                        continue;
                                    }
                                    const exp = exportAudio(clip, raw);
                                    if (!exp) {
                                        // Unsupported compression (e.g. FSB5-wrapped Vorbis, ADPCM, MP3) — deferred, noted.
                                        counts.audio_deferred_unsupported++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, `unsupported audio format ${clip.compressionName} (FSB5/Vorbis unwrap deferred)`, clip.compressionName, 'audio');
                                        counts.rows_written++;
                                        continue;
                                    }
                                    mkdirSync(containerOutDir, { recursive: true });
                                    const audioPath = join(containerOutDir, `${safeName(clip.name)}_${obj.pathID}.${exp.ext}`);
                                    writeFileSync(audioPath, exp.bytes);
                                    // VERIFY-AFTER-WRITE: re-read + check the container header (RIFF/WAVE or OggS).
                                    let verified = false;
                                    try {
                                        const g = readFileSync(audioPath);
                                        if (exp.ext === 'wav')
                                            verified = g.toString('ascii', 0, 4) === 'RIFF' && g.toString('ascii', 8, 12) === 'WAVE';
                                        else
                                            verified = g.toString('ascii', 0, 4) === 'OggS';
                                    }
                                    catch {
                                        verified = false;
                                    }
                                    if (!verified) {
                                        counts.audio_failed++;
                                        recordFailedRow(model, gameId, assetsPath, internalPath, 'audio verify-after-write failed', clip.compressionName, 'audio');
                                        counts.rows_written++;
                                        failures.push({ texture: clip.name, container: basename(assetsPath), reason: 'audio verify failed' });
                                        continue;
                                    }
                                    counts.audio_decoded++;
                                    model.addAsset({
                                        game_id: gameId,
                                        container_path: assetsPath,
                                        internal_path: internalPath,
                                        type: 'audio',
                                        format: exp.ext,
                                        decoded: true,
                                        decoded_path: audioPath,
                                        size: exp.bytes.length,
                                        notes: `${clip.channels}ch ${clip.frequency}Hz ${clip.bitsPerSample}bit ${clip.length.toFixed(2)}s ${clip.compressionName}; decoded by decode_assets`,
                                        provenance: 'verified',
                                        source_tool: 'decode_assets',
                                    });
                                    counts.rows_written++;
                                }
                            }
                        }
                        finally {
                            ress.close();
                        }
                    }
                }
                finally {
                    model.close();
                }
                const summary = {
                    db_path: dbPath,
                    out_dir: outDir,
                    counts,
                    failures_sample: failures.slice(0, 15),
                    failures_total: failures.length,
                };
                return JSON.stringify(summary, null, 2);
            },
        },
    ];
}
/** Write a decoded=0 asset row recording WHY an asset couldn't be decoded (never silent). */
function recordFailedRow(model, gameId, assetsPath, internalPath, reason, fmtName = 'unknown', assetType = 'texture') {
    try {
        model.addAsset({
            game_id: gameId,
            container_path: assetsPath,
            internal_path: internalPath,
            type: assetType,
            format: fmtName,
            decoded: false,
            decoded_path: null,
            size: 0,
            notes: `decode failed: ${reason}`,
            provenance: 'uncertain',
            source_tool: 'decode_assets',
        });
    }
    catch {
        /* never let bookkeeping abort the run */
    }
}
function resolveDbPath(dbPath, gamePath) {
    if (dbPath)
        return dbPath;
    if (!gamePath)
        return null;
    const name = basename(gamePath).replace(/[^A-Za-z0-9._-]+/g, '_') || 'game';
    return join(gamePath, '.autopsy', `${name}.autopsy.db`);
}
//# sourceMappingURL=decode-tools.js.map