import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { basename } from 'path';
import { session } from '../../core/session.js';
import { logger } from '../../utils/logger.js';
/**
 * Native tool implementations ported from binary-analyzer-ultra and smart-binary-analyzer.
 * These run directly in the Node.js process without spawning child MCP servers.
 */
function nativeTool(name, description, inputSchema, handler) {
    return {
        name,
        description,
        inputSchema,
        handler: async (args) => {
            const start = Date.now();
            logger.toolStart(name, 'native');
            try {
                const result = await handler(args);
                const duration = Date.now() - start;
                logger.toolComplete(name, 'native', duration, true);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: true, backend: 'native' });
                return result;
            }
            catch (err) {
                const duration = Date.now() - start;
                const msg = err instanceof Error ? err.message : String(err);
                logger.toolComplete(name, 'native', duration, false);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: false, backend: 'native' });
                return `ERROR: ${msg}`;
            }
        },
    };
}
// ============================================================
// PE / Binary Analysis Tools
// ============================================================
function readPEHeaders(buffer) {
    if (buffer.length < 64)
        return { error: 'File too small for PE' };
    const magic = buffer.readUInt16LE(0);
    if (magic !== 0x5A4D)
        return { error: 'Not a PE file (missing MZ signature)' };
    const peOffset = buffer.readUInt32LE(60);
    if (peOffset + 4 > buffer.length)
        return { error: 'Invalid PE offset' };
    const peSignature = buffer.readUInt32LE(peOffset);
    if (peSignature !== 0x00004550)
        return { error: 'Invalid PE signature' };
    const coffOffset = peOffset + 4;
    const machine = buffer.readUInt16LE(coffOffset);
    const numberOfSections = buffer.readUInt16LE(coffOffset + 2);
    const timeDateStamp = buffer.readUInt32LE(coffOffset + 4);
    const sizeOfOptionalHeader = buffer.readUInt16LE(coffOffset + 16);
    const characteristics = buffer.readUInt16LE(coffOffset + 18);
    const optionalOffset = coffOffset + 20;
    const optionalMagic = buffer.readUInt16LE(optionalOffset);
    const is64Bit = optionalMagic === 0x20B;
    // Read Data Directories
    let dataDirectoryOffset;
    let numberOfRvaAndSizes;
    if (is64Bit) {
        dataDirectoryOffset = optionalOffset + 112;
        numberOfRvaAndSizes = buffer.readUInt32LE(optionalOffset + 108);
    }
    else {
        dataDirectoryOffset = optionalOffset + 96;
        numberOfRvaAndSizes = buffer.readUInt32LE(optionalOffset + 92);
    }
    const dataDirectories = [];
    const ddNames = [
        'Export', 'Import', 'Resource', 'Exception', 'Security', 'BaseRelocation',
        'Debug', 'Architecture', 'GlobalPtr', 'TLS', 'LoadConfig', 'BoundImport',
        'IAT', 'DelayImport', 'CLR Runtime Header', 'Reserved',
    ];
    for (let i = 0; i < Math.min(numberOfRvaAndSizes, 16); i++) {
        const offset = dataDirectoryOffset + i * 8;
        if (offset + 8 > buffer.length)
            break;
        dataDirectories.push({
            name: ddNames[i] || `Directory ${i}`,
            rva: buffer.readUInt32LE(offset),
            size: buffer.readUInt32LE(offset + 4),
        });
    }
    // Read Sections
    const sectionOffset = optionalOffset + sizeOfOptionalHeader;
    const sections = [];
    for (let i = 0; i < numberOfSections; i++) {
        const off = sectionOffset + i * 40;
        if (off + 40 > buffer.length)
            break;
        const nameBytes = buffer.subarray(off, off + 8);
        const name = nameBytes.toString('ascii').replace(/\0+$/, '');
        sections.push({
            name,
            virtualSize: buffer.readUInt32LE(off + 8),
            virtualAddress: buffer.readUInt32LE(off + 12),
            rawDataSize: buffer.readUInt32LE(off + 16),
            rawDataPointer: buffer.readUInt32LE(off + 20),
            characteristics: buffer.readUInt32LE(off + 36),
        });
    }
    const machineTypes = {
        0x14C: 'x86',
        0x8664: 'x64',
        0xAA64: 'ARM64',
        0x1C0: 'ARM',
    };
    const clrDirectory = dataDirectories.find(d => d.name === 'CLR Runtime Header');
    const isManaged = clrDirectory && clrDirectory.rva > 0;
    return {
        architecture: machineTypes[machine] || `Unknown (0x${machine.toString(16)})`,
        is64Bit,
        isManaged,
        isDLL: (characteristics & 0x2000) !== 0,
        numberOfSections,
        timeDateStamp: new Date(timeDateStamp * 1000).toISOString(),
        dataDirectories: dataDirectories.filter(d => d.rva > 0 || d.size > 0),
        sections,
    };
}
export function getNativeToolDefinitions() {
    return [
        // === PE Analysis ===
        nativeTool('analyze_pe_full', 'Full PE (Portable Executable) analysis. Shows headers, sections, data directories, and whether it is managed (.NET) or native.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to PE file (.exe or .dll)' },
            },
            required: ['file_path'],
        }, async (args) => {
            const filePath = args.file_path;
            const buffer = readFileSync(filePath);
            const result = readPEHeaders(buffer);
            return JSON.stringify({
                file: basename(filePath),
                size: buffer.length,
                ...result,
            }, null, 2);
        }),
        nativeTool('analyze_file_format', 'Detect file format from magic bytes. Works with PE, ELF, Mach-O, ZIP, Java class, and other formats.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
            },
            required: ['file_path'],
        }, async (args) => {
            const filePath = args.file_path;
            const buffer = readFileSync(filePath, { flag: 'r' });
            const header = buffer.subarray(0, Math.min(16, buffer.length));
            const formats = [
                { magic: [0x4D, 0x5A], name: 'PE', description: 'Windows Portable Executable (EXE/DLL)' },
                { magic: [0x7F, 0x45, 0x4C, 0x46], name: 'ELF', description: 'Linux/Unix Executable' },
                { magic: [0xCA, 0xFE, 0xBA, 0xBE], name: 'Java Class / Mach-O FAT', description: 'Java class file or Mach-O fat binary' },
                { magic: [0x50, 0x4B, 0x03, 0x04], name: 'ZIP/JAR', description: 'ZIP archive (possibly JAR, APK, or EPUB)' },
                { magic: [0x52, 0x61, 0x72, 0x21], name: 'RAR', description: 'RAR archive' },
                { magic: [0x89, 0x50, 0x4E, 0x47], name: 'PNG', description: 'PNG image' },
            ];
            for (const fmt of formats) {
                if (fmt.magic.every((b, i) => header[i] === b)) {
                    const info = {
                        file: basename(filePath),
                        size: buffer.length,
                        format: fmt.name,
                        description: fmt.description,
                    };
                    // Extra PE analysis
                    if (fmt.name === 'PE') {
                        const pe = readPEHeaders(buffer);
                        info.pe = pe;
                    }
                    return JSON.stringify(info, null, 2);
                }
            }
            return JSON.stringify({
                file: basename(filePath),
                size: buffer.length,
                format: 'Unknown',
                headerHex: header.toString('hex'),
                headerAscii: header.toString('ascii').replace(/[^\x20-\x7e]/g, '.'),
            }, null, 2);
        }),
        // === Hex Operations ===
        nativeTool('hex_read', 'Read raw bytes from a file at a specific offset.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                offset: { type: 'number', description: 'Byte offset to start reading' },
                length: { type: 'number', description: 'Number of bytes to read (default 256)' },
            },
            required: ['file_path', 'offset'],
        }, async (args) => {
            const filePath = args.file_path;
            const offset = args.offset;
            const length = args.length || 256;
            const fd = readFileSync(filePath);
            const data = fd.subarray(offset, offset + length);
            // Format as hex dump
            const lines = [];
            for (let i = 0; i < data.length; i += 16) {
                const chunk = data.subarray(i, Math.min(i + 16, data.length));
                const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
                const ascii = Array.from(chunk).map(b => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
                lines.push(`${(offset + i).toString(16).padStart(8, '0')}  ${hex.padEnd(48)}  ${ascii}`);
            }
            return lines.join('\n');
        }),
        nativeTool('hex_write', 'Write raw bytes to a file at a specific offset.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                offset: { type: 'number', description: 'Byte offset to write at' },
                hex_data: { type: 'string', description: 'Hex string to write (e.g. "90 90 90" or "909090")' },
            },
            required: ['file_path', 'offset', 'hex_data'],
        }, async (args) => {
            const filePath = args.file_path;
            const offset = args.offset;
            const hexStr = args.hex_data.replace(/\s+/g, '');
            const bytes = Buffer.from(hexStr, 'hex');
            const fd = readFileSync(filePath);
            bytes.copy(fd, offset);
            writeFileSync(filePath, fd);
            return `Wrote ${bytes.length} bytes at offset 0x${offset.toString(16)}`;
        }),
        nativeTool('hex_search', 'Search for a hex pattern in a binary file.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                hex_pattern: { type: 'string', description: 'Hex pattern to search for (e.g. "48 8B 05 ?? ?? ?? ??")' },
                max_results: { type: 'number', description: 'Max results (default 20)' },
            },
            required: ['file_path', 'hex_pattern'],
        }, async (args) => {
            const filePath = args.file_path;
            const pattern = args.hex_pattern.trim();
            const maxResults = args.max_results || 20;
            const buffer = readFileSync(filePath);
            const patternBytes = pattern.split(/\s+/).map(b => b === '??' ? null : parseInt(b, 16));
            const results = [];
            for (let i = 0; i <= buffer.length - patternBytes.length && results.length < maxResults; i++) {
                let match = true;
                for (let j = 0; j < patternBytes.length; j++) {
                    if (patternBytes[j] !== null && buffer[i + j] !== patternBytes[j]) {
                        match = false;
                        break;
                    }
                }
                if (match)
                    results.push(i);
            }
            return JSON.stringify({
                file: basename(filePath),
                pattern,
                matchCount: results.length,
                offsets: results.map(o => `0x${o.toString(16)}`),
            }, null, 2);
        }),
        nativeTool('hex_replace', 'Replace bytes at a specific offset or replace a pattern throughout the file.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                search_hex: { type: 'string', description: 'Hex pattern to find' },
                replace_hex: { type: 'string', description: 'Hex pattern to replace with (must be same length)' },
                offset: { type: 'number', description: 'Specific offset to replace at (if provided, ignores search_hex)' },
            },
            required: ['file_path', 'replace_hex'],
        }, async (args) => {
            const filePath = args.file_path;
            const replaceHex = args.replace_hex.replace(/\s+/g, '');
            const replaceBytes = Buffer.from(replaceHex, 'hex');
            const buffer = readFileSync(filePath);
            if (args.offset !== undefined) {
                const offset = args.offset;
                replaceBytes.copy(buffer, offset);
                writeFileSync(filePath, buffer);
                return `Replaced ${replaceBytes.length} bytes at offset 0x${offset.toString(16)}`;
            }
            const searchHex = (args.search_hex || '').replace(/\s+/g, '');
            if (!searchHex)
                return 'ERROR: Either offset or search_hex must be provided';
            const searchBytes = Buffer.from(searchHex, 'hex');
            if (searchBytes.length !== replaceBytes.length) {
                return `ERROR: Search (${searchBytes.length} bytes) and replace (${replaceBytes.length} bytes) must be same length`;
            }
            let count = 0;
            for (let i = 0; i <= buffer.length - searchBytes.length; i++) {
                if (buffer.subarray(i, i + searchBytes.length).equals(searchBytes)) {
                    replaceBytes.copy(buffer, i);
                    count++;
                    i += searchBytes.length - 1;
                }
            }
            writeFileSync(filePath, buffer);
            return `Replaced ${count} occurrence(s) of pattern`;
        }),
        // === Pattern Scan ===
        nativeTool('pattern_scan', 'IDA-style pattern scan with wildcards. Searches for byte patterns in PE sections.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to PE file' },
                pattern: { type: 'string', description: 'Pattern with wildcards (e.g. "48 8B 05 ?? ?? ?? ?? 48 85 C0")' },
                section: { type: 'string', description: 'PE section to search (default: .text)' },
                max_results: { type: 'number', description: 'Max results (default 10)' },
            },
            required: ['file_path', 'pattern'],
        }, async (args) => {
            const filePath = args.file_path;
            const pattern = args.pattern.trim();
            const maxResults = args.max_results || 10;
            const buffer = readFileSync(filePath);
            const patternBytes = pattern.split(/\s+/).map(b => (b === '??' || b === '?') ? null : parseInt(b, 16));
            const results = [];
            for (let i = 0; i <= buffer.length - patternBytes.length && results.length < maxResults; i++) {
                let match = true;
                for (let j = 0; j < patternBytes.length; j++) {
                    if (patternBytes[j] !== null && buffer[i + j] !== patternBytes[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    const ctx = buffer.subarray(i, Math.min(i + 32, buffer.length));
                    results.push({
                        offset: `0x${i.toString(16)}`,
                        context: Array.from(ctx).map(b => b.toString(16).padStart(2, '0')).join(' '),
                    });
                }
            }
            return JSON.stringify({
                file: basename(filePath),
                pattern,
                matchCount: results.length,
                matches: results,
            }, null, 2);
        }),
        nativeTool('pattern_scan_all', 'Scan entire file for a pattern (not limited to a section).', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to file' },
                pattern: { type: 'string', description: 'Pattern with wildcards' },
                max_results: { type: 'number', description: 'Max results (default 50)' },
            },
            required: ['file_path', 'pattern'],
        }, async (args) => {
            // Same as pattern_scan but explicitly full-file
            const filePath = args.file_path;
            const pattern = args.pattern.trim();
            const maxResults = args.max_results || 50;
            const buffer = readFileSync(filePath);
            const patternBytes = pattern.split(/\s+/).map(b => (b === '??' || b === '?') ? null : parseInt(b, 16));
            const offsets = [];
            for (let i = 0; i <= buffer.length - patternBytes.length && offsets.length < maxResults; i++) {
                let match = true;
                for (let j = 0; j < patternBytes.length; j++) {
                    if (patternBytes[j] !== null && buffer[i + j] !== patternBytes[j]) {
                        match = false;
                        break;
                    }
                }
                if (match)
                    offsets.push(`0x${i.toString(16)}`);
            }
            return JSON.stringify({ file: basename(filePath), pattern, matchCount: offsets.length, offsets }, null, 2);
        }),
        // === String Extraction ===
        nativeTool('extract_strings_advanced', 'Extract ASCII and UTF-16 strings from a binary file with filtering.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the binary file' },
                filter: { type: 'string', description: 'Optional filter (case-insensitive substring match)' },
                min_length: { type: 'number', description: 'Minimum string length (default 4)' },
                max_results: { type: 'number', description: 'Max results (default 500)' },
                encoding: { type: 'string', description: 'Encoding: ascii, utf16, both (default: both)' },
            },
            required: ['file_path'],
        }, async (args) => {
            const filePath = args.file_path;
            const filter = args.filter?.toLowerCase();
            const minLength = args.min_length || 4;
            const maxResults = args.max_results || 500;
            const encoding = args.encoding || 'both';
            const buffer = readFileSync(filePath);
            const strings = [];
            // ASCII strings
            if (encoding === 'ascii' || encoding === 'both') {
                let current = '';
                let startOffset = 0;
                for (let i = 0; i < buffer.length && strings.length < maxResults; i++) {
                    const b = buffer[i];
                    if (b >= 0x20 && b <= 0x7e) {
                        if (current.length === 0)
                            startOffset = i;
                        current += String.fromCharCode(b);
                    }
                    else {
                        if (current.length >= minLength) {
                            if (!filter || current.toLowerCase().includes(filter)) {
                                strings.push({ offset: `0x${startOffset.toString(16)}`, encoding: 'ASCII', value: current });
                            }
                        }
                        current = '';
                    }
                }
            }
            // UTF-16LE strings
            if (encoding === 'utf16' || encoding === 'both') {
                let current = '';
                let startOffset = 0;
                for (let i = 0; i < buffer.length - 1 && strings.length < maxResults; i += 2) {
                    const ch = buffer.readUInt16LE(i);
                    if (ch >= 0x20 && ch <= 0x7e) {
                        if (current.length === 0)
                            startOffset = i;
                        current += String.fromCharCode(ch);
                    }
                    else {
                        if (current.length >= minLength) {
                            if (!filter || current.toLowerCase().includes(filter)) {
                                strings.push({ offset: `0x${startOffset.toString(16)}`, encoding: 'UTF-16LE', value: current });
                            }
                        }
                        current = '';
                    }
                }
            }
            return JSON.stringify({
                file: basename(filePath),
                totalFound: strings.length,
                filter: filter || 'none',
                strings: strings.slice(0, maxResults),
            }, null, 2);
        }),
        // === Smart Binary Analyzer ports ===
        nativeTool('extract_dll_classes', 'Extract class names from a .NET DLL using stream-based analysis. Works with very large files.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to DLL file' },
                search_terms: { type: 'array', items: { type: 'string' }, description: 'Filter by these terms (case-insensitive)' },
                max_classes: { type: 'number', description: 'Max classes to return (default 200)' },
            },
            required: ['file_path'],
        }, async (args) => {
            const filePath = args.file_path;
            const searchTerms = args.search_terms || [];
            const maxClasses = args.max_classes || 200;
            const buffer = readFileSync(filePath);
            // Extract strings that look like class names (PascalCase, contain namespace dots)
            const classPattern = /[A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)*/g;
            const content = buffer.toString('utf-8', 0, Math.min(buffer.length, 10_000_000));
            const matches = new Set();
            let match;
            while ((match = classPattern.exec(content)) !== null && matches.size < maxClasses * 5) {
                const name = match[0];
                if (name.length >= 3 && name.includes('.')) {
                    if (searchTerms.length === 0 || searchTerms.some(t => name.toLowerCase().includes(t.toLowerCase()))) {
                        matches.add(name);
                    }
                }
            }
            const sorted = Array.from(matches).sort().slice(0, maxClasses);
            return JSON.stringify({
                file: basename(filePath),
                classCount: sorted.length,
                classes: sorted,
                searchTerms: searchTerms.length > 0 ? searchTerms : 'none',
            }, null, 2);
        }),
        nativeTool('search_binary_pattern', 'Search for text patterns in a binary file using stream-based approach.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to binary file' },
                patterns: { type: 'array', items: { type: 'string' }, description: 'Text patterns to search for' },
                max_results: { type: 'number', description: 'Max results per pattern (default 50)' },
            },
            required: ['file_path', 'patterns'],
        }, async (args) => {
            const filePath = args.file_path;
            const patterns = args.patterns;
            const maxResults = args.max_results || 50;
            const buffer = readFileSync(filePath);
            const results = {};
            for (const pattern of patterns) {
                results[pattern] = [];
                const searchBuf = Buffer.from(pattern, 'utf-8');
                for (let i = 0; i <= buffer.length - searchBuf.length && results[pattern].length < maxResults; i++) {
                    if (buffer.subarray(i, i + searchBuf.length).equals(searchBuf)) {
                        const ctxStart = Math.max(0, i - 20);
                        const ctxEnd = Math.min(buffer.length, i + searchBuf.length + 20);
                        const ctx = buffer.subarray(ctxStart, ctxEnd).toString('utf-8').replace(/[^\x20-\x7e]/g, '.');
                        results[pattern].push({ offset: `0x${i.toString(16)}`, context: ctx });
                    }
                }
            }
            return JSON.stringify({ file: basename(filePath), results }, null, 2);
        }),
        nativeTool('extract_strings', 'Simple string extraction from a binary file.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to binary file' },
                filter: { type: 'string', description: 'Optional filter' },
                min_length: { type: 'number', description: 'Minimum string length (default 4)' },
            },
            required: ['file_path'],
        }, async (args) => {
            // Simplified version - delegates to extract_strings_advanced
            const filePath = args.file_path;
            const filter = args.filter;
            const minLength = args.min_length || 4;
            const buffer = readFileSync(filePath);
            const strings = [];
            let current = '';
            for (let i = 0; i < buffer.length && strings.length < 1000; i++) {
                const b = buffer[i];
                if (b >= 0x20 && b <= 0x7e) {
                    current += String.fromCharCode(b);
                }
                else {
                    if (current.length >= minLength) {
                        if (!filter || current.toLowerCase().includes(filter.toLowerCase())) {
                            strings.push(current);
                        }
                    }
                    current = '';
                }
            }
            return JSON.stringify({ file: basename(filePath), count: strings.length, strings }, null, 2);
        }),
        nativeTool('analyze_dll_structure', 'Analyze the overall structure of a DLL: sections, imports, exports summary.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to DLL file' },
            },
            required: ['file_path'],
        }, async (args) => {
            const filePath = args.file_path;
            const buffer = readFileSync(filePath);
            const pe = readPEHeaders(buffer);
            return JSON.stringify({ file: basename(filePath), size: buffer.length, ...pe }, null, 2);
        }),
        // === Checksum Tools ===
        nativeTool('calculate_checksums', 'Calculate MD5, SHA1, SHA256 checksums for a file.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
            },
            required: ['file_path'],
        }, async (args) => {
            const { createHash } = await import('crypto');
            const filePath = args.file_path;
            const buffer = readFileSync(filePath);
            return JSON.stringify({
                file: basename(filePath),
                size: buffer.length,
                md5: createHash('md5').update(buffer).digest('hex'),
                sha1: createHash('sha1').update(buffer).digest('hex'),
                sha256: createHash('sha256').update(buffer).digest('hex'),
            }, null, 2);
        }),
        nativeTool('compare_binaries_detailed', 'Compare two binary files and show differences.', {
            type: 'object',
            properties: {
                file_path_a: { type: 'string', description: 'Path to first file' },
                file_path_b: { type: 'string', description: 'Path to second file' },
                max_diffs: { type: 'number', description: 'Max differences to show (default 50)' },
            },
            required: ['file_path_a', 'file_path_b'],
        }, async (args) => {
            const a = readFileSync(args.file_path_a);
            const b = readFileSync(args.file_path_b);
            const maxDiffs = args.max_diffs || 50;
            const diffs = [];
            const minLen = Math.min(a.length, b.length);
            for (let i = 0; i < minLen && diffs.length < maxDiffs; i++) {
                if (a[i] !== b[i]) {
                    diffs.push({
                        offset: `0x${i.toString(16)}`,
                        fileA: a[i].toString(16).padStart(2, '0'),
                        fileB: b[i].toString(16).padStart(2, '0'),
                    });
                }
            }
            return JSON.stringify({
                fileA: { name: basename(args.file_path_a), size: a.length },
                fileB: { name: basename(args.file_path_b), size: b.length },
                identical: a.equals(b),
                sizeDifference: b.length - a.length,
                diffCount: diffs.length,
                diffs,
            }, null, 2);
        }),
        // === RVA/Offset conversion ===
        nativeTool('rva_to_offset', 'Convert a Relative Virtual Address (RVA) to a file offset in a PE file.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to PE file' },
                rva: { type: 'number', description: 'RVA to convert' },
            },
            required: ['file_path', 'rva'],
        }, async (args) => {
            const buffer = readFileSync(args.file_path);
            const rva = args.rva;
            const pe = readPEHeaders(buffer);
            const sections = pe.sections;
            for (const section of sections || []) {
                const va = section.virtualAddress;
                const vs = section.virtualSize;
                if (rva >= va && rva < va + vs) {
                    const offset = rva - va + section.rawDataPointer;
                    return JSON.stringify({ rva: `0x${rva.toString(16)}`, fileOffset: `0x${offset.toString(16)}`, section: section.name }, null, 2);
                }
            }
            return `Could not resolve RVA 0x${rva.toString(16)} to any section`;
        }),
        nativeTool('offset_to_rva', 'Convert a file offset to a Relative Virtual Address (RVA) in a PE file.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to PE file' },
                offset: { type: 'number', description: 'File offset to convert' },
            },
            required: ['file_path', 'offset'],
        }, async (args) => {
            const buffer = readFileSync(args.file_path);
            const offset = args.offset;
            const pe = readPEHeaders(buffer);
            const sections = pe.sections;
            for (const section of sections || []) {
                const rawStart = section.rawDataPointer;
                const rawEnd = rawStart + section.rawDataSize;
                if (offset >= rawStart && offset < rawEnd) {
                    const rva = offset - rawStart + section.virtualAddress;
                    return JSON.stringify({ fileOffset: `0x${offset.toString(16)}`, rva: `0x${rva.toString(16)}`, section: section.name }, null, 2);
                }
            }
            return `Could not resolve offset 0x${offset.toString(16)} to any section`;
        }),
        // === Godot PCK (basic) ===
        nativeTool('analyze_godot_pck', 'Analyze a Godot .pck archive and list its contents.', {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to .pck file' },
                filter: { type: 'string', description: 'Optional filename filter' },
            },
            required: ['file_path'],
        }, async (args) => {
            const filePath = args.file_path;
            const filter = args.filter;
            const buffer = readFileSync(filePath);
            // PCK magic: "GDPC" at offset 0
            const magic = buffer.toString('ascii', 0, 4);
            if (magic !== 'GDPC') {
                return JSON.stringify({ error: 'Not a valid Godot PCK file (missing GDPC magic)' }, null, 2);
            }
            const version = buffer.readUInt32LE(4);
            const verMajor = buffer.readUInt32LE(8);
            const verMinor = buffer.readUInt32LE(12);
            const verPatch = buffer.readUInt32LE(16);
            // Skip flags (4 bytes at offset 20) + reserved (64 bytes)
            const fileCount = buffer.readUInt32LE(88);
            const files = [];
            let offset = 92;
            for (let i = 0; i < fileCount && offset < buffer.length; i++) {
                const pathLen = buffer.readUInt32LE(offset);
                offset += 4;
                const path = buffer.toString('utf-8', offset, offset + pathLen).replace(/\0+$/, '');
                offset += pathLen;
                const fileOffset = Number(buffer.readBigUInt64LE(offset));
                offset += 8;
                const fileSize = Number(buffer.readBigUInt64LE(offset));
                offset += 8;
                const md5 = buffer.subarray(offset, offset + 16).toString('hex');
                offset += 16;
                // Skip flags (4 bytes) if version >= 2
                if (version >= 2)
                    offset += 4;
                if (!filter || path.toLowerCase().includes(filter.toLowerCase())) {
                    files.push({ path, offset: fileOffset, size: fileSize });
                }
            }
            return JSON.stringify({
                file: basename(filePath),
                godotVersion: `${verMajor}.${verMinor}.${verPatch}`,
                pckVersion: version,
                totalFiles: fileCount,
                matchedFiles: files.length,
                files: files.slice(0, 200),
            }, null, 2);
        }),
        // ============================================================
        // GoreBox / Lua Mod Tools
        // ============================================================
        nativeTool('gorebox_generate_discovery_mod', 'Generate a GoreBox Lua mod that discovers all available API functions, globals, tables, and callbacks. Writes results to a dump file in the mod folder. Use this when you need to learn what Lua API is available in a game that uses Lua scripting.', {
            type: 'object',
            properties: {
                mods_dir: { type: 'string', description: 'Path to the game Mods directory (e.g. C:/Users/.../GoreBox/Mods)' },
                mod_name: { type: 'string', description: 'Name for the discovery mod (default: APIDisco)' },
            },
            required: ['mods_dir'],
        }, async (args) => {
            const modsDir = args.mods_dir;
            const modName = args.mod_name || 'APIDisco';
            const { mkdirSync } = await import('fs');
            const { join } = await import('path');
            const modDir = join(modsDir, modName);
            if (!existsSync(modDir))
                mkdirSync(modDir, { recursive: true });
            // Write info.json
            const infoJson = {
                name: modName,
                description: 'API Discovery - dumps all globals, functions, tables to file',
                mainScript: 'main.lua',
                version: '1.0.0',
                active: true,
                unloadOnError: false,
                safeMode: false,
                isPlugin: true,
            };
            writeFileSync(join(modDir, 'info.json'), JSON.stringify(infoJson, null, 2));
            // The discovery Lua script - designed to be maximally resilient
            // It tries multiple output methods and probes everything
            const luaScript = `-- API Discovery Mod - Auto-generated
-- Probes the entire Lua environment and writes results to dump.txt

local _results = {}
local _errors = {}

local function safeStr(v)
  local ok, s = pcall(tostring, v)
  return ok and s or "<?>"
end

local function log(msg)
  _results[#_results + 1] = msg
end

local function logError(msg)
  _errors[#_errors + 1] = msg
end

-- Probe a table recursively (max depth 3)
local _seen = {}
local function probeTable(tbl, prefix, depth)
  if depth > 3 then return end
  if _seen[tbl] then return end
  _seen[tbl] = true

  local keys = {}
  local ok, err = pcall(function()
    for k, _ in pairs(tbl) do
      keys[#keys + 1] = k
    end
  end)
  if not ok then
    logError("Cannot iterate: " .. prefix .. " (" .. safeStr(err) .. ")")
    return
  end

  -- Sort keys
  pcall(function()
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  end)

  for _, k in ipairs(keys) do
    local fullKey = prefix .. "." .. tostring(k)
    local vOk, v = pcall(function() return tbl[k] end)
    if not vOk then
      logError("Cannot read: " .. fullKey)
    else
      local t = type(v)
      if t == "function" then
        log("FUNC|" .. fullKey)
      elseif t == "table" then
        log("TABLE|" .. fullKey)
        probeTable(v, fullKey, depth + 1)
      elseif t == "userdata" then
        log("USERDATA|" .. fullKey .. "|" .. safeStr(v))
        -- Probe metatable
        local mt = getmetatable(v)
        if mt and type(mt) == "table" then
          log("  METATABLE|" .. fullKey)
          probeTable(mt, fullKey .. ".__mt", depth + 1)
        end
      elseif t == "string" then
        local short = #v > 100 and v:sub(1, 100) .. "..." or v
        log("STRING|" .. fullKey .. "|" .. short)
      elseif t == "number" or t == "boolean" then
        log(t:upper() .. "|" .. fullKey .. "|" .. tostring(v))
      else
        log(t:upper() .. "|" .. fullKey)
      end
    end
  end
end

-- Standard Lua libs to skip (we know what these are)
local skipSet = {}
for _, name in ipairs({"_G", "_VERSION", "arg", "coroutine", "debug", "io", "math", "os", "package", "string", "table", "utf8", "bit", "bit32", "jit"}) do
  skipSet[name] = true
end

log("=== API DISCOVERY START ===")
log("TIME|" .. (os.date and os.date() or "unknown"))

-- Enumerate all globals
local globalKeys = {}
pcall(function()
  for k, _ in pairs(_G) do
    globalKeys[#globalKeys + 1] = k
  end
end)
pcall(function() table.sort(globalKeys) end)

log("GLOBAL_COUNT|" .. #globalKeys)

for _, k in ipairs(globalKeys) do
  if not skipSet[k] then
    local ok2, v = pcall(function() return _G[k] end)
    if ok2 and v ~= nil then
      local t = type(v)
      if t == "function" then
        log("GFUNC|" .. k)
      elseif t == "table" then
        log("GTABLE|" .. k)
        probeTable(v, k, 0)
      elseif t == "userdata" then
        log("GUSERDATA|" .. k .. "|" .. safeStr(v))
        local mt = getmetatable(v)
        if mt and type(mt) == "table" then
          probeTable(mt, k .. ".__mt", 0)
        end
      elseif t == "string" then
        log("GSTRING|" .. k .. "|" .. (v:sub(1, 200)))
      else
        log("GVALUE|" .. k .. "|" .. t .. "|" .. safeStr(v))
      end
    end
  end
end

-- Probe specific names that game engines commonly expose
local probeNames = {
  "Debug", "GB", "GoreBox", "Game", "API", "ModAPI", "Mod", "Entity", "Entities",
  "NPC", "Player", "World", "Spawn", "SpawnEntity", "Health", "Damage",
  "Dismember", "Decapitate", "Immortal", "Invincible", "Gore", "Blood", "Bleed",
  "Physics", "Chat", "Console", "Event", "Events", "Hook", "Hooks", "Callback",
  "Register", "UI", "GUI", "Input", "Time", "Camera", "Sound", "Audio",
  "Net", "Network", "Map", "Inventory", "CS", "UnityEngine", "Unity",
  "GameObject", "Component", "Transform", "Application", "System",
  "require", "import", "dofile", "loadfile", "json", "JSON",
  "File", "Path", "Directory",
  "OnSpawn", "OnDamage", "OnDeath", "OnHit", "OnUpdate", "OnStart",
  "AddForce", "SetPosition", "GetPosition", "SetRotation", "FindObject",
  "Instantiate", "Destroy", "GetComponent", "AddComponent",
  "SendMessage", "BroadcastMessage", "Invoke", "InvokeRepeating",
  "Raycast", "OverlapSphere", "SphereCast",
  "Color", "Vector3", "Vector2", "Quaternion", "Mathf",
  "PlayerPrefs", "Resources", "AssetBundle", "SceneManager",
  "RPC", "Photon", "PhotonNetwork",
}

log("")
log("=== PROBE SPECIFIC NAMES ===")
for _, name in ipairs(probeNames) do
  local ok3, val = pcall(function() return _G[name] end)
  if ok3 and val ~= nil then
    log("PROBE_HIT|" .. name .. "|" .. type(val))
  end
end

-- Try to discover metatables on common globals
log("")
log("=== METATABLE PROBES ===")
for _, name in ipairs({"Debug", "GB", "Game", "Player", "Entity", "World", "API", "ModAPI", "Mod"}) do
  local ok4, val = pcall(function() return _G[name] end)
  if ok4 and val ~= nil then
    local mt = getmetatable(val)
    if mt then
      log("MT_FOUND|" .. name)
      probeTable(mt, name .. ".__mt", 0)
    end
  end
end

-- Record errors
if #_errors > 0 then
  log("")
  log("=== ERRORS ===")
  for _, e in ipairs(_errors) do
    log("ERR|" .. e)
  end
end

log("")
log("=== API DISCOVERY COMPLETE ===")
log("TOTAL_ENTRIES|" .. #_results)

-- Build output string
local output = table.concat(_results, "\\n")

-- Try EVERY possible way to write the output
local written = false

-- Method 1: io.open (standard Lua)
pcall(function()
  local f = io.open("${modDir.replace(/\\/g, '/')}/dump.txt", "w")
  if f then f:write(output) f:close() written = true end
end)

-- Method 2: Relative path
if not written then
  pcall(function()
    local f = io.open("dump.txt", "w")
    if f then f:write(output) f:close() written = true end
  end)
end

-- Method 3: os.execute
if not written then
  pcall(function()
    local f = io.open("${modsDir.replace(/\\/g, '/')}/api_dump.txt", "w")
    if f then f:write(output) f:close() written = true end
  end)
end

-- Method 4: If there's a File API
if not written then
  pcall(function()
    if File and File.WriteAllText then
      File.WriteAllText("${modDir.replace(/\\/g, '/')}/dump.txt", output)
      written = true
    end
  end)
end

-- Method 5: If there's a WriteFile function
if not written then
  pcall(function()
    if WriteFile then WriteFile("dump.txt", output) written = true end
  end)
end

-- Always try Debug.Log as fallback - output in chunks
pcall(function()
  Debug.Log("[APIDisco] Discovery complete: " .. #_results .. " entries, written=" .. tostring(written))
  -- Log first 50 entries to console
  for i = 1, math.min(50, #_results) do
    Debug.Log("[APIDisco] " .. _results[i])
  end
  if #_results > 50 then
    Debug.Log("[APIDisco] ... and " .. (#_results - 50) .. " more entries in dump.txt")
  end
end)

-- Also try print
pcall(function()
  print("[APIDisco] Discovery complete: " .. #_results .. " entries")
end)
`;
            writeFileSync(join(modDir, 'main.lua'), luaScript);
            return JSON.stringify({
                success: true,
                modDir,
                files: ['info.json', 'main.lua'],
                instructions: [
                    'Mod created at: ' + modDir,
                    'Enable it in game: Addons → Mods → ' + modName,
                    'Load into a map/sandbox',
                    'Check for dump.txt in: ' + modDir,
                    'Also check the game console for [APIDisco] messages',
                    'Use gorebox_read_api_dump to parse the results',
                ],
            }, null, 2);
        }),
        nativeTool('gorebox_read_api_dump', 'Read and parse an API discovery dump file generated by gorebox_generate_discovery_mod. Returns structured information about all discovered globals, functions, tables, and callbacks.', {
            type: 'object',
            properties: {
                dump_path: { type: 'string', description: 'Path to the dump.txt file' },
                filter: { type: 'string', description: 'Optional filter string to match entries (case-insensitive)' },
            },
            required: ['dump_path'],
        }, async (args) => {
            const dumpPath = args.dump_path;
            const filter = (args.filter || '').toLowerCase();
            if (!existsSync(dumpPath)) {
                // Search common locations
                const { readdirSync } = await import('fs');
                const { dirname, join } = await import('path');
                const searchDirs = [
                    dirname(dumpPath),
                    join(dirname(dumpPath), '..'),
                ];
                const found = [];
                for (const dir of searchDirs) {
                    try {
                        for (const f of readdirSync(dir, { recursive: true })) {
                            const fname = String(f);
                            if (fname.endsWith('dump.txt') || fname.endsWith('api_dump.txt')) {
                                found.push(join(dir, fname));
                            }
                        }
                    }
                    catch { /* ignore */ }
                }
                return JSON.stringify({
                    error: 'dump.txt not found at: ' + dumpPath,
                    searchedAlso: searchDirs,
                    possibleFiles: found,
                    hint: 'The mod may not have run yet, or file I/O is sandboxed. Check game console for [APIDisco] Debug.Log output instead.',
                }, null, 2);
            }
            const content = readFileSync(dumpPath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            const globalFunctions = [];
            const globalTables = [];
            const tableMethods = {};
            const globalValues = {};
            const userdataObjects = [];
            const metatables = {};
            const probeHits = {};
            const errors = [];
            for (const line of lines) {
                if (filter && !line.toLowerCase().includes(filter))
                    continue;
                const parts = line.split('|');
                const tag = parts[0];
                const name = parts[1] || '';
                switch (tag) {
                    case 'GFUNC':
                        globalFunctions.push(name);
                        break;
                    case 'GTABLE':
                        globalTables.push(name);
                        break;
                    case 'FUNC': {
                        const dotIdx = name.indexOf('.');
                        if (dotIdx > 0) {
                            const tbl = name.substring(0, dotIdx);
                            if (!tableMethods[tbl])
                                tableMethods[tbl] = [];
                            tableMethods[tbl].push(name.substring(dotIdx + 1));
                        }
                        else {
                            globalFunctions.push(name);
                        }
                        break;
                    }
                    case 'TABLE': break; // already captured by GTABLE
                    case 'STRING':
                    case 'NUMBER':
                    case 'BOOLEAN':
                    case 'GSTRING':
                    case 'GVALUE':
                        globalValues[name] = parts.slice(2).join('|');
                        break;
                    case 'GUSERDATA':
                    case 'USERDATA':
                        userdataObjects.push(name + (parts[2] ? ' = ' + parts[2] : ''));
                        break;
                    case 'MT_FOUND':
                    case '  METATABLE':
                        if (!metatables[name])
                            metatables[name] = [];
                        break;
                    case 'PROBE_HIT':
                        probeHits[name] = parts[2] || 'unknown';
                        break;
                    case 'ERR':
                        errors.push(name);
                        break;
                }
            }
            return JSON.stringify({
                totalLines: lines.length,
                filter: filter || '(none)',
                globalFunctions,
                globalTables,
                tableMethods,
                globalValues,
                userdataObjects,
                metatables,
                probeHits,
                errors,
                summary: {
                    functions: globalFunctions.length,
                    tables: globalTables.length,
                    tableMethodGroups: Object.keys(tableMethods).length,
                    values: Object.keys(globalValues).length,
                    userdata: userdataObjects.length,
                    probeHits: Object.keys(probeHits).length,
                    errors: errors.length,
                },
            }, null, 2);
        }),
        nativeTool('gorebox_generate_mod', 'Generate a GoreBox-compatible Lua mod with proper info.json and main.lua. Creates a ready-to-use mod in the Mods directory.', {
            type: 'object',
            properties: {
                mods_dir: { type: 'string', description: 'Path to the game Mods directory' },
                mod_name: { type: 'string', description: 'Name for the mod folder' },
                display_name: { type: 'string', description: 'Display name in the mod browser' },
                description: { type: 'string', description: 'Mod description' },
                lua_code: { type: 'string', description: 'The Lua script code for main.lua' },
                is_plugin: { type: 'boolean', description: 'Whether this is a plugin mod (default true)' },
                safe_mode: { type: 'boolean', description: 'Whether to run in safe mode (default false)' },
                version: { type: 'string', description: 'Version string (default 1.0.0)' },
            },
            required: ['mods_dir', 'mod_name', 'lua_code'],
        }, async (args) => {
            const modsDir = args.mods_dir;
            const modName = args.mod_name;
            const displayName = args.display_name || modName;
            const description = args.description || 'Generated by Universal Game Modder';
            const luaCode = args.lua_code;
            const isPlugin = args.is_plugin !== false;
            const safeMode = args.safe_mode === true;
            const version = args.version || '1.0.0';
            const { mkdirSync } = await import('fs');
            const { join } = await import('path');
            const modDir = join(modsDir, modName);
            if (!existsSync(modDir))
                mkdirSync(modDir, { recursive: true });
            const infoJson = {
                name: displayName,
                description,
                mainScript: 'main.lua',
                version,
                active: true,
                unloadOnError: true,
                safeMode,
                isPlugin,
            };
            writeFileSync(join(modDir, 'info.json'), JSON.stringify(infoJson, null, 2));
            writeFileSync(join(modDir, 'main.lua'), luaCode);
            return JSON.stringify({
                success: true,
                modDir,
                modName: displayName,
                files: {
                    'info.json': JSON.stringify(infoJson, null, 2),
                    'main.lua': luaCode.length + ' bytes',
                },
                instructions: [
                    'Mod deployed to: ' + modDir,
                    'Enable in game: Addons → Mods → ' + displayName,
                    'Refresh mods with the cycle button or restart the map',
                ],
            }, null, 2);
        }),
        nativeTool('gorebox_list_mods', 'List all installed GoreBox mods with their info.json contents and file structure.', {
            type: 'object',
            properties: {
                mods_dir: { type: 'string', description: 'Path to the game Mods directory' },
            },
            required: ['mods_dir'],
        }, async (args) => {
            const modsDir = args.mods_dir;
            const { readdirSync } = await import('fs');
            const { join } = await import('path');
            if (!existsSync(modsDir)) {
                return JSON.stringify({ error: 'Mods directory not found: ' + modsDir });
            }
            const mods = [];
            const entries = readdirSync(modsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const modDir = join(modsDir, entry.name);
                const infoPath = join(modDir, 'info.json');
                const mainPath = join(modDir, 'main.lua');
                const mod = {
                    folder: entry.name,
                    hasInfoJson: existsSync(infoPath),
                    hasMainLua: existsSync(mainPath),
                };
                if (mod.hasInfoJson) {
                    try {
                        mod.info = JSON.parse(readFileSync(infoPath, 'utf-8'));
                    }
                    catch (e) {
                        mod.infoError = 'Failed to parse info.json';
                    }
                }
                // List all files in mod folder
                try {
                    const files = readdirSync(modDir);
                    mod.files = files;
                }
                catch { /* ignore */ }
                // Check for dump files (discovery output)
                const dumpPath = join(modDir, 'dump.txt');
                if (existsSync(dumpPath)) {
                    const stat = statSync(dumpPath);
                    mod.hasDump = true;
                    mod.dumpSize = stat.size;
                }
                mods.push(mod);
            }
            return JSON.stringify({ modsDir, totalMods: mods.length, mods }, null, 2);
        }),
    ];
}
//# sourceMappingURL=index.js.map