/**
 * mesh.ts — parse a Unity Mesh object payload (Unity 2020.3 / format v22, typeTree DISABLED)
 * into vertex positions/normals/uvs + triangle indices, for the PLAIN (uncompressed) case.
 *
 * SCOPE (first slice, deliberately bounded):
 *   - Plain meshes only: m_MeshCompression == 0. A compressed mesh (PackedBitVector) is
 *     detected and reported as unsupported (the caller writes a noted decoded=0 row) — NOT
 *     mis-parsed. Skinned/blend-shape extras are skipped (we read past them), but positions,
 *     normals, uvs, and the index buffer are extracted.
 *
 * Reference field order: Unity 2020.3 Mesh (AssetStudio Mesh.cs), little-endian, no type tree.
 * The layout below is the 2020.3-era order. Because there is NO type tree to self-describe the
 * fields, this is positional — every array is length-prefixed (Int32) and we read or skip each
 * in order. A field-order miss is caught by sanity bounds (implausible counts throw) rather than
 * silently producing garbage geometry.
 *
 * Field order (2020.3, condensed — arrays are Int32-count-prefixed unless noted):
 *   m_Name : AlignedString
 *   m_SubMeshes : count * SubMesh{ firstByte:u32, indexCount:u32, topology:i32, baseVertex:u32,
 *                                  firstVertex:u32, vertexCount:u32, localAABB:{center:3f, extent:3f} }
 *   m_Shapes (BlendShapeData) : vertices[] + shapes[] + channels[] + fullWeights[]  (skipped)
 *   m_BindPose : count * 16 floats (Matrix4x4)   (skipped)
 *   m_BoneNameHashes : count * u32               (skipped)
 *   m_RootBoneNameHash : u32
 *   m_BonesAABB : count * (6 floats)   (2019+)   (skipped)
 *   m_VariableBoneCountWeights : count * u32     (2019+) (skipped)
 *   m_MeshCompression : u8
 *   m_IsReadable : u8 ; m_KeepVertices : u8 ; m_KeepIndices : u8 ; align(4)
 *   m_IndexFormat : i32   (0 = UInt16, 1 = UInt32)   (2017.4+)
 *   m_IndexBuffer : count(u32) * byte ; align(4)
 *   m_VertexData : { m_CurrentChannels?(pre-2018) , m_VertexCount:u32, m_Channels[]:ChannelInfo,
 *                    m_DataSize: count*byte ; align(4) }
 *   ... (compression-related PackedBitVectors, m_StreamData at the end)
 *   m_StreamData : { offset:u32(or u64 late), size:u32, path:AlignedString }  (NOT consumed in this slice)
 */
