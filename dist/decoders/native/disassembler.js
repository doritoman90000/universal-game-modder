/**
 * disassembler.ts — PR-3.1 (V3 Native Comprehension): the disassembly binding.
 *
 * Wraps capstone-wasm (chosen 2026-07-01 by an evidence-based 3-way probe vs a
 * real notepad.exe .text section — see .forge/pr_log.md). The WASM binding won
 * on install story (0 deps, pure bundle), correctness (byte-identical to the
 * proven mko/ Python Capstone oracle), and in-process speed. The native addon
 * `capstone@3.0.1` was ELIMINATED (dead node-ffi/ref, won't build on Node 22);
 * Python-Capstone via child-process is retained ONLY as an offline verify oracle.
 *
 * Two gotchas this module hides from callers (both learned in the probe):
 *  1. disasm(bytes, { address }) — the base VA is an OPTIONS field, NOT positional.
 *     Passing a bare number silently decodes from address 0.
 *  2. address must be a BigInt for 64-bit runtime VAs (e.g. 0x140001000); a plain
 *     number works for small values but BigInt is correct across the range. The
 *     library returns Insn.address as number | bigint — we normalise on the way out.
 */
import { Capstone, Const, loadCapstone } from 'capstone-wasm';
/**
 * capstone-wasm must be initialised (WASM compiled/instantiated) exactly once
 * per process before any Capstone instance is constructed. loadCapstone() is
 * idempotent-safe to await, but we guard so concurrent tool calls share one init.
 */
let initPromise = null;
export async function ensureCapstone() {
    if (!initPromise)
        initPromise = loadCapstone();
    await initPromise;
}
/** Convert Insn.address (number | bigint) to a safe JS number. */
function toNum(v) {
    return typeof v === 'bigint' ? Number(v) : v;
}
/** Convert raw insn bytes to "48 8b 05" style hex. */
function bytesToHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
}
/**
 * Disassemble a raw byte range as x86-64. `bytes` is the exact code slice; the
 * caller has already resolved section/offset and knows the runtime VA the first
 * byte maps to. Returns normalised instructions with both VA and RVA.
 *
 * Read-only: this touches no files and mutates nothing — the caller reads the
 * binary; we only decode the bytes it hands us.
 */
export async function disassembleX64(bytes, opts) {
    await ensureCapstone();
    const cs = new Capstone(Const.CS_ARCH_X86, Const.CS_MODE_64);
    try {
        // GOTCHA 1 + 2: address is an options field, and BigInt for 64-bit VAs.
        const insns = cs.disasm(bytes, {
            address: BigInt(opts.runtimeVA),
            ...(opts.maxInsns && opts.maxInsns > 0 ? { count: opts.maxInsns } : {}),
        });
        return insns.map((i) => {
            const va = toNum(i.address);
            return {
                va,
                rva: va - opts.imageBase,
                size: i.size,
                mnemonic: i.mnemonic,
                opStr: i.opStr ?? '',
                bytes: bytesToHex(i.bytes),
            };
        });
    }
    finally {
        // Free the WASM handle; a leaked handle would grow WASM memory across calls.
        try {
            cs.close();
        }
        catch {
            /* best-effort */
        }
    }
}
/** The capstone-wasm version, for provenance/reporting. */
export async function capstoneVersion() {
    await ensureCapstone();
    const v = Capstone.version();
    return `${v.major}.${v.minor}`;
}
//# sourceMappingURL=disassembler.js.map