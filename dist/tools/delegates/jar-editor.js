import { childPool } from '../../backends/child-pool.js';
import { logger } from '../../utils/logger.js';
import { session } from '../../core/session.js';
function delegateTool(name, description, inputSchema) {
    return {
        name,
        description,
        inputSchema,
        handler: async (args) => {
            const start = Date.now();
            logger.toolStart(name, 'jar-editor');
            try {
                const result = await childPool.call('jar-editor', name, args);
                const text = result.content.map(c => c.text).join('\n');
                const duration = Date.now() - start;
                logger.toolComplete(name, 'jar-editor', duration, !result.isError);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: !result.isError, backend: 'jar-editor' });
                return text;
            }
            catch (err) {
                const duration = Date.now() - start;
                const msg = err instanceof Error ? err.message : String(err);
                logger.toolComplete(name, 'jar-editor', duration, false);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: false, backend: 'jar-editor' });
                return `ERROR: ${msg}`;
            }
        },
    };
}
export function getJarDelegateTools() {
    return [
        // Session Management
        delegateTool('jar_open', 'Open and extract a JAR file for exploration and editing.', {
            type: 'object',
            properties: {
                jar_path: { type: 'string', description: 'Path to the JAR file' },
                session_id: { type: 'string', description: 'Optional custom session ID' },
            },
            required: ['jar_path'],
        }),
        delegateTool('jar_close', 'Close a JAR session and clean up temp files.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                cleanup: { type: 'boolean', description: 'Delete temp files (default: true)' },
            },
            required: ['session_id'],
        }),
        delegateTool('jar_list_sessions', 'List all active JAR sessions.', {
            type: 'object',
            properties: {},
        }),
        // Browse/Search
        delegateTool('jar_list', 'List contents of an opened JAR file.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                filter_pattern: { type: 'string', description: 'Optional filename filter' },
                max_results: { type: 'number', description: 'Max results (default 100)' },
            },
            required: ['session_id'],
        }),
        delegateTool('jar_search', 'Search within JAR for classes, methods, or strings.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                search_term: { type: 'string', description: 'Search term' },
                search_type: { type: 'string', description: 'Type: filename, content, classname (default: filename)' },
            },
            required: ['session_id', 'search_term'],
        }),
        delegateTool('jar_search_bytecode', 'Search for numeric values or strings in bytecode.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                search_value: { type: 'string', description: 'Value to search for' },
                file_filter: { type: 'string', description: 'Optional file filter pattern' },
            },
            required: ['session_id', 'search_value'],
        }),
        delegateTool('jar_search_opcodes', 'Search for bytecode opcode patterns in .class files.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                pattern: { type: 'string', description: 'Opcode pattern to search for' },
                file_filter: { type: 'string', description: 'Optional file filter' },
            },
            required: ['session_id', 'pattern'],
        }),
        // Read/Inspect
        delegateTool('jar_read_class', 'Read and decompile a Java .class file.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'Path to .class file within JAR' },
                decompile: { type: 'boolean', description: 'Decompile to Java source (default: true)' },
                extra_classpath: { type: 'array', items: { type: 'string' }, description: 'Additional classpath entries' },
            },
            required: ['session_id', 'class_path'],
        }),
        delegateTool('jar_read_file', 'Read a text file from the JAR.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                file_path: { type: 'string', description: 'File path within JAR' },
            },
            required: ['session_id', 'file_path'],
        }),
        delegateTool('jar_inspect_constant_pool', 'Dump the constant pool of a .class file.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'Path to .class file' },
                filter_type: { type: 'string', description: 'Filter by constant type' },
                filter_value: { type: 'string', description: 'Filter by value' },
            },
            required: ['session_id', 'class_path'],
        }),
        delegateTool('jar_hex_view', 'Read raw bytes from a .class file as hex dump.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'Path to file' },
                offset: { type: 'number', description: 'Start offset (default 0)' },
                length: { type: 'number', description: 'Bytes to read (default 256)' },
            },
            required: ['session_id', 'class_path'],
        }),
        delegateTool('jar_detect_mod_info', 'Auto-detect mod loader, version, and structure from JAR contents.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
            },
            required: ['session_id'],
        }),
        // Edit
        delegateTool('jar_edit_file', 'Edit a text file within the JAR.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                file_path: { type: 'string', description: 'File path within JAR' },
                new_content: { type: 'string', description: 'New file content' },
            },
            required: ['session_id', 'file_path', 'new_content'],
        }),
        delegateTool('jar_edit_class_constants', 'Edit numeric constants in .class file bytecode.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'Path to .class file' },
                replacements: { type: 'object', description: 'Map of old_value -> new_value' },
                occurrence: { type: 'number', description: 'Which occurrence to replace (0-indexed)' },
                value_type: { type: 'string', description: 'Value type hint' },
            },
            required: ['session_id', 'class_path', 'replacements'],
        }),
        delegateTool('jar_edit_constant_pool', 'Edit constants by their exact constant pool index.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'Path to .class file' },
                edits: { type: 'object', description: 'Map of pool_index -> new_value' },
            },
            required: ['session_id', 'class_path', 'edits'],
        }),
        delegateTool('jar_hex_edit', 'Write raw bytes at a specific offset in a file.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'Path to file' },
                offset: { type: 'number', description: 'Byte offset' },
                hex_data: { type: 'string', description: 'Hex string to write' },
            },
            required: ['session_id', 'class_path', 'offset', 'hex_data'],
        }),
        // File Operations
        delegateTool('jar_add_file', 'Add a file from disk into the JAR.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                jar_path: { type: 'string', description: 'Destination path within JAR' },
                source_path: { type: 'string', description: 'Source file on disk' },
                overwrite: { type: 'boolean', description: 'Overwrite if exists (default: true)' },
            },
            required: ['session_id', 'jar_path', 'source_path'],
        }),
        delegateTool('jar_add_file_content', 'Write text content as a new file in the JAR.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                jar_path: { type: 'string', description: 'Destination path within JAR' },
                content: { type: 'string', description: 'File content' },
                encoding: { type: 'string', description: 'Encoding (default: utf-8)' },
            },
            required: ['session_id', 'jar_path', 'content'],
        }),
        delegateTool('jar_compile_java', 'Compile Java source code and optionally inject into JAR.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                source_code: { type: 'string', description: 'Java source code' },
                class_name: { type: 'string', description: 'Fully-qualified class name' },
                classpath: { type: 'array', items: { type: 'string' }, description: 'Additional classpath entries' },
                auto_classpath: { type: 'boolean', description: 'Auto-add JAR to classpath (default: true)' },
                java_release: { type: 'number', description: 'Java release target (default: 21)' },
                inject_into_jar: { type: 'boolean', description: 'Inject compiled class into JAR (default: true)' },
            },
            required: ['session_id', 'source_code', 'class_name'],
        }),
        // Diff/Restore
        delegateTool('jar_diff', 'Show differences between original and modified file.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'File path within JAR' },
            },
            required: ['session_id', 'class_path'],
        }),
        delegateTool('jar_restore_file', 'Restore a file from backup to undo modifications.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                class_path: { type: 'string', description: 'File path within JAR' },
            },
            required: ['session_id', 'class_path'],
        }),
        // Presets
        delegateTool('jar_preset_save', 'Save a named preset of constant edits for reuse.', {
            type: 'object',
            properties: {
                preset_name: { type: 'string', description: 'Preset name' },
                description: { type: 'string', description: 'Preset description' },
                class_path: { type: 'string', description: 'Target class path' },
                edits: { type: 'object', description: 'Edit map' },
                edit_mode: { type: 'string', description: 'Edit mode: constants or pool (default: constants)' },
            },
            required: ['preset_name', 'description', 'class_path', 'edits'],
        }),
        delegateTool('jar_preset_apply', 'Apply a saved preset of constant edits.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                preset_name: { type: 'string', description: 'Preset name to apply' },
                reverse: { type: 'boolean', description: 'Reverse the edits (default: false)' },
            },
            required: ['session_id', 'preset_name'],
        }),
        delegateTool('jar_preset_list', 'List all saved edit presets.', {
            type: 'object',
            properties: {},
        }),
        // Repack/Scaffold
        delegateTool('jar_repack', 'Repack the modified JAR file with all changes.', {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session ID' },
                output_path: { type: 'string', description: 'Optional output path (defaults to original)' },
            },
            required: ['session_id'],
        }),
        delegateTool('jar_scaffold_mod', 'Generate a minimal Minecraft mod JAR structure.', {
            type: 'object',
            properties: {
                mod_name: { type: 'string', description: 'Mod display name' },
                mod_id: { type: 'string', description: 'Mod ID (lowercase, no spaces)' },
                loader: { type: 'string', description: 'Mod loader: fabric, forge, neoforge (default: fabric)' },
                mc_version: { type: 'string', description: 'Minecraft version (default: 1.21.5)' },
                author: { type: 'string', description: 'Author name' },
                description: { type: 'string', description: 'Mod description' },
                output_dir: { type: 'string', description: 'Output directory' },
            },
            required: ['mod_name', 'mod_id', 'output_dir'],
        }),
    ];
}
//# sourceMappingURL=jar-editor.js.map