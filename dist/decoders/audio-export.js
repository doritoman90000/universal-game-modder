/**
 * audio-export.ts — turn Unity AudioClip stream bytes into a playable file.
 *
 * No codec library is needed for the two formats Baldi uses (verified by recon):
 *   - PCM  : the stream bytes are raw little-endian samples; we prepend a 44-byte WAV header.
 *   - Vorbis: Unity stores the bytes as a COMPLETE Ogg-Vorbis stream; we write them verbatim as .ogg.
 *
 * Other formats (ADPCM, MP3, etc.) are not handled here — the caller checks compressionFormat
 * and records a noted decoded=0 row rather than producing a broken file.
 */
import { AudioCompressionFormat } from './unity/audioclip.js';
/** Build a canonical 44-byte WAV (RIFF/PCM) header for the given format + data length. */
function wavHeader(channels, sampleRate, bitsPerSample, dataLen) {
    const h = Buffer.alloc(44);
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + dataLen, 4); // ChunkSize
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
    h.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(byteRate, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(bitsPerSample, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(dataLen, 40); // Subchunk2Size
    return h;
}
/**
 * Export an AudioClip's stream bytes. Returns null (caller notes it) for an unsupported
 * compression format. `streamBytes` is what the .resource reader returned at offset/size.
 */
export function exportAudio(clip, streamBytes) {
    switch (clip.compressionFormat) {
        case AudioCompressionFormat.PCM: {
            const bits = clip.bitsPerSample > 0 ? clip.bitsPerSample : 16;
            const header = wavHeader(clip.channels, clip.frequency, bits, streamBytes.length);
            return { ext: 'wav', bytes: Buffer.concat([header, streamBytes]) };
        }
        case AudioCompressionFormat.Vorbis: {
            // Unity's Vorbis payload is a complete Ogg stream — write verbatim.
            // Sanity: a real Ogg stream begins with the "OggS" capture pattern.
            if (streamBytes.length >= 4 && streamBytes.toString('ascii', 0, 4) === 'OggS') {
                return { ext: 'ogg', bytes: streamBytes };
            }
            // Some Unity builds wrap Vorbis with an FSB5 header before the Ogg pages; if we don't
            // see OggS we cannot safely passthrough — let the caller note it rather than emit garbage.
            return null;
        }
        default:
            return null; // ADPCM / MP3 / etc. — unsupported in this slice
    }
}
//# sourceMappingURL=audio-export.js.map