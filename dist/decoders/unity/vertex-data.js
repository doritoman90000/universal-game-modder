/**
 * vertex-data.ts — decode a Unity Mesh's m_VertexData into typed vertex attributes.
 *
 * Unity packs all vertex attributes (position, normal, tangent, color, uv0..uv7) into one
 * interleaved byte blob, described by a list of ChannelInfo entries. Each channel says:
 *   stream    — which interleaved stream it lives in (usually 0)
 *   offset    — byte offset WITHIN one vertex's slice of that stream
 *   format    — the component data type (float32 / float16 / unorm8 / ...)
 *   dimension — component count (3 for position, 2 for uv, 4 for tangent/color)
 * The per-vertex stride of a stream is the sum of its channels' byte sizes (aligned).
 *
 * This module reads the channels we export (POSITION, NORMAL, and UV0) as float32 arrays.
 * Other channels are skipped for the first slice; nothing throws on an unknown channel —
 * it's simply not extracted (and the caller notes which attributes were exported).
 *
 * Reference field order: Unity 2020.3 VertexData (AssetStudio Mesh.cs), little-endian.
 */
import { BinaryReader } from './binary-reader.js';
/** Unity VertexChannelFormat (2019+). The values we decode are the common ones. */
export var VertexFormat;
(function (VertexFormat) {
    VertexFormat[VertexFormat["Float"] = 0] = "Float";
    VertexFormat[VertexFormat["Float16"] = 1] = "Float16";
    VertexFormat[VertexFormat["UNorm8"] = 2] = "UNorm8";
    VertexFormat[VertexFormat["SNorm8"] = 3] = "SNorm8";
    VertexFormat[VertexFormat["UNorm16"] = 4] = "UNorm16";
    VertexFormat[VertexFormat["SNorm16"] = 5] = "SNorm16";
    VertexFormat[VertexFormat["UInt8"] = 6] = "UInt8";
    VertexFormat[VertexFormat["SInt8"] = 7] = "SInt8";
    VertexFormat[VertexFormat["UInt16"] = 8] = "UInt16";
    VertexFormat[VertexFormat["SInt16"] = 9] = "SInt16";
    VertexFormat[VertexFormat["UInt32"] = 10] = "UInt32";
    VertexFormat[VertexFormat["SInt32"] = 11] = "SInt32";
})(VertexFormat || (VertexFormat = {}));
/** Byte size of one component of a given vertex format. */
export function formatSize(format) {
    switch (format) {
        case VertexFormat.Float:
        case VertexFormat.UInt32:
        case VertexFormat.SInt32:
            return 4;
        case VertexFormat.Float16:
        case VertexFormat.UNorm16:
        case VertexFormat.SNorm16:
        case VertexFormat.UInt16:
        case VertexFormat.SInt16:
            return 2;
        case VertexFormat.UNorm8:
        case VertexFormat.SNorm8:
        case VertexFormat.UInt8:
        case VertexFormat.SInt8:
            return 1;
        default:
            return 4;
    }
}
/** Read one component as a float (normalizing where the format implies it). */
function readComponent(r, format) {
    switch (format) {
        case VertexFormat.Float:
            return readF32(r);
        case VertexFormat.Float16:
            return halfToFloat(readU16(r));
        case VertexFormat.UNorm8:
            return readU8(r) / 255;
        case VertexFormat.SNorm8:
            return Math.max(readI8(r) / 127, -1);
        case VertexFormat.UNorm16:
            return readU16(r) / 65535;
        case VertexFormat.SNorm16:
            return Math.max(readI16(r) / 32767, -1);
        case VertexFormat.UInt8:
            return readU8(r);
        case VertexFormat.SInt8:
            return readI8(r);
        case VertexFormat.UInt16:
            return readU16(r);
        case VertexFormat.SInt16:
            return readI16(r);
        case VertexFormat.UInt32:
        case VertexFormat.SInt32:
            return Number(readU32(r));
        default:
            return readF32(r);
    }
}
// Small explicit readers (avoid the awkward advance() trick above for clarity).
function readF32(r) {
    const v = r.buf.readFloatLE(r.pos);
    r.pos += 4;
    return v;
}
function readU8(r) {
    const v = r.buf.readUInt8(r.pos);
    r.pos += 1;
    return v;
}
function readI8(r) {
    const v = r.buf.readInt8(r.pos);
    r.pos += 1;
    return v;
}
function readU16(r) {
    const v = r.buf.readUInt16LE(r.pos);
    r.pos += 2;
    return v;
}
function readI16(r) {
    const v = r.buf.readInt16LE(r.pos);
    r.pos += 2;
    return v;
}
function readU32(r) {
    const v = r.buf.readUInt32LE(r.pos);
    r.pos += 4;
    return v;
}
/** IEEE half (float16) -> float32. */
export function halfToFloat(h) {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0)
        return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 0x1f)
        return f ? NaN : (s ? -1 : 1) * Infinity;
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}
/**
 * Extract a per-vertex float attribute (e.g. POSITION dim=3) from the interleaved blob.
 * Returns a flat Float32Array of length vertexCount*outDim. Components beyond the channel's
 * real dimension are zero-filled; if the channel is absent, returns null.
 */
export function extractAttribute(vd, channelIndex, outDim) {
    const ch = vd.channels[channelIndex];
    if (!ch || (ch.dimension & 0x0f) === 0)
        return null;
    const dim = ch.dimension & 0x0f;
    const compSize = formatSize(ch.format);
    // Per-stream stride = sum of byte sizes of all channels in that stream.
    const stride = streamStride(vd.channels, ch.stream);
    if (stride === 0)
        return null;
    // Byte offset of this stream's region within the blob: streams are concatenated, each
    // region = vertexCount * thatStreamStride. Compute the start of ch.stream.
    let streamStart = 0;
    for (let s = 0; s < ch.stream; s++) {
        streamStart += vd.vertexCount * streamStride(vd.channels, s);
    }
    const out = new Float32Array(vd.vertexCount * outDim);
    const r = new BinaryReader(vd.data, false, 0);
    for (let v = 0; v < vd.vertexCount; v++) {
        const base = streamStart + v * stride + ch.offset;
        for (let c = 0; c < dim && c < outDim; c++) {
            r.pos = base + c * compSize;
            if (r.pos + compSize > vd.data.length)
                return out; // bounds guard: stop, return what we have
            out[v * outDim + c] = readComponent(r, ch.format);
        }
    }
    return out;
}
/** Sum of byte sizes of channels assigned to a given stream. */
function streamStride(channels, stream) {
    let s = 0;
    for (const ch of channels) {
        if (ch.stream !== stream)
            continue;
        const dim = ch.dimension & 0x0f;
        s += dim * formatSize(ch.format);
    }
    return s;
}
//# sourceMappingURL=vertex-data.js.map