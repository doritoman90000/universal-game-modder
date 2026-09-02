/**
 * png-encode.ts — encode tightly-packed RGBA8 pixels to a PNG buffer.
 *
 * Unity textures are stored bottom-up (origin at the lower-left). PNG (and every image
 * viewer) expects top-down. We flip vertically here so the exported PNG looks correct
 * when opened — the single most common "the decode worked but the image is upside down"
 * bug, handled once, centrally.
 *
 * Uses pngjs (pure-JS, no native compile — same install-cleanliness rule as better-sqlite3).
 */
import { PNG } from 'pngjs';
/**
 * @param rgba   tightly packed RGBA8, length === width*height*4, bottom-up (Unity order)
 * @param width  texture width in pixels
 * @param height texture height in pixels
 * @returns PNG file bytes (top-down, RGBA)
 */
export function encodePng(rgba, width, height) {
    const expected = width * height * 4;
    if (rgba.length < expected) {
        throw new RangeError(`encodePng: rgba length ${rgba.length} < expected ${expected} for ${width}x${height}`);
    }
    const png = new PNG({ width, height, colorType: 6 /* RGBA */ });
    const rowBytes = width * 4;
    // Flip vertically: source row (height-1-y) -> destination row y.
    for (let y = 0; y < height; y++) {
        const srcStart = (height - 1 - y) * rowBytes;
        const dstStart = y * rowBytes;
        rgba.copy(png.data, dstStart, srcStart, srcStart + rowBytes);
    }
    return PNG.sync.write(png);
}
//# sourceMappingURL=png-encode.js.map