/**
 * native-comprehension-tools.ts — PR-3.1 (V3 "Native Comprehension", the moat).
 *
 * The engine's FIRST sight of native code. Two tools:
 *   - disassemble_range(binary_path, rva, length): decode an arbitrary byte range.
 *   - disassemble_function(binary_path, rva): decode from an entry RVA to the first
 *     terminal (ret/jmp-tail) — a linear-sweep function bound (PR-3.1 heuristic;
 *     CFG-accurate bounds arrive with the call-graph in PR-3.2).
 *
 * Disassembly is capstone-wasm (chosen by the 3-way probe; see .forge/pr_log.md).
 * PE section/RVA resolution is a small self-contained parser here (mirrors the
 * proven mko/disasm_at.py: RVA -> section -> file offset -> VA = imageBase + rva).
 *
 * RAILS (honored — protected_behaviors):
 *  - READ-ONLY on the game binary: the only fs call against it is readFileSync.
 *  - The ONLY writes are optional rows into The Model (.autopsy.db), and each is
 *    read back (verify-after-write). Pass db_path/game_path to enable writeback;
 *    omit them to get pure read-only disassembly with no side effects at all.
 *  - PROVENANCE: a byte-level decoded instruction is 'verified'. A function whose
 *    extent is a linear-sweep heuristic (not yet CFG-proven) is 'inferred'.
 *  - [VERIFIED]/[INFERRED] discipline: instructions are verified facts; the
 *    function's *boundary* in PR-3.1 is inferred and tagged as such.
 */
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import Database from 'better-sqlite3';
import { AutopsyModel } from '../core/model-db.js';
import { disassembleX64, capstoneVersion } from '../decoders/native/disassembler.js';
/** Parse just enough PE header to resolve RVAs. Read-only; throws on non-PE. */
function parsePe(buf) {
    if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d)
        throw new Error('not a PE (missing MZ)');
    const peOff = buf.readUInt32LE(60);
    if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550)
        throw new Error('not a PE (bad signature)');
    const coff = peOff + 4;
    const nSec = buf.readUInt16LE(coff + 2);
    const sizeOpt = buf.readUInt16LE(coff + 16);
    const optOff = coff + 20;
    const magic = buf.readUInt16LE(optOff);
    const is64 = magic === 0x20b;
    const imageBase = is64 ? Number(buf.readBigUInt64LE(optOff + 24)) : buf.readUInt32LE(optOff + 28);
    const secOff = optOff + sizeOpt;
    const sections = [];
    for (let i = 0; i < nSec; i++) {
        const off = secOff + i * 40;
        if (off + 40 > buf.length)
            break;
        sections.push({
            name: buf.subarray(off, off + 8).toString('ascii').replace(/\0+$/, ''),
            vsize: buf.readUInt32LE(off + 8),
            va: buf.readUInt32LE(off + 12),
            rawSize: buf.readUInt32LE(off + 16),
            rawPtr: buf.readUInt32LE(off + 20),
        });
    }
    return { is64, imageBase, sections };
}
/** The section containing an RVA, or null. */
function sectionForRva(pe, rva) {
    for (const s of pe.sections) {
        if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize))
            return s;
    }
    return null;
}
/** Resolve an RVA to a file offset using its section. Throws if unmapped. */
function rvaToOffset(pe, rva, section) {
    return section.rawPtr + (rva - section.va);
}
/** Read a bounded, section-clamped code slice for an RVA. Read-only. */
function readCodeSlice(buf, pe, rva, length) {
    const section = sectionForRva(pe, rva);
    if (!section)
        throw new Error(`RVA 0x${rva.toString(16)} is not inside any PE section`);
    const fileOff = rvaToOffset(pe, rva, section);
    // Clamp to the section's raw data so we never read past it into another section.
    const sectionRawEnd = section.rawPtr + section.rawSize;
    const end = Math.min(fileOff + length, sectionRawEnd, buf.length);
    const bytes = buf.subarray(fileOff, Math.max(fileOff, end));
    return { bytes, runtimeVA: pe.imageBase + rva, section: section.name };
}
/** Resolve a db path from explicit db_path or a game_path's default .autopsy dir. */
function resolveDbPath(dbPath, gamePath) {
    if (dbPath)
        return dbPath;
    if (!gamePath)
        return null;
    const name = basename(gamePath).replace(/[^A-Za-z0-9._-]+/g, '_') || 'game';
    return join(gamePath, '.autopsy', `${name}.autopsy.db`);
}
/**
 * Find the binary row id for a given binary path in an existing Model, so we can
 * attach function/xref rows. Returns null if the DB or row isn't present — the
 * tool then reports read-only results without writeback (never invents a binary).
 */
