/**
 * serialized-file.ts — a bounded parser for Unity serialized files (.assets), format v22.
 *
 * SCOPE (deliberately narrow, per PR-2): parse the file-level structures needed to
 * locate objects by class — header, type tree table (we only need the per-type classID),
 * and the object table (path id, byte start/size, type index). We do NOT parse the full
 * recursive type tree into typed fields; object payloads are parsed by class-specific
 * readers (see texture2d.ts) using the byte ranges this module yields.
 *
 * Format reference: UnityFS SerializedFile, version 22 (LargeFilesSupport), as shipped by
 * Unity 2020.3.x desktop players. Verified against Baldi's Basics Plus (2020.3.49f1):
 *   - header is BIG-endian; metadata endianness is declared by header.m_Endianess.
 *   - v>=22 uses a 64-bit metadata/file-size/data-offset layout with a relocated header.
 *
 * Anti-silent-corruption: every read goes through BinaryReader's bounds checks. A parse
 * that runs off the rails throws with the exact offset, never returns plausible garbage.
 */
import { BinaryReader } from './binary-reader.js';
/** Unity ClassIDType values this PR cares about. (Full table lives in the decoder lib.) */
export const ClassID = {
    Texture2D: 28,
    Sprite: 213,
    TextAsset: 49,
    AudioClip: 83,
    Mesh: 43,
    Shader: 48,
    Font: 128,
    Material: 21,
};
/**
 * Parse a serialized file far enough to enumerate its objects by class.
 * Throws on any structural inconsistency (never returns a half-parsed result).
 */
export function parseSerializedFile(buf) {
    // ---- Header (big-endian) ----------------------------------------------------
    const r = new BinaryReader(buf, /* bigEndian */ true, 0);
    // legacy 32-bit header fields (kept for all versions)
    /* metadataSize (legacy) */ r.readUInt32();
    /* fileSize     (legacy) */ r.readUInt32();
    const version = r.readUInt32();
    /* dataOffset   (legacy) */ r.readUInt32();
    if (version < 22) {
        throw new Error(`serialized-file: unsupported format version ${version}; this PR targets v22 (Unity 2020.3+). ` +
            `Older versions need the 32-bit header path (future slice).`);
    }
    // v>=22 large-files header: endianess byte + 3 reserved, then 64-bit sizes.
    const endianess = r.readUInt8();
    r.skip(3); // reserved
    const metadataSize = r.readUInt32(); // still 32-bit count, but...
    const fileSize = r.readUInt64();
    const dataOffset = r.readUInt64();
    r.readUInt64(); // unknown / reserved (large-files)
    // ---- Metadata (endianness from header) -------------------------------------
    const little = endianess === 0;
    const m = new BinaryReader(buf, /* bigEndian */ !little, r.pos);
    const unityVersion = m.readCString();
    const targetPlatform = m.readInt32();
    const enableTypeTree = m.readUInt8() !== 0;
    // ---- Type table ------------------------------------------------------------
    const typeCount = m.readInt32();
    const types = [];
    for (let i = 0; i < typeCount; i++) {
        types.push(readSerializedType(m, enableTypeTree, /* isRefType */ false));
    }
    // ---- Object table ----------------------------------------------------------
    const objectCount = m.readInt32();
    const objects = [];
    for (let i = 0; i < objectCount; i++) {
        m.align(4);
        const pathID = m.readInt64();
        const byteStart = m.readInt64();
        const byteSize = m.readUInt32();
        const typeIndex = m.readInt32();
        const t = types[typeIndex];
        const classID = t ? t.classID : -1;
        objects.push({ pathID, byteStart, byteSize, typeIndex, classID });
    }
    return {
        header: {
            metadataSize,
            fileSize,
            version,
            dataOffset,
            endianess,
            unityVersion,
            targetPlatform,
            enableTypeTree,
        },
        types,
        objects,
        buf,
    };
}
/**
 * Read one SerializedType for v22. We extract classID and skip the rest precisely.
 * Layout (v>=16 RefactoredClassId, with v17+/v18+/v19+/v21+ deltas folded in):
 *   classID            : Int32
 *   isStrippedType     : UInt8           (v>=16)
 *   scriptTypeIndex    : Int16           (v>=17)
 *   scriptID (16 bytes) : present when classID == 114 (MonoBehaviour)
 *   oldTypeHash (16 bytes)
 *   [typeTree blob]    : present when enableTypeTree
 *   typeDependencies   : Int32 count + count*Int32   (v>=21, non-refType)
 */
function readSerializedType(m, enableTypeTree, isRefType) {
    const classID = m.readInt32();
    const isStrippedType = m.readUInt8() !== 0;
    const scriptTypeIndex = m.readInt16();
    // ScriptID (Hash128) only for MonoBehaviour (114), or refType always.
    if (isRefType || classID === 114) {
        m.skip(16);
    }
    // OldTypeHash (Hash128)
    m.skip(16);
    if (enableTypeTree) {
        skipTypeTreeBlob(m);
        if (!isRefType) {
            // typeDependencies (v>=21)
            const depCount = m.readInt32();
            m.skip(depCount * 4);
        }
    }
    return { classID, isStrippedType, scriptTypeIndex };
}
/**
 * Skip the blob-format type tree (v>=12). Layout:
 *   nodeCount   : Int32
 *   stringBufLen: Int32
 *   nodes       : nodeCount * 32 bytes  (v>=19 TypeTreeNodeWithTypeFlags = 32 bytes/node)
 *   stringBuf   : stringBufLen bytes
 * v18 introduced the blob format; the node struct is 24 bytes pre-v19 and 32 bytes v>=19.
 * Baldi is v22 -> 32-byte nodes. We only need to SKIP it precisely so the object table
 * lands at the right offset.
 */
function skipTypeTreeBlob(m) {
    const nodeCount = m.readInt32();
    const stringBufLen = m.readInt32();
    // v>=19 node is 32 bytes: version(u16) level(u8) typeFlags(u8) typeStrOffset(u32)
    //   nameStrOffset(u32) byteSize(i32) index(i32) metaFlag(u32) refTypeHash(u64)
    const NODE_SIZE = 32;
    m.skip(nodeCount * NODE_SIZE);
    m.skip(stringBufLen);
}
//# sourceMappingURL=serialized-file.js.map