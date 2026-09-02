/**
 * binary-reader.ts — a minimal, bounds-checked binary reader for Unity serialized files.
 *
 * Unity serialized files (.assets) mix endianness: the HEADER is big-endian, the
 * METADATA + object data are written in the endianness declared by the header's
 * m_Endianess byte (little-endian on desktop/Windows). This reader supports both and
 * lets the caller flip endianness per-field, exactly as the format requires.
 *
 * Every read is bounds-checked: a read past the buffer throws a precise RangeError
 * rather than returning silent garbage. This is the anti-silent-corruption discipline —
 * the bug that killed the candidate library (asset-studio-web) was an unchecked offset
 * walk that produced "Out of bounds" only by luck; here every primitive is guarded.
 */
export class BinaryReader {
    buf;
    pos;
    /** true => big-endian for multi-byte reads; false => little-endian. */
    bigEndian;
    constructor(buf, bigEndian = false, pos = 0) {
        this.buf = buf;
        this.bigEndian = bigEndian;
        this.pos = pos;
    }
    get length() {
        return this.buf.length;
    }
    get remaining() {
        return this.buf.length - this.pos;
    }
    ensure(n) {
        if (this.pos + n > this.buf.length) {
            throw new RangeError(`BinaryReader: read of ${n} byte(s) at offset ${this.pos} exceeds buffer length ${this.buf.length}`);
        }
    }
    seek(pos) {
        if (pos < 0 || pos > this.buf.length) {
            throw new RangeError(`BinaryReader: seek to ${pos} out of range [0, ${this.buf.length}]`);
        }
        this.pos = pos;
    }
    skip(n) {
        this.seek(this.pos + n);
    }
    /** Align the cursor up to the next multiple of `n` (Unity aligns to 4 after many fields). */
    align(n = 4) {
        const rem = this.pos % n;
        if (rem !== 0)
            this.skip(n - rem);
    }
    readUInt8() {
        this.ensure(1);
        const v = this.buf.readUInt8(this.pos);
        this.pos += 1;
        return v;
    }
    readInt8() {
        this.ensure(1);
        const v = this.buf.readInt8(this.pos);
        this.pos += 1;
        return v;
    }
    readUInt16() {
        this.ensure(2);
        const v = this.bigEndian ? this.buf.readUInt16BE(this.pos) : this.buf.readUInt16LE(this.pos);
        this.pos += 2;
        return v;
    }
    readInt16() {
        this.ensure(2);
        const v = this.bigEndian ? this.buf.readInt16BE(this.pos) : this.buf.readInt16LE(this.pos);
        this.pos += 2;
        return v;
    }
    readUInt32() {
        this.ensure(4);
        const v = this.bigEndian ? this.buf.readUInt32BE(this.pos) : this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return v;
    }
    readInt32() {
        this.ensure(4);
        const v = this.bigEndian ? this.buf.readInt32BE(this.pos) : this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }
    readUInt64() {
        this.ensure(8);
        const v = this.bigEndian ? this.buf.readBigUInt64BE(this.pos) : this.buf.readBigUInt64LE(this.pos);
        this.pos += 8;
        return v;
    }
    readInt64() {
        this.ensure(8);
        const v = this.bigEndian ? this.buf.readBigInt64BE(this.pos) : this.buf.readBigInt64LE(this.pos);
        this.pos += 8;
        return v;
    }
    readBytes(n) {
        this.ensure(n);
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }
    /** Read a NUL-terminated ASCII/UTF-8 string starting at the cursor. */
    readCString(maxLen = 4096) {
        const start = this.pos;
        let end = start;
        const hardStop = Math.min(this.buf.length, start + maxLen);
        while (end < hardStop && this.buf[end] !== 0)
            end++;
        const s = this.buf.toString('utf8', start, end);
        // advance past the string and its NUL terminator (if present)
        this.pos = end < this.buf.length ? end + 1 : end;
        return s;
    }
    /** Read a NUL-terminated string at an absolute offset WITHOUT moving the cursor. */
    peekCStringAt(offset, maxLen = 4096) {
        if (offset < 0 || offset >= this.buf.length)
            return '';
        let end = offset;
        const hardStop = Math.min(this.buf.length, offset + maxLen);
        while (end < hardStop && this.buf[end] !== 0)
            end++;
        return this.buf.toString('utf8', offset, end);
    }
    /**
     * Read a Unity "aligned string": an Int32 length prefix, the bytes, then align(4).
     * Used for m_Name and m_StreamData.path inside object payloads.
     */
    readAlignedString() {
        const len = this.readInt32();
        if (len < 0 || len > this.remaining) {
            throw new RangeError(`BinaryReader.readAlignedString: implausible length ${len} at offset ${this.pos} (remaining ${this.remaining})`);
        }
        const s = this.buf.toString('utf8', this.pos, this.pos + len);
        this.pos += len;
        this.align(4);
        return s;
    }
}
//# sourceMappingURL=binary-reader.js.map