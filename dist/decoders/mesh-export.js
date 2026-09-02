/**
 * mesh-export.ts — turn a ParsedMesh into a standard 3D file.
 *
 * Two outputs, both hand-rolled (no native dep — same clean-install rule as the rest):
 *   - glTF binary (.glb): the primary, modern format. A glb is a tiny binary container:
 *       12-byte header + a JSON chunk (the glTF document) + a BIN chunk (the raw buffers).
 *     We emit one mesh, one primitive, with POSITION/NORMAL/TEXCOORD_0 accessors and an
 *     indices accessor. This loads in Blender, three.js, Windows 3D Viewer, etc.
 *   - Wavefront OBJ (.obj): a dead-simple text fallback (v / vn / vt / f lines). No deps,
 *     universally readable, lossy on anything fancy but perfect for a geometry sanity check.
 *
 * The glb writer is intentionally minimal and spec-correct for the single-mesh case; it is
 * not a general glTF library. Coordinates are written as-is (Unity's left-handed Y-up) — a
 * handedness flip is a downstream concern we note rather than silently apply.
 */
const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;
function pad4(n) {
    return (4 - (n % 4)) % 4;
}
/** Min/max per component, for the glTF accessor (required on POSITION). */
function minMax(arr, dim) {
    const min = new Array(dim).fill(Infinity);
    const max = new Array(dim).fill(-Infinity);
    for (let i = 0; i < arr.length; i += dim) {
        for (let c = 0; c < dim; c++) {
            const v = arr[i + c];
            if (v < min[c])
                min[c] = v;
            if (v > max[c])
                max[c] = v;
        }
    }
    return { min, max };
}
/** Export a parsed mesh to a .glb byte buffer. Throws if there are no positions. */
export function exportGlb(mesh) {
    if (!mesh.positions || mesh.vertexCount === 0) {
        throw new Error(`exportGlb("${mesh.name}"): no positions to export`);
    }
    // Build the BIN buffer: positions, [normals], [uvs], indices — each 4-byte aligned.
    const parts = [];
    let binLength = 0;
    const pushFloat = (arr) => {
        const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
        const byteOffset = binLength;
        parts.push({ data: b, byteOffset, byteLength: b.length });
        binLength += b.length + pad4(b.length);
        return byteOffset;
    };
    const posOffset = pushFloat(mesh.positions);
    const normOffset = mesh.normals ? pushFloat(mesh.normals) : -1;
    const uvOffset = mesh.uvs ? pushFloat(mesh.uvs) : -1;
    // indices as uint32
    const idxBuf = Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);
    const idxOffset = binLength;
    parts.push({ data: idxBuf, byteOffset: idxOffset, byteLength: idxBuf.length });
    binLength += idxBuf.length + pad4(idxBuf.length);
    const bin = Buffer.alloc(binLength);
    for (const part of parts)
        part.data.copy(bin, part.byteOffset);
    // Accessors + bufferViews.
    const posMM = minMax(mesh.positions, 3);
    const bufferViews = [];
    const accessors = [];
    const addView = (byteOffset, byteLength, target) => {
        bufferViews.push({ buffer: 0, byteOffset, byteLength, target });
        return bufferViews.length - 1;
    };
    const addAccessor = (a) => {
        accessors.push(a);
        return accessors.length - 1;
    };
    const posView = addView(posOffset, mesh.positions.byteLength, TARGET_ARRAY_BUFFER);
    const posAcc = addAccessor({
        bufferView: posView,
        componentType: COMPONENT_FLOAT,
        count: mesh.vertexCount,
        type: 'VEC3',
        min: posMM.min,
        max: posMM.max,
    });
    const attributes = { POSITION: posAcc };
    if (mesh.normals && normOffset >= 0) {
        const v = addView(normOffset, mesh.normals.byteLength, TARGET_ARRAY_BUFFER);
        attributes.NORMAL = addAccessor({ bufferView: v, componentType: COMPONENT_FLOAT, count: mesh.vertexCount, type: 'VEC3' });
    }
    if (mesh.uvs && uvOffset >= 0) {
        const v = addView(uvOffset, mesh.uvs.byteLength, TARGET_ARRAY_BUFFER);
        attributes.TEXCOORD_0 = addAccessor({ bufferView: v, componentType: COMPONENT_FLOAT, count: mesh.vertexCount, type: 'VEC2' });
    }
    const idxView = addView(idxOffset, idxBuf.length, TARGET_ELEMENT_ARRAY_BUFFER);
    const idxAcc = addAccessor({
        bufferView: idxView,
        componentType: COMPONENT_UINT,
        count: mesh.indices.length,
        type: 'SCALAR',
    });
    const gltf = {
        asset: { version: '2.0', generator: 'autopsy-engine/decode_assets' },
        buffers: [{ byteLength: binLength }],
        bufferViews,
        accessors,
        meshes: [{ name: mesh.name, primitives: [{ attributes, indices: idxAcc, mode: 4 /* TRIANGLES */ }] }],
        nodes: [{ name: mesh.name, mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
    };
    let jsonStr = JSON.stringify(gltf);
    // JSON chunk must be 4-byte aligned, padded with spaces.
    const jsonPad = pad4(Buffer.byteLength(jsonStr, 'utf8'));
    jsonStr += ' '.repeat(jsonPad);
    const jsonBuf = Buffer.from(jsonStr, 'utf8');
    // BIN chunk padded with zeros (already aligned via binLength).
    const totalLength = 12 + 8 + jsonBuf.length + 8 + bin.length;
    const out = Buffer.alloc(totalLength);
    let o = 0;
    out.writeUInt32LE(GLB_MAGIC, o);
    o += 4;
    out.writeUInt32LE(GLB_VERSION, o);
    o += 4;
    out.writeUInt32LE(totalLength, o);
    o += 4;
    out.writeUInt32LE(jsonBuf.length, o);
    o += 4;
    out.writeUInt32LE(CHUNK_JSON, o);
    o += 4;
    jsonBuf.copy(out, o);
    o += jsonBuf.length;
    out.writeUInt32LE(bin.length, o);
    o += 4;
    out.writeUInt32LE(CHUNK_BIN, o);
    o += 4;
    bin.copy(out, o);
    o += bin.length;
    return out;
}
/** Export a parsed mesh to Wavefront OBJ text. Simple, lossless on geometry, no deps. */
export function exportObj(mesh) {
    if (!mesh.positions || mesh.vertexCount === 0) {
        throw new Error(`exportObj("${mesh.name}"): no positions to export`);
    }
    const lines = [`# ${mesh.name} — exported by autopsy-engine/decode_assets`, `o ${mesh.name}`];
    for (let i = 0; i < mesh.vertexCount; i++) {
        lines.push(`v ${mesh.positions[i * 3]} ${mesh.positions[i * 3 + 1]} ${mesh.positions[i * 3 + 2]}`);
    }
    if (mesh.normals) {
        for (let i = 0; i < mesh.vertexCount; i++) {
            lines.push(`vn ${mesh.normals[i * 3]} ${mesh.normals[i * 3 + 1]} ${mesh.normals[i * 3 + 2]}`);
        }
    }
    if (mesh.uvs) {
        for (let i = 0; i < mesh.vertexCount; i++) {
            lines.push(`vt ${mesh.uvs[i * 2]} ${mesh.uvs[i * 2 + 1]}`);
        }
    }
    const hasN = !!mesh.normals;
    const hasUV = !!mesh.uvs;
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
        const a = mesh.indices[i] + 1;
        const b = mesh.indices[i + 1] + 1;
        const c = mesh.indices[i + 2] + 1;
        const ref = (v) => (hasUV && hasN ? `${v}/${v}/${v}` : hasN ? `${v}//${v}` : hasUV ? `${v}/${v}` : `${v}`);
        lines.push(`f ${ref(a)} ${ref(b)} ${ref(c)}`);
    }
    return Buffer.from(lines.join('\n') + '\n', 'utf8');
}
//# sourceMappingURL=mesh-export.js.map