function lookupBinaryId(dbPath, binaryPath) {
    if (!existsSync(dbPath))
        return null;
    const db = new Database(dbPath, { readonly: true });
    try {
        const norm = binaryPath.replace(/\\/g, '/').toLowerCase();
        const rows = db.prepare('SELECT id, game_id, path FROM binary').all();
        const hit = rows.find((r) => r.path.replace(/\\/g, '/').toLowerCase() === norm);
        return hit ? { gameId: hit.game_id, binaryId: hit.id } : null;
    }
    finally {
        db.close();
    }
}
/** True if a mnemonic ends a linear function sweep (PR-3.1 heuristic). */
function isTerminal(mnemonic) {
    // ret/retf end the function; int3 padding after a ret marks the gap to the next.
    return mnemonic === 'ret' || mnemonic === 'retf' || mnemonic === 'iret' || mnemonic === 'iretd' || mnemonic === 'iretq';
}
/** Shape the per-insn JSON. */
function insnJson(i) {
    return {
        rva: `0x${i.rva.toString(16)}`,
        va: `0x${i.va.toString(16)}`,
        bytes: i.bytes,
        mnemonic: i.mnemonic,
        op_str: i.opStr,
    };
}
export function getNativeComprehensionTools() {
    return [
        {
            name: 'disassemble_range',
            description: "Disassemble an arbitrary byte range of a native PE (x86-64) starting at an RVA. Resolves the RVA to its section and file offset, reads ONLY that slice (read-only on the binary), and decodes it with Capstone. Returns the instruction listing. If db_path or game_path is given AND the binary is catalogued in that autopsy DB, the decoded instructions are also summarized into The Model as a 'function' row spanning the range (provenance=verified for the bytes). Pure read-only when no DB is supplied.",
            inputSchema: {
                type: 'object',
                properties: {
                    binary_path: { type: 'string', description: 'Path to the PE (.exe/.dll) to disassemble.' },
                    rva: { type: 'number', description: 'Relative virtual address to start at (e.g. 0x1000).' },
                    length: { type: 'number', description: 'Number of bytes to disassemble (default 256, clamped to the section).' },
                    db_path: { type: 'string', description: 'Optional .autopsy.db for writeback.' },
                    game_path: { type: 'string', description: 'Optional game dir; its default .autopsy DB is used if db_path is omitted.' },
                },
                required: ['binary_path', 'rva'],
            },
            handler: async (args) => {
                const binaryPath = args.binary_path;
                const rva = args.rva;
                const length = typeof args.length === 'number' ? args.length : 256;
                if (!existsSync(binaryPath))
                    return JSON.stringify({ error: `binary not found: ${binaryPath}` }, null, 2);
                const buf = readFileSync(binaryPath); // READ-ONLY
                let pe;
                try {
                    pe = parsePe(buf);
                }
                catch (e) {
                    return JSON.stringify({ error: `PE parse failed: ${e.message}` }, null, 2);
                }
                if (!pe.is64) {
                    return JSON.stringify({ error: 'PR-3.1 supports x86-64 only; this PE is 32-bit (x86). Deferred to a later slice.' }, null, 2);
                }
                let slice;
                try {
                    slice = readCodeSlice(buf, pe, rva, length);
                }
                catch (e) {
                    return JSON.stringify({ error: e.message }, null, 2);
                }
                const insns = await disassembleX64(slice.bytes, { runtimeVA: slice.runtimeVA, imageBase: pe.imageBase });
                // Optional writeback into The Model.
                const writeback = await maybeWriteFunction(args, binaryPath, rva, insns, slice.bytes.length, 'disassemble_range', false);
                return JSON.stringify({
                    binary: basename(binaryPath),
                    capstone: await capstoneVersion(),
                    section: slice.section,
                    start_rva: `0x${rva.toString(16)}`,
                    bytes_read: slice.bytes.length,
                    insn_count: insns.length,
                    writeback,
                    instructions: insns.map(insnJson),
                }, null, 2);
            },
        },
        {
            name: 'disassemble_function',
            description: "Disassemble a function starting at an RVA in a native PE (x86-64). Linear sweep from the entry RVA to the first terminal instruction (ret/iret) or max_bytes, whichever comes first — a PR-3.1 boundary heuristic (CFG-accurate bounds arrive with the call-graph in PR-3.2), so the function EXTENT is tagged provenance=inferred while the decoded bytes themselves are verified. Read-only on the binary. Writes a 'function' row into The Model when db_path/game_path is supplied and the binary is catalogued.",
            inputSchema: {
                type: 'object',
                properties: {
                    binary_path: { type: 'string', description: 'Path to the PE (.exe/.dll).' },
                    rva: { type: 'number', description: 'Entry RVA of the function.' },
                    max_bytes: { type: 'number', description: 'Safety cap on sweep length (default 4096).' },
                    db_path: { type: 'string', description: 'Optional .autopsy.db for writeback.' },
                    game_path: { type: 'string', description: 'Optional game dir; default .autopsy DB used if db_path omitted.' },
                },
                required: ['binary_path', 'rva'],
            },
            handler: async (args) => {
                const binaryPath = args.binary_path;
                const rva = args.rva;
                const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : 4096;
                if (!existsSync(binaryPath))
                    return JSON.stringify({ error: `binary not found: ${binaryPath}` }, null, 2);
                const buf = readFileSync(binaryPath); // READ-ONLY
                let pe;
                try {
                    pe = parsePe(buf);
                }
                catch (e) {
                    return JSON.stringify({ error: `PE parse failed: ${e.message}` }, null, 2);
                }
                if (!pe.is64) {
                    return JSON.stringify({ error: 'PR-3.1 supports x86-64 only; this PE is 32-bit (x86). Deferred to a later slice.' }, null, 2);
                }
                let slice;
                try {
                    slice = readCodeSlice(buf, pe, rva, maxBytes);
                }
                catch (e) {
                    return JSON.stringify({ error: e.message }, null, 2);
                }
                const all = await disassembleX64(slice.bytes, { runtimeVA: slice.runtimeVA, imageBase: pe.imageBase });
                // Truncate the sweep at the first terminal instruction (inclusive).
                let end = all.length;
                for (let k = 0; k < all.length; k++) {
                    if (isTerminal(all[k].mnemonic)) {
                        end = k + 1;
                        break;
                    }
                }
                const insns = all.slice(0, end);
                const byteLen = insns.reduce((n, i) => n + i.size, 0);
                const hitTerminal = end < all.length || (insns.length > 0 && isTerminal(insns[insns.length - 1].mnemonic));
                const writeback = await maybeWriteFunction(args, binaryPath, rva, insns, byteLen, 'disassemble_function', true);
                return JSON.stringify({
                    binary: basename(binaryPath),
                    capstone: await capstoneVersion(),
                    section: slice.section,
                    entry_rva: `0x${rva.toString(16)}`,
                    insn_count: insns.length,
                    byte_length: byteLen,
                    terminated_on_ret: hitTerminal,
                    boundary_provenance: 'inferred (linear sweep; CFG bounds in PR-3.2)',
                    writeback,
                    instructions: insns.map(insnJson),
                }, null, 2);
            },
        },
    ];
}
/**
 * If a DB is supplied and the binary is catalogued there, write a 'function' row
 * covering [rva, rva+byteLen) and verify it read back. Returns a small status
 * object for the tool summary. Never throws into the caller — writeback is
 * best-effort and its failure is reported, not fatal (the disasm still returns).
 */
