/**
 * ress-reader.ts — resolve a Texture2D's StreamingInfo to its raw bytes.
 *
 * Unity stores most texture pixels in a sibling stream file (.resS / .resource) and
 * references them from the .assets object via m_StreamData { offset, size, path }.
 * The `path` takes one of two shapes:
 *   - "archive:/<something>/<file>.resS"  (bundle-style virtual path; we use the basename)
 *   - "<file>.resS"                        (plain sibling filename)
 * Either way the real bytes live in a file next to the .assets in the same directory.
 *
 * This reader opens the stream file and slices [offset, offset+size). It caches open
 * file handles per stream file so decoding hundreds of textures from one .resS doesn't
 * re-open it hundreds of times. Read-only: it never writes.
 */
import { openSync, readSync, closeSync, existsSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
export class ResSReader {
    /** directory containing the .assets file (where sibling .resS/.resource live). */
    dir;
    handles = new Map();
    sizes = new Map();
    constructor(assetsFilePath) {
        this.dir = dirname(assetsFilePath);
    }
    /** Map a StreamData.path to an on-disk file path next to the .assets. */
    resolvePath(streamPath) {
        // Normalize separators, take the basename (handles "archive:/.../file.resS").
        const norm = streamPath.replace(/\\/g, '/');
        const name = basename(norm);
        return join(this.dir, name);
    }
    handleFor(filePath) {
        const cached = this.handles.get(filePath);
        if (cached !== undefined)
            return cached;
        if (!existsSync(filePath)) {
            this.handles.set(filePath, -1);
            return null;
        }
        const fd = openSync(filePath, 'r');
        this.handles.set(filePath, fd);
        this.sizes.set(filePath, statSync(filePath).size);
        return fd;
    }
    /**
     * Read the bytes a StreamingInfo points at. Returns null (with no throw) when the
     * stream file is missing or the range is out of bounds — the caller records a noted
     * decoded=0 row rather than aborting the run.
     */
    read(stream) {
        const filePath = this.resolvePath(stream.path);
        const fd = this.handleFor(filePath);
        if (fd === null || fd < 0)
            return null;
        const fileSize = this.sizes.get(filePath) ?? 0;
        const offset = Number(stream.offset);
        const size = stream.size;
        if (offset < 0 || size <= 0 || offset + size > fileSize)
            return null;
        const buf = Buffer.allocUnsafe(size);
        const got = readSync(fd, buf, 0, size, offset);
        if (got !== size)
            return null;
        return buf;
    }
    /** Close all cached handles. Call once when decoding for an .assets is done. */
    close() {
        for (const fd of this.handles.values()) {
            if (fd >= 0) {
                try {
                    closeSync(fd);
                }
                catch {
                    /* best effort */
                }
            }
        }
        this.handles.clear();
        this.sizes.clear();
    }
}
//# sourceMappingURL=ress-reader.js.map