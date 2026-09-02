/**
 * texture2d.ts — parse a Unity Texture2D object payload (Unity 2020.3 / format v22,
 * typeTree DISABLED) into the fields needed to locate and decode its pixels.
 *
 * When the serialized file has enableTypeTree=false (Baldi's case, and the common
 * release-build case), object payloads have no embedded schema — they are read
 * POSITIONALLY against the known field order for the engine version. This module
 * encodes the 2020.3 Texture2D field order. It is the one place that is version-shaped;
 * a different major Unity version would need its own field order (a future slice).
 *
 * Reference field order (Unity 2020.3 Texture2D, little-endian desktop):
 *   m_Name                : AlignedString
 *   m_ForcedFallbackFormat: Int32
 *   m_DownscaleFallback   : bool ; (2020.2+) m_IsAlphaChannelOptional : bool ; align(4)
 *   m_Width               : Int32
 *   m_Height              : Int32
 *   m_CompleteImageSize   : Int32
 *   m_MipsStripped        : Int32        (2020.1+)
 *   m_TextureFormat       : Int32
 *   m_MipCount            : Int32
 *   m_IsReadable          : bool
 *   m_IsPreProcessed      : bool         (2020.1+)
 *   m_IgnoreMasterTextureLimit : bool    (2019.3+)
 *   m_StreamingMipmaps    : bool         (2018.2+)
 *   align(4)
 *   m_StreamingMipmapsPriority : Int32   (2018.2+)
 *   m_ImageCount          : Int32
 *   m_TextureDimension    : Int32
 *   m_TextureSettings     : { FilterMode:i32, Aniso:i32, MipBias:f32, WrapU:i32, WrapV:i32, WrapW:i32 }
 *   m_LightmapFormat      : Int32
 *   m_ColorSpace          : Int32
 *   m_PlatformBlob        : UInt8[]  (Int32 len + bytes + align)   (2020.2+)
 *   image data size       : Int32  (== bytes inline, or 0 when streamed)
 *   m_StreamData          : { offset:UInt64, size:UInt32, path:AlignedString }  (when inline size==0)
 *
 * We tolerate trailing-field drift by reading defensively and validating width/height/
 * format against sane bounds; an implausible parse throws rather than emitting garbage.
 */
