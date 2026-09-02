import { childPool } from '../../backends/child-pool.js';
import { logger } from '../../utils/logger.js';
import { session } from '../../core/session.js';
function delegateTool(name, description, inputSchema, postProcess) {
    return {
        name,
        description,
        inputSchema,
        handler: async (args) => {
            const start = Date.now();
            logger.toolStart(name, 'unity-decompiler');
            try {
                const result = await childPool.call('unity-decompiler', name, args);
                const text = result.content.map(c => c.text).join('\n');
                const duration = Date.now() - start;
                logger.toolComplete(name, 'unity-decompiler', duration, !result.isError);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: !result.isError, backend: 'unity-decompiler' });
                if (postProcess && !result.isError)
                    postProcess(text, args);
                return text;
            }
            catch (err) {
                const duration = Date.now() - start;
                const msg = err instanceof Error ? err.message : String(err);
                logger.toolComplete(name, 'unity-decompiler', duration, false);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: false, backend: 'unity-decompiler' });
                return `ERROR: ${msg}`;
            }
        },
    };
}
export function getUnityDelegateTools() {
    return [
        // Phase 1: Understanding
        delegateTool('load_assembly', 'Load a .NET assembly (DLL) for analysis. Must be called before other Unity tools.', {
            type: 'object',
            properties: {
                assembly_path: { type: 'string', description: 'Full path to the .NET DLL file' },
                managed_directory: { type: 'string', description: 'Optional: path to the Managed directory for dependency resolution' },
            },
            required: ['assembly_path'],
        }),
        delegateTool('list_types', 'List all types (classes, structs, enums, interfaces) in a loaded assembly.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key (from load_assembly)' },
                filter: { type: 'string', description: 'Filter by name (substring match)' },
                kind: { type: 'string', description: 'Filter by kind: class, struct, enum, interface' },
                base_type: { type: 'string', description: 'Filter by base type name' },
                limit: { type: 'number', description: 'Max results (default 200)' },
            },
            required: ['assembly'],
        }),
        delegateTool('decompile_type', 'Decompile a type to full C# source code.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Full type name (Namespace.ClassName)' },
            },
            required: ['assembly', 'type_name'],
        }, (result, args) => {
            session.cacheDecompilation(args.type_name, result);
        }),
        delegateTool('decompile_method', 'Decompile a single method to C# source code.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Full type name' },
                method_name: { type: 'string', description: 'Method name' },
                parameter_count: { type: 'number', description: 'Parameter count to disambiguate overloads' },
            },
            required: ['assembly', 'type_name', 'method_name'],
        }),
        delegateTool('inspect_type', 'Inspect type structure (fields, properties, methods) without decompiling method bodies.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Full type name' },
            },
            required: ['assembly', 'type_name'],
        }),
        delegateTool('search_code', 'Search across assembly for types, methods, fields, or string literals.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                pattern: { type: 'string', description: 'Search pattern' },
                scope: { type: 'string', description: 'Search scope: all, types, methods, fields, strings (default: all)' },
                limit: { type: 'number', description: 'Max results (default 100)' },
            },
            required: ['assembly', 'pattern'],
        }),
        delegateTool('find_references', 'Find all references to a method or field.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Type containing the member' },
                member_name: { type: 'string', description: 'Member name to find references to' },
                limit: { type: 'number', description: 'Max results (default 100)' },
            },
            required: ['assembly', 'type_name', 'member_name'],
        }),
        delegateTool('get_inheritance_tree', 'Get full inheritance tree for a type (ancestors and descendants).', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Full type name' },
            },
            required: ['assembly', 'type_name'],
        }),
        delegateTool('list_monobehaviours', 'List all MonoBehaviour components in assembly.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                filter: { type: 'string', description: 'Optional name filter' },
                limit: { type: 'number', description: 'Max results (default 200)' },
            },
            required: ['assembly'],
        }),
        delegateTool('list_scriptableobjects', 'List all ScriptableObject types in assembly.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                filter: { type: 'string', description: 'Optional name filter' },
            },
            required: ['assembly'],
        }),
        delegateTool('get_serialized_fields', 'Get all serialized fields for a MonoBehaviour or ScriptableObject.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Full type name' },
            },
            required: ['assembly', 'type_name'],
        }),
        delegateTool('get_method_il', 'Get raw IL bytecode for a method.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Full type name' },
                method_name: { type: 'string', description: 'Method name' },
            },
            required: ['assembly', 'type_name', 'method_name'],
        }),
        // Phase 2: Mod Building
        delegateTool('generate_plugin', 'Generate complete BepInEx 5 plugin template with Harmony patching.', {
            type: 'object',
            properties: {
                plugin_name: { type: 'string', description: 'Plugin class name' },
                plugin_guid: { type: 'string', description: 'Plugin GUID (e.g. com.author.pluginname)' },
                version: { type: 'string', description: 'Version string (default 1.0.0)' },
                description: { type: 'string', description: 'Plugin description' },
                author: { type: 'string', description: 'Author name' },
                include_harmony: { type: 'boolean', description: 'Include Harmony setup' },
                include_config: { type: 'boolean', description: 'Include config system' },
                managed_directory: { type: 'string', description: 'Path to game Managed directory' },
            },
            required: ['plugin_name', 'plugin_guid'],
        }),
        delegateTool('generate_harmony_patch', 'Generate correct Harmony patch class for a specific method.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Target type name' },
                method_name: { type: 'string', description: 'Target method name' },
                patch_type: { type: 'string', description: 'Patch type: prefix, postfix, both (default: both)' },
                parameter_count: { type: 'number', description: 'Parameter count for overload disambiguation' },
                patch_class_name: { type: 'string', description: 'Custom name for the patch class' },
            },
            required: ['assembly', 'type_name', 'method_name'],
        }),
        delegateTool('validate_patch_target', 'Validate that a Harmony patch target method exists with expected signature.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Target type name' },
                method_name: { type: 'string', description: 'Target method name' },
                expected_params: { type: 'string', description: 'Expected parameter types (comma-separated)' },
                expected_return: { type: 'string', description: 'Expected return type' },
            },
            required: ['assembly', 'type_name', 'method_name'],
        }),
        delegateTool('list_patchable_methods', 'List all methods in a type that can be Harmony patched.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
                type_name: { type: 'string', description: 'Full type name' },
                filter: { type: 'string', description: 'Optional method name filter' },
                include_inherited: { type: 'boolean', description: 'Include inherited methods (default: false)' },
            },
            required: ['assembly', 'type_name'],
        }),
        delegateTool('compile_plugin', 'Compile a BepInEx plugin C# source file using Roslyn.', {
            type: 'object',
            properties: {
                source_files: { type: 'string', description: 'C# source file path(s), semicolon-separated' },
                managed_directory: { type: 'string', description: 'Path to game Managed directory' },
                bepinex_core_directory: { type: 'string', description: 'Path to BepInEx/core directory' },
                output_path: { type: 'string', description: 'Output DLL path' },
                assembly_name: { type: 'string', description: 'Assembly name (optional)' },
            },
            required: ['source_files', 'managed_directory', 'bepinex_core_directory', 'output_path'],
        }),
        // Phase 3: Debugging
        delegateTool('analyze_bepinex_log', 'Analyze BepInEx log for errors, warnings, and patch issues.', {
            type: 'object',
            properties: {
                log_path: { type: 'string', description: 'Path to BepInEx LogOutput.log' },
            },
            required: ['log_path'],
        }),
        delegateTool('validate_assembly', 'Validate compiled plugin DLL for missing references and conflicts.', {
            type: 'object',
            properties: {
                plugin_path: { type: 'string', description: 'Path to compiled plugin DLL' },
                managed_directory: { type: 'string', description: 'Path to game Managed directory' },
            },
            required: ['plugin_path', 'managed_directory'],
        }),
        delegateTool('compare_signatures', 'Compare expected Harmony patch signature with actual target method.', {
            type: 'object',
            properties: {
                game_assembly: { type: 'string', description: 'Assembly key' },
                target_type: { type: 'string', description: 'Target type name' },
                target_method: { type: 'string', description: 'Target method name' },
                patch_params: { type: 'string', description: 'Patch parameter types (comma-separated)' },
                patch_kind: { type: 'string', description: 'Patch kind: prefix or postfix (default: prefix)' },
            },
            required: ['game_assembly', 'target_type', 'target_method', 'patch_params'],
        }),
        // Phase 4: Advanced
        delegateTool('read_unity_assets_info', 'List Unity asset files in game data directory.', {
            type: 'object',
            properties: {
                data_directory: { type: 'string', description: 'Path to game _Data directory' },
            },
            required: ['data_directory'],
        }),
        delegateTool('read_playerprefs', 'Read Unity PlayerPrefs from Windows registry.', {
            type: 'object',
            properties: {
                company_name: { type: 'string', description: 'Company name from PlayerSettings' },
                product_name: { type: 'string', description: 'Product name from PlayerSettings' },
                filter: { type: 'string', description: 'Optional key filter' },
            },
            required: ['company_name', 'product_name'],
        }),
        delegateTool('analyze_save_format', 'Analyze game save system by examining SaveManager classes.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
            },
            required: ['assembly'],
        }),
        delegateTool('detect_networking', 'Detect networking frameworks and flag unsafe-to-patch methods.', {
            type: 'object',
            properties: {
                assembly: { type: 'string', description: 'Assembly key' },
            },
            required: ['assembly'],
        }),
        // Phase 5: Maintenance
        delegateTool('diff_assemblies', 'Compare two assembly versions to show changes.', {
            type: 'object',
            properties: {
                old_assembly_path: { type: 'string', description: 'Path to old version DLL' },
                new_assembly_path: { type: 'string', description: 'Path to new version DLL' },
                show_methods: { type: 'boolean', description: 'Show method-level changes (default: true)' },
                limit: { type: 'number', description: 'Max results (default 200)' },
            },
            required: ['old_assembly_path', 'new_assembly_path'],
        }),
        delegateTool('find_renamed_types', 'Find types likely renamed after a game update.', {
            type: 'object',
            properties: {
                old_assembly_path: { type: 'string', description: 'Path to old version DLL' },
                new_assembly_path: { type: 'string', description: 'Path to new version DLL' },
                min_similarity: { type: 'number', description: 'Min similarity threshold 0-1 (default: 0.6)' },
            },
            required: ['old_assembly_path', 'new_assembly_path'],
        }),
        delegateTool('verify_patches', 'Verify Harmony patch targets in plugin still exist in game assembly.', {
            type: 'object',
            properties: {
                plugin_path: { type: 'string', description: 'Path to compiled plugin DLL' },
                game_assembly: { type: 'string', description: 'Path to game Assembly-CSharp.dll' },
            },
            required: ['plugin_path', 'game_assembly'],
        }),
    ];
}
//# sourceMappingURL=unity-decompiler.js.map