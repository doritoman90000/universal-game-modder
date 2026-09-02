/**
 * audioclip.ts — parse a Unity AudioClip object (Unity 2020.3 / format v22, typeTree DISABLED).
 *
 * AudioClip stores its audio in a streamed resource (.resource / .resS), referenced by an
 * m_Resource { source, offset, size, compressionFormat } block. The audio is NOT inside the
 * .assets file — the .assets holds only the metadata + the pointer.
 *
 * SCOPE (PR-2.3 first slice): extract the metadata (name, channels, frequency, bits) and the
 * StreamedResource pointer. The actual sample bytes are pulled by the caller via the .resource
 * stream reader. Two on-disk formats are handled downstream without a codec library:
 *   - PCM (compressionFormat 0): raw little-endian samples -> wrap in a WAV header.
 *   - Vorbis (compressionFormat 1): the bytes ARE a complete Ogg-Vorbis stream -> write .ogg.
 * Other compression formats (ADPCM/MP3/etc.) are reported unsupported (noted decoded=0 row).
 *
 * Reference field order: Unity 2020.3 AudioClip (AssetStudio AudioClip.cs), little-endian.
 *   m_Name : AlignedString
 *   m_LoadType : Int32
 *   m_Channels : Int32
 *   m_Frequency : Int32
 *   m_BitsPerSample : Int32
 *   m_Length : float
 *   m_IsTrackerFormat : bool ; align(4)
 *   m_SubsoundIndex : Int32
 *   m_PreloadAudioData : bool ; m_LoadInBackground : bool ; m_Legacy3D : bool ; align(4)
 *   m_Resource : StreamedResource { m_Source:AlignedString, m_Offset:UInt64, m_Size:UInt64 }
 *   m_CompressionFormat : Int32
 */
import { BinaryReader } from './binary-reader.js';
/** Unity AudioCompressionFormat. */
export var AudioCompressionFormat;
(function (AudioCompressionFormat) {
    AudioCompressionFormat[AudioCompressionFormat["PCM"] = 0] = "PCM";
    AudioCompressionFormat[AudioCompressionFormat["Vorbis"] = 1] = "Vorbis";
    AudioCompressionFormat[AudioCompressionFormat["ADPCM"] = 2] = "ADPCM";
    AudioCompressionFormat[AudioCompressionFormat["MP3"] = 3] = "MP3";
    AudioCompressionFormat[AudioCompressionFormat["VAG"] = 4] = "VAG";
    AudioCompressionFormat[AudioCompressionFormat["HEVAG"] = 5] = "HEVAG";
    AudioCompressionFormat[AudioCompressionFormat["XMA"] = 6] = "XMA";
    AudioCompressionFormat[AudioCompressionFormat["AAC"] = 7] = "AAC";
    AudioCompressionFormat[AudioCompressionFormat["GCADPCM"] = 8] = "GCADPCM";
    AudioCompressionFormat[AudioCompressionFormat["ATRAC9"] = 9] = "ATRAC9";
})(AudioCompressionFormat || (AudioCompressionFormat = {}));
export function parseAudioClip(buf, header, obj) {
    const little = header.endianess === 0;
    const start = Number(header.dataOffset + obj.byteStart);
    const end = start + obj.byteSize;
    if (start < 0 || end > buf.length) {
        throw new RangeError(`parseAudioClip: object range [${start}, ${end}] outside buffer ${buf.length}`);
    }
    const r = new BinaryReader(buf.subarray(start, end), !little, 0);
    const name = r.readAlignedString();
    /* m_LoadType */ r.readInt32();
    const channels = r.readInt32();
    const frequency = r.readInt32();
    const bitsPerSample = r.readInt32();
    const length = r.buf.readFloatLE(r.pos);
    r.pos += 4;
    r.readUInt8(); // m_IsTrackerFormat
    r.align(4);
    r.readInt32(); // m_SubsoundIndex
    r.readUInt8(); // m_PreloadAudioData
    r.readUInt8(); // m_LoadInBackground
    r.readUInt8(); // m_Legacy3D
    r.align(4);
    // m_Resource (StreamedResource)
    const source = r.readAlignedString();
    const offset = r.readUInt64();
    const sizeBig = r.readUInt64();
    const compressionFormat = r.readInt32();
    const size = Number(sizeBig);
    if (channels <= 0 || channels > 32 || frequency <= 0 || frequency > 384000 || size < 0) {
        throw new RangeError(`parseAudioClip("${name}"): implausible fields (ch=${channels} freq=${frequency} size=${size}) — field-order mismatch`);
    }
    return {
        name,
        channels,
        frequency,
        bitsPerSample,
        length,
        compressionFormat,
        compressionName: AudioCompressionFormat[compressionFormat] ?? `comp${compressionFormat}`,
        source,
        offset,
        size,
    };
}
//# sourceMappingURL=audioclip.js.map