import { BinaryReader } from './binary-reader.js';
/** Unity TextureFormat enum (subset + names) — mirrors the codec lib's mapping. */
export var TextureFormat;
(function (TextureFormat) {
    TextureFormat[TextureFormat["Alpha8"] = 1] = "Alpha8";
    TextureFormat[TextureFormat["ARGB4444"] = 2] = "ARGB4444";
    TextureFormat[TextureFormat["RGB24"] = 3] = "RGB24";
    TextureFormat[TextureFormat["RGBA32"] = 4] = "RGBA32";
    TextureFormat[TextureFormat["ARGB32"] = 5] = "ARGB32";
    TextureFormat[TextureFormat["RGB565"] = 7] = "RGB565";
    TextureFormat[TextureFormat["R16"] = 9] = "R16";
    TextureFormat[TextureFormat["DXT1"] = 10] = "DXT1";
    TextureFormat[TextureFormat["DXT3"] = 11] = "DXT3";
    TextureFormat[TextureFormat["DXT5"] = 12] = "DXT5";
    TextureFormat[TextureFormat["RGBA4444"] = 13] = "RGBA4444";
    TextureFormat[TextureFormat["BGRA32"] = 14] = "BGRA32";
    TextureFormat[TextureFormat["RHalf"] = 15] = "RHalf";
    TextureFormat[TextureFormat["RGHalf"] = 16] = "RGHalf";
    TextureFormat[TextureFormat["RGBAHalf"] = 17] = "RGBAHalf";
    TextureFormat[TextureFormat["RFloat"] = 18] = "RFloat";
    TextureFormat[TextureFormat["RGFloat"] = 19] = "RGFloat";
    TextureFormat[TextureFormat["RGBAFloat"] = 20] = "RGBAFloat";
    TextureFormat[TextureFormat["YUY2"] = 21] = "YUY2";
    TextureFormat[TextureFormat["RGB9e5Float"] = 22] = "RGB9e5Float";
    TextureFormat[TextureFormat["BC6H"] = 24] = "BC6H";
    TextureFormat[TextureFormat["BC7"] = 25] = "BC7";
    TextureFormat[TextureFormat["BC4"] = 26] = "BC4";
    TextureFormat[TextureFormat["BC5"] = 27] = "BC5";
    TextureFormat[TextureFormat["DXT1Crunched"] = 28] = "DXT1Crunched";
    TextureFormat[TextureFormat["DXT5Crunched"] = 29] = "DXT5Crunched";
    TextureFormat[TextureFormat["PVRTC_RGB2"] = 30] = "PVRTC_RGB2";
    TextureFormat[TextureFormat["PVRTC_RGBA2"] = 31] = "PVRTC_RGBA2";
    TextureFormat[TextureFormat["PVRTC_RGB4"] = 32] = "PVRTC_RGB4";
    TextureFormat[TextureFormat["PVRTC_RGBA4"] = 33] = "PVRTC_RGBA4";
    TextureFormat[TextureFormat["ETC_RGB4"] = 34] = "ETC_RGB4";
    TextureFormat[TextureFormat["ATC_RGB4"] = 35] = "ATC_RGB4";
    TextureFormat[TextureFormat["ATC_RGBA8"] = 36] = "ATC_RGBA8";
    TextureFormat[TextureFormat["EAC_R"] = 41] = "EAC_R";
    TextureFormat[TextureFormat["EAC_R_SIGNED"] = 42] = "EAC_R_SIGNED";
    TextureFormat[TextureFormat["EAC_RG"] = 43] = "EAC_RG";
    TextureFormat[TextureFormat["EAC_RG_SIGNED"] = 44] = "EAC_RG_SIGNED";
    TextureFormat[TextureFormat["ETC2_RGB"] = 45] = "ETC2_RGB";
    TextureFormat[TextureFormat["ETC2_RGBA1"] = 46] = "ETC2_RGBA1";
    TextureFormat[TextureFormat["ETC2_RGBA8"] = 47] = "ETC2_RGBA8";
    TextureFormat[TextureFormat["ASTC_RGB_4x4"] = 48] = "ASTC_RGB_4x4";
    TextureFormat[TextureFormat["ASTC_RGB_5x5"] = 49] = "ASTC_RGB_5x5";
    TextureFormat[TextureFormat["ASTC_RGB_6x6"] = 50] = "ASTC_RGB_6x6";
    TextureFormat[TextureFormat["ASTC_RGB_8x8"] = 51] = "ASTC_RGB_8x8";
    TextureFormat[TextureFormat["ASTC_RGB_10x10"] = 52] = "ASTC_RGB_10x10";
    TextureFormat[TextureFormat["ASTC_RGB_12x12"] = 53] = "ASTC_RGB_12x12";
    TextureFormat[TextureFormat["ASTC_RGBA_4x4"] = 54] = "ASTC_RGBA_4x4";
    TextureFormat[TextureFormat["ASTC_RGBA_5x5"] = 55] = "ASTC_RGBA_5x5";
    TextureFormat[TextureFormat["ASTC_RGBA_6x6"] = 56] = "ASTC_RGBA_6x6";
    TextureFormat[TextureFormat["ASTC_RGBA_8x8"] = 57] = "ASTC_RGBA_8x8";
    TextureFormat[TextureFormat["ASTC_RGBA_10x10"] = 58] = "ASTC_RGBA_10x10";
    TextureFormat[TextureFormat["ASTC_RGBA_12x12"] = 59] = "ASTC_RGBA_12x12";
    TextureFormat[TextureFormat["RG16"] = 62] = "RG16";
    TextureFormat[TextureFormat["R8"] = 63] = "R8";
    TextureFormat[TextureFormat["ETC_RGB4Crunched"] = 64] = "ETC_RGB4Crunched";
    TextureFormat[TextureFormat["ETC2_RGBA8Crunched"] = 65] = "ETC2_RGBA8Crunched";
    TextureFormat[TextureFormat["RG32"] = 72] = "RG32";
    TextureFormat[TextureFormat["RGB48"] = 73] = "RGB48";
    TextureFormat[TextureFormat["RGBA64"] = 74] = "RGBA64";
})(TextureFormat || (TextureFormat = {}));
const MAX_DIM = 32768; // sanity bound — Unity textures never exceed this
/**
 * Parse a Texture2D from its object byte-range. `header` provides endianness;
 * `obj.byteStart` is RELATIVE to header.dataOffset.
 */
