/**
 * texture-decode.ts — turn raw Unity texture bytes + a TextureFormat into RGBA pixels.
 *
 * Two paths:
 *   1. UNCOMPRESSED formats (RGBA32, RGB24, Alpha8, ARGB32, BGRA32, RGB565, R8, R16...)
 *      are unpacked here directly — no WASM needed. Baldi is overwhelmingly RGBA32, so
 *      this path carries most of the corpus.
 *   2. COMPRESSED formats (DXT/BC, ETC, ASTC, PVRTC, ATC, EAC, and the Crunched variants)
 *      are decoded by texture2ddecoder-wasm. Crunched formats are unpacked first
 *      (unpack_unity_crunch) then decoded by their base codec. The WASM decoders emit
 *      BGRA; we swap to RGBA on the way out so the PNG encoder gets a consistent layout.
 *
 * Output is ALWAYS tightly-packed RGBA8 (width*height*4 bytes), top-left origin. Unity
 * stores textures bottom-up, so the caller (png-encode) flips vertically.
 *
 * A format we cannot decode returns { ok:false, reason } rather than throwing — the
 * decode_assets tool turns that into a decoded=0 asset row with a note (never a silent drop).
 */
import { initialize, decode_bc1, decode_bc3, decode_bc4, decode_bc5, decode_bc6, decode_bc7, decode_etc1, decode_etc2, decode_etc2a1, decode_etc2a8, decode_pvrtc, decode_astc, decode_atc_rgb4, decode_atc_rgba8, unpack_unity_crunch, } from 'texture2ddecoder-wasm';
import { TextureFormat } from './unity/texture2d.js';
let wasmReady = false;
async function ensureWasm() {
    if (!wasmReady) {
        await initialize();
        wasmReady = true;
    }
}
/** BGRA (or BGRA-ish) -> RGBA in place-ish (returns a new Buffer). */
function bgraToRgba(bgra, width, height) {
    const n = width * height * 4;
    const out = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i += 4) {
        out[i] = bgra[i + 2]; // R <- B
        out[i + 1] = bgra[i + 1]; // G
        out[i + 2] = bgra[i]; // B <- R
        out[i + 3] = bgra[i + 3]; // A
    }
    return out;
}
/** ASTC block dimensions per format. */
function astcBlock(fmt) {
    switch (fmt) {
        case TextureFormat.ASTC_RGB_4x4:
        case TextureFormat.ASTC_RGBA_4x4:
            return [4, 4];
        case TextureFormat.ASTC_RGB_5x5:
        case TextureFormat.ASTC_RGBA_5x5:
            return [5, 5];
        case TextureFormat.ASTC_RGB_6x6:
        case TextureFormat.ASTC_RGBA_6x6:
            return [6, 6];
        case TextureFormat.ASTC_RGB_8x8:
        case TextureFormat.ASTC_RGBA_8x8:
            return [8, 8];
        case TextureFormat.ASTC_RGB_10x10:
        case TextureFormat.ASTC_RGBA_10x10:
            return [10, 10];
        case TextureFormat.ASTC_RGB_12x12:
        case TextureFormat.ASTC_RGBA_12x12:
            return [12, 12];
        default:
            return null;
    }
}
/** Decode an uncompressed Unity texture format directly to RGBA8. Returns null if not uncompressed. */
function decodeUncompressed(data, fmt, width, height) {
    const px = width * height;
    const out = Buffer.alloc(px * 4);
    const need = (bytes) => data.length >= bytes;
    switch (fmt) {
        case TextureFormat.RGBA32: {
            if (!need(px * 4))
                return null;
            data.copy(out, 0, 0, px * 4);
            return out;
        }
        case TextureFormat.ARGB32: {
            if (!need(px * 4))
                return null;
            for (let i = 0; i < px; i++) {
                const s = i * 4;
                out[s] = data[s + 1];
                out[s + 1] = data[s + 2];
                out[s + 2] = data[s + 3];
                out[s + 3] = data[s];
            }
            return out;
        }
        case TextureFormat.BGRA32: {
            if (!need(px * 4))
                return null;
            for (let i = 0; i < px; i++) {
                const s = i * 4;
                out[s] = data[s + 2];
                out[s + 1] = data[s + 1];
                out[s + 2] = data[s];
                out[s + 3] = data[s + 3];
            }
            return out;
        }
        case TextureFormat.RGB24: {
            if (!need(px * 3))
                return null;
            for (let i = 0; i < px; i++) {
                out[i * 4] = data[i * 3];
                out[i * 4 + 1] = data[i * 3 + 1];
                out[i * 4 + 2] = data[i * 3 + 2];
                out[i * 4 + 3] = 255;
            }
            return out;
        }
        case TextureFormat.Alpha8: {
            if (!need(px))
                return null;
            for (let i = 0; i < px; i++) {
                out[i * 4] = 255;
                out[i * 4 + 1] = 255;
                out[i * 4 + 2] = 255;
                out[i * 4 + 3] = data[i];
            }
            return out;
        }
        case TextureFormat.R8: {
            if (!need(px))
                return null;
            for (let i = 0; i < px; i++) {
                out[i * 4] = data[i];
                out[i * 4 + 1] = data[i];
                out[i * 4 + 2] = data[i];
                out[i * 4 + 3] = 255;
            }
            return out;
        }
        case TextureFormat.RGB565: {
            if (!need(px * 2))
                return null;
            for (let i = 0; i < px; i++) {
                const v = data.readUInt16LE(i * 2);
                const r = (v >> 11) & 0x1f;
                const g = (v >> 5) & 0x3f;
                const b = v & 0x1f;
                out[i * 4] = (r << 3) | (r >> 2);
                out[i * 4 + 1] = (g << 2) | (g >> 4);
                out[i * 4 + 2] = (b << 3) | (b >> 2);
                out[i * 4 + 3] = 255;
            }
            return out;
        }
        default:
            return null;
    }
}
/**
 * Decode any supported Unity texture format to tightly-packed RGBA8.
 * `data` is the raw (possibly streamed) texture bytes; `fmt` is the Unity TextureFormat int.
 */