async function maybeWriteFunction(args, binaryPath, rva, insns, byteLen, sourceTool, boundaryInferred) {
    const dbPath = resolveDbPath(args.db_path, args.game_path);
    if (!dbPath)
        return { attempted: false, reason: 'no db_path/game_path supplied — pure read-only run' };
    if (!existsSync(dbPath))
        return { attempted: false, reason: `autopsy DB not found: ${dbPath}` };
    const found = lookupBinaryId(dbPath, binaryPath);
    if (!found)
        return { attempted: false, reason: 'binary not catalogued in this DB (run unpack_game first) — not inventing a row' };
    try {
        const model = new AutopsyModel(dbPath);
        let fnId;
        try {
            fnId = model.addFunction({
                binary_id: found.binaryId,
                rva,
                size: byteLen,
                insn_count: insns.length,
                name: null,
                label: null,
                notes: `${insns.length} insns; extent by ${boundaryInferred ? 'linear-sweep heuristic' : 'explicit range'}; ${sourceTool}`,
                // Bytes are verified; a heuristic boundary makes the ROW inferred.
                provenance: boundaryInferred ? 'inferred' : 'verified',
                source_tool: sourceTool,
            });
        }
        finally {
            model.close();
        }
        // VERIFY-AFTER-WRITE: read the row back.
        const rdb = new Database(dbPath, { readonly: true });
        try {
            const row = rdb.prepare('SELECT rva, size, insn_count FROM "function" WHERE id = ?').get(fnId);
            const ok = !!row && row.rva === rva && row.size === byteLen && row.insn_count === insns.length;
            return { attempted: true, ok, function_id: fnId, binary_id: found.binaryId, verified: ok };
        }
        finally {
            rdb.close();
        }
    }
    catch (e) {
        return { attempted: true, ok: false, error: e.message };
    }
}
//# sourceMappingURL=native-comprehension-tools.js.map