export function parseTexture2D(buf, header, obj) {
    const little = header.endianess === 0;
    const start = Number(header.dataOffset + obj.byteStart);
    const end = start + obj.byteSize;
    if (start < 0 || end > buf.length) {
        throw new RangeError(`parseTexture2D: object range [${start}, ${end}] outside buffer ${buf.length}`);
    }
    // Bind the reader to this object's slice so a field-order miss can't wander into the
    // next object's bytes — it throws inside this window instead.
    const r = new BinaryReader(buf.subarray(start, end), /* bigEndian */ !little, 0);
    const name = r.readAlignedString();
    r.readInt32(); // m_ForcedFallbackFormat
    r.readUInt8(); // m_DownscaleFallback
    r.readUInt8(); // m_IsAlphaChannelOptional (2020.2+)
    r.align(4);
    const width = r.readInt32();
    const height = r.readInt32();
    const completeImageSize = r.readInt32();
    r.readInt32(); // m_MipsStripped (2020.1+)
    const textureFormat = r.readInt32();
    const mipCount = r.readInt32();
    if (width <= 0 || height <= 0 || width > MAX_DIM || height > MAX_DIM) {
        throw new RangeError(`parseTexture2D("${name}"): implausible dimensions ${width}x${height} — field-order mismatch for this Unity version`);
    }
    r.readUInt8(); // m_IsReadable
    r.readUInt8(); // m_IsPreProcessed (2020.1+)
    r.readUInt8(); // m_IgnoreMasterTextureLimit (2019.3+)
    r.readUInt8(); // m_StreamingMipmaps (2018.2+)
    r.align(4);
    r.readInt32(); // m_StreamingMipmapsPriority
    r.readInt32(); // m_ImageCount
    r.readInt32(); // m_TextureDimension
    // m_TextureSettings (6 ints; MipBias is a float but width-equal)
    r.skip(6 * 4);
    r.readInt32(); // m_LightmapFormat
    r.readInt32(); // m_ColorSpace
    // m_PlatformBlob (2020.2+): Int32 length + bytes + align(4)
    const blobLen = r.readInt32();
    if (blobLen < 0 || blobLen > r.remaining) {
        throw new RangeError(`parseTexture2D("${name}"): implausible m_PlatformBlob length ${blobLen}`);
    }
    r.skip(blobLen);
    r.align(4);
    // image data: Int32 size; if >0 the bytes are inline, else they're streamed.
    const inlineSize = r.readInt32();
    let inlineData = Buffer.alloc(0);
    if (inlineSize > 0) {
        inlineData = Buffer.from(r.readBytes(inlineSize)); // copy out of the shared buffer
    }
    // m_StreamData (offset:UInt64, size:UInt32, path:AlignedString)
    let streamData = null;
    if (r.remaining >= 12) {
        const offset = r.readUInt64();
        const size = r.readUInt32();
        const path = r.remaining >= 4 ? r.readAlignedString() : '';
        if (size > 0 && path) {
            streamData = { offset, size, path };
        }
    }
    if (inlineData.length === 0 && !streamData) {
        // Some textures legitimately have completeImageSize but no stream/inline (rare);
        // surface it as a parse note rather than silently producing an empty texture.
        if (completeImageSize > 0) {
            throw new Error(`parseTexture2D("${name}"): no inline data and no stream data, but completeImageSize=${completeImageSize}`);
        }
    }
    return {
        name,
        width,
        height,
        textureFormat,
        formatName: TextureFormat[textureFormat] ?? `Unknown(${textureFormat})`,
        mipCount,
        inlineData,
        streamData,
    };
}
//# sourceMappingURL=texture2d.js.map