export async function decodeTexture(data, fmt, width, height) {
    if (width <= 0 || height <= 0)
        return { ok: false, reason: `bad dimensions ${width}x${height}` };
    if (data.length === 0)
        return { ok: false, reason: 'no pixel data' };
    // 1) Uncompressed fast path (no WASM).
    const direct = decodeUncompressed(data, fmt, width, height);
    if (direct)
        return { ok: true, rgba: direct };
    // 2) Crunched -> unpack to the base codec stream first.
    let payload = data;
    let effFmt = fmt;
    try {
        if (fmt === TextureFormat.DXT1Crunched) {
            const u = await unpackCrunch(data);
            if (!u)
                return { ok: false, reason: 'DXT1Crunched unpack failed' };
            payload = u;
            effFmt = TextureFormat.DXT1;
        }
        else if (fmt === TextureFormat.DXT5Crunched) {
            const u = await unpackCrunch(data);
            if (!u)
                return { ok: false, reason: 'DXT5Crunched unpack failed' };
            payload = u;
            effFmt = TextureFormat.DXT5;
        }
        else if (fmt === TextureFormat.ETC_RGB4Crunched) {
            const u = await unpackCrunch(data);
            if (!u)
                return { ok: false, reason: 'ETC_RGB4Crunched unpack failed' };
            payload = u;
            effFmt = TextureFormat.ETC_RGB4;
        }
        else if (fmt === TextureFormat.ETC2_RGBA8Crunched) {
            const u = await unpackCrunch(data);
            if (!u)
                return { ok: false, reason: 'ETC2_RGBA8Crunched unpack failed' };
            payload = u;
            effFmt = TextureFormat.ETC2_RGBA8;
        }
    }
    catch (e) {
        return { ok: false, reason: `crunch unpack threw: ${e.message}` };
    }
    // 3) Compressed (WASM). All WASM decoders emit BGRA -> swap to RGBA.
    try {
        await ensureWasm();
        let bgra = null;
        switch (effFmt) {
            case TextureFormat.DXT1:
                bgra = await decode_bc1(payload, width, height);
                break;
            case TextureFormat.DXT5:
                bgra = await decode_bc3(payload, width, height);
                break;
            case TextureFormat.BC4:
                bgra = await decode_bc4(payload, width, height);
                break;
            case TextureFormat.BC5:
                bgra = await decode_bc5(payload, width, height);
                break;
            case TextureFormat.BC6H:
                bgra = await decode_bc6(payload, width, height);
                break;
            case TextureFormat.BC7:
                bgra = await decode_bc7(payload, width, height);
                break;
            case TextureFormat.ETC_RGB4:
                bgra = await decode_etc1(payload, width, height);
                break;
            case TextureFormat.ETC2_RGB:
                bgra = await decode_etc2(payload, width, height);
                break;
            case TextureFormat.ETC2_RGBA1:
                bgra = await decode_etc2a1(payload, width, height);
                break;
            case TextureFormat.ETC2_RGBA8:
                bgra = await decode_etc2a8(payload, width, height);
                break;
            case TextureFormat.ATC_RGB4:
                bgra = await decode_atc_rgb4(payload, width, height);
                break;
            case TextureFormat.ATC_RGBA8:
                bgra = await decode_atc_rgba8(payload, width, height);
                break;
            case TextureFormat.PVRTC_RGB2:
            case TextureFormat.PVRTC_RGBA2:
                bgra = await decode_pvrtc(payload, width, height, true);
                break;
            case TextureFormat.PVRTC_RGB4:
            case TextureFormat.PVRTC_RGBA4:
                bgra = await decode_pvrtc(payload, width, height, false);
                break;
            default: {
                const block = astcBlock(effFmt);
                if (block) {
                    bgra = await decode_astc(payload, width, height, block[0], block[1]);
                }
                else {
                    return {
                        ok: false,
                        reason: `unsupported TextureFormat ${TextureFormat[fmt] ?? fmt}`,
                    };
                }
            }
        }
        if (!bgra)
            return { ok: false, reason: `decoder returned null for ${TextureFormat[effFmt] ?? effFmt}` };
        return { ok: true, rgba: bgraToRgba(bgra, width, height) };
    }
    catch (e) {
        return { ok: false, reason: `decode threw: ${e.message}` };
    }
}
async function unpackCrunch(data) {
    await ensureWasm();
    // Unity uses a modified crunch; unpack_unity_crunch is the Unity-specific variant.
    const u = await unpack_unity_crunch(data);
    return u ? Buffer.from(u) : null;
}
//# sourceMappingURL=texture-decode.js.map