import { BinaryReader } from './binary-reader.js';
import { extractAttribute } from './vertex-data.js';
const MAX_COUNT = 50_000_000; // sanity bound for any length-prefixed array
function readCount(r, what) {
    const n = r.readInt32();
    if (n < 0 || n > MAX_COUNT) {
        throw new RangeError(`mesh: implausible ${what} count ${n} at offset ${r.pos} — field-order mismatch`);
    }
    return n;
}
export function parseMesh(buf, header, obj) {
    const little = header.endianess === 0;
    const start = Number(header.dataOffset + obj.byteStart);
    const end = start + obj.byteSize;
    if (start < 0 || end > buf.length) {
        throw new RangeError(`parseMesh: object range [${start}, ${end}] outside buffer ${buf.length}`);
    }
    const r = new BinaryReader(buf.subarray(start, end), !little, 0);
    const name = r.readAlignedString();
    // --- m_SubMeshes ---
    const subMeshCount = readCount(r, 'subMesh');
    const subMeshes = [];
    for (let i = 0; i < subMeshCount; i++) {
        const firstByte = r.readUInt32();
        const indexCount = r.readUInt32();
        const topology = r.readInt32();
        /* baseVertex */ r.readUInt32();
        const firstVertex = r.readUInt32();
        const vertexCount = r.readUInt32();
        // localAABB: Vector3 center + Vector3 extent (6 floats)
        r.skip(6 * 4);
        subMeshes.push({ firstByte, indexCount, topology, firstVertex, vertexCount });
    }
    // --- m_Shapes (BlendShapeData) : skip the four arrays ---
    skipBlendShapeData(r);
    // --- m_BindPose : count * Matrix4x4 (16 floats) ---
    const bindPoseCount = readCount(r, 'bindPose');
    r.skip(bindPoseCount * 16 * 4);
    // --- m_BoneNameHashes : count * u32 ---
    const boneNameCount = readCount(r, 'boneNameHash');
    r.skip(boneNameCount * 4);
    // --- m_RootBoneNameHash : u32 ---
    r.readUInt32();
    // --- m_BonesAABB : count * (Vector3 min + Vector3 max = 6 floats) (2019+) ---
    const bonesAABBCount = readCount(r, 'bonesAABB');
    r.skip(bonesAABBCount * 6 * 4);
    // --- m_VariableBoneCountWeights : count * u32 (2019+) ---
    const vbcwCount = readCount(r, 'variableBoneCountWeights');
    r.skip(vbcwCount * 4);
    // --- compression + flags ---
    const meshCompression = r.readUInt8();
    /* m_IsReadable */ r.readUInt8();
    /* m_KeepVertices */ r.readUInt8();
    /* m_KeepIndices */ r.readUInt8();
    r.align(4);
    const compressed = meshCompression !== 0;
    // --- m_IndexFormat (2017.4+): 0 = UInt16, 1 = UInt32 ---
    const indexFormat = r.readInt32();
    // --- m_IndexBuffer ---
    const indexBufLen = readCount(r, 'indexBuffer');
    const indexBytes = Buffer.from(r.readBytes(indexBufLen));
    r.align(4);
    // If compressed, the vertex data lives in PackedBitVectors we don't unpack in this slice.
    // Bail early with the metadata we have; the caller records a noted decoded=0 row.
    if (compressed) {
        return {
            name,
            compressed: true,
            vertexCount: 0,
            positions: null,
            normals: null,
            uvs: null,
            indices: new Uint32Array(0),
            subMeshCount,
            attributesExported: [],
        };
    }
    // --- m_VertexData ---
    const vertexCount = r.readUInt32();
    const channelCount = readCount(r, 'vertexChannel');
    const channels = [];
    for (let i = 0; i < channelCount; i++) {
        const stream = r.readUInt8();
        const offset = r.readUInt8();
        const format = r.readUInt8();
        const dimension = r.readUInt8();
        channels.push({ stream, offset, format, dimension });
    }
    const dataSize = readCount(r, 'vertexDataSize');
    let vertexBlob = Buffer.from(r.readBytes(dataSize));
    r.align(4);
    // Vertex data: for Baldi (verified) the vertex blob is INLINE, so it is populated above and
    // attributes extract directly. STREAMED vertex data (when m_DataSize is empty and the bytes
    // live in a sibling .resS via m_StreamData) is NOT implemented in this slice: we do not read
    // m_StreamData here, the blob stays empty, positions come back null, and decode_assets writes
    // a noted decoded=0 row ("streamed vertex data not yet supported"). A future slice will add
    // the .resS resolution for meshes (textures already do this via ResSReader).
    const vd = { vertexCount, channels, data: vertexBlob };
    // Unity channel index convention: 0=Position, 1=Normal, 2=Tangent, 3=Color, 4=UV0, 5=UV1...
    const positions = extractAttribute(vd, 0, 3);
    const normals = extractAttribute(vd, 1, 3);
    const uvs = extractAttribute(vd, 4, 2);
    const attributesExported = [];
    if (positions)
        attributesExported.push('POSITION');
    if (normals)
        attributesExported.push('NORMAL');
    if (uvs)
        attributesExported.push('TEXCOORD_0');
    // --- indices: decode per m_IndexFormat ---
    const indices = decodeIndices(indexBytes, indexFormat);
    return {
        name,
        compressed: false,
        vertexCount,
        positions,
        normals,
        uvs,
        indices,
        subMeshCount,
        attributesExported,
    };
}
/** Skip Unity's BlendShapeData block (4 length-prefixed arrays). */
function skipBlendShapeData(r) {
    // m_Vertices : count * BlendShapeVertex (Vector3 vertex + Vector3 normal + Vector3 tangent + u32 index = 10*4)
    const vCount = readCount(r, 'blendVertices');
    r.skip(vCount * (9 * 4 + 4));
    // m_Shapes : count * MeshBlendShape (firstVertex:u32, vertexCount:u32, hasNormals:bool, hasTangents:bool, align)
    const sCount = readCount(r, 'blendShapes');
    for (let i = 0; i < sCount; i++) {
        r.skip(4 + 4); // firstVertex + vertexCount
        r.readUInt8(); // hasNormals
        r.readUInt8(); // hasTangents
        r.align(4);
    }
    // m_Channels : count * MeshBlendShapeChannel (name:AlignedString, nameHash:u32, frameIndex:i32, frameCount:i32)
    const cCount = readCount(r, 'blendChannels');
    for (let i = 0; i < cCount; i++) {
        r.readAlignedString();
        r.skip(4 + 4 + 4);
    }
    // m_FullWeights : count * float
    const wCount = readCount(r, 'blendWeights');
    r.skip(wCount * 4);
}
/** Decode the index buffer into a flat Uint32Array per m_IndexFormat (0=u16, 1=u32). */
function decodeIndices(indexBytes, indexFormat) {
    if (indexFormat === 1) {
        const n = Math.floor(indexBytes.length / 4);
        const out = new Uint32Array(n);
        for (let i = 0; i < n; i++)
            out[i] = indexBytes.readUInt32LE(i * 4);
        return out;
    }
    // default UInt16
    const n = Math.floor(indexBytes.length / 2);
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++)
        out[i] = indexBytes.readUInt16LE(i * 2);
    return out;
}
//# sourceMappingURL=mesh.js.map