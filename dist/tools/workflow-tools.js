import { detectEngine } from '../core/engine-detector.js';
import { session } from '../core/session.js';
import { extractGameName } from '../utils/path-utils.js';
import { loadConfig } from '../core/config.js';
import { childPool } from '../backends/child-pool.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
export function getWorkflowTools() {
    return [
        {
            name: 'mod_this_game',
            description: 'End-to-end game modding assistant. Detects engine, analyzes game structure, and returns a modding plan with available tools and next steps. Start here when modding a new game.',
            inputSchema: {
                type: 'object',
                properties: {
                    game_path: { type: 'string', description: 'Full path to the game directory' },
                    objective: { type: 'string', description: 'What you want to mod (e.g. "infinite health", "speed hack", "item spawner")' },
                },
                required: ['game_path'],
            },
            handler: async (args) => {
                const gamePath = args.game_path;
                const objective = args.objective;
                const gameName = extractGameName(gamePath);
                // Step 1: Detect engine
                const detection = detectEngine(gamePath);
                session.setGame(gamePath, gameName, detection.engine, detection.runtime);
                const plan = {
                    gameName,
                    gamePath,
                    engine: detection.engine,
                    runtime: detection.runtime,
                    confidence: detection.confidence,
                    details: detection.details,
                    primaryAssembly: detection.primaryAssembly,
                };
                // Step 2: Determine modding strategy
                switch (detection.engine) {
                    case 'unity-mono':
                        plan.strategy = {
                            framework: 'BepInEx 5 + Harmony',
                            steps: [
                                `1. Load assembly: load_assembly("${detection.primaryAssembly}")`,
                                '2. Search for target classes: list_types(assembly, filter) or search_code(assembly, pattern)',
                                '3. Inspect target type: inspect_type(assembly, type_name)',
                                '4. Decompile to verify: decompile_type(assembly, type_name)',
                                '5. Generate patch: generate_harmony_patch(assembly, type, method)',
                                '6. Generate plugin: generate_plugin(name, guid)',
                                '7. Compile: compile_plugin(source, managed_dir, bepinex_dir, output)',
                                '8. Deploy to BepInEx/plugins/',
                                '9. Test and debug: analyze_bepinex_log(log_path)',
                            ],
                            deployPath: join(gamePath, 'BepInEx', 'plugins'),
                        };
                        session.setModFramework('bepinex5');
                        break;
                    case 'unity-il2cpp':
                        plan.strategy = {
                            framework: 'MelonLoader',
                            steps: [
                                `1. Dump metadata: unity_il2cpp_dump_metadata("${detection.metadataPath}")`,
                                '2. Search classes: unity_il2cpp_find_class(metadata_path, class_name)',
                                '3. Check anti-cheat: actk_scan_obscured_values(metadata_path)',
                                '4. Analyze GameAssembly.dll: analyze_pe_full(path)',
                                '5. Pattern scan for values: pattern_scan(path, pattern)',
                                '6. Generate MelonLoader mod code',
                                '7. Compile with dotnet build',
                                '8. Deploy to Mods/',
                            ],
                            deployPath: join(gamePath, 'Mods'),
                        };
                        session.setModFramework('melonloader');
                        break;
                    case 'unreal':
                        plan.strategy = {
                            framework: 'Unreal Asset Editing / UE4SS',
                            steps: [
                                `1. Open game: open_game("${gamePath}")`,
                                '2. Search assets: search_assets(query)',
                                '3. Read target assets: read_asset(path) or read_blueprint(path)',
                                '4. Read datatables: read_datatable(path)',
                                '5. Modify values via binary patching or UE4SS Lua scripts',
                            ],
                        };
                        break;
                    case 'java':
                        plan.strategy = {
                            framework: 'JAR Editor (direct class modification)',
                            steps: [
                                `1. Open JAR: jar_open("${detection.primaryAssembly}")`,
                                '2. List contents: jar_list(session_id)',
                                '3. Search for targets: jar_search(session_id, query)',
                                '4. Read target class: jar_read_class(session_id, class_path)',
                                '5. Inspect constants: jar_inspect_constant_pool(session_id, class_path)',
                                '6. Edit values: jar_edit_class_constants(session_id, class_path, replacements)',
                                '7. Repack JAR: jar_repack(session_id)',
                            ],
                        };
                        session.setModFramework('jar-edit');
                        break;
                    case 'godot':
                        plan.strategy = {
                            framework: 'PCK Editor',
                            steps: [
                                `1. Analyze PCK: analyze_godot_pck("${detection.primaryAssembly}")`,
                                '2. Extract and read GDScript files',
                                '3. Modify scripts',
                                '4. Repack PCK',
                            ],
                        };
                        session.setModFramework('pck-edit');
                        break;
                    default:
                        plan.strategy = {
                            framework: 'Binary analysis + patching',
                            steps: [
                                `1. Analyze executable: analyze_pe_full("${detection.primaryAssembly}")`,
                                '2. Extract strings: extract_strings_advanced(path)',
                                '3. Search patterns: pattern_scan(path, pattern)',
                                '4. Hex edit values: hex_replace(path, offset, data)',
                            ],
                        };
                        session.setModFramework('binary-patch');
                        break;
                }
                if (objective) {
                    plan.objective = objective;
                    plan.searchTerms = generateSearchTerms(objective);
                }
                return JSON.stringify(plan, null, 2);
            },
        },
        {
            name: 'find_gameplay_values',
            description: 'Search for gameplay-related values (health, damage, speed, money, etc.) across the game code. Works with any engine by using the appropriate search tools.',
            inputSchema: {
                type: 'object',
                properties: {
                    search_terms: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Terms to search for (e.g. ["Health", "Damage", "Speed", "Money"])',
                    },
                    assembly_path: { type: 'string', description: 'Path to the game assembly/binary to search' },
                },
                required: ['search_terms', 'assembly_path'],
            },
            handler: async (args) => {
                const terms = args.search_terms;
                const assemblyPath = args.assembly_path;
                const state = session.getState();
                const results = {
                    searchTerms: terms,
                    target: assemblyPath,
                    engine: state.engine,
                };
                // Use appropriate tool based on engine
                try {
                    if (state.engine === 'unity-mono') {
                        // Use unity-decompiler search_code
                        const searchResult = await childPool.call('unity-decompiler', 'search_code', {
                            assembly: basename(assemblyPath, '.dll'),
                            pattern: terms.join('|'),
                            scope: 'all',
                            limit: 200,
                        });
                        results.unitySearchResults = searchResult.content.map(c => c.text).join('\n');
                    }
                    else if (state.engine === 'java') {
                        // Use jar_search
                        const searchResult = await childPool.call('jar-editor', 'jar_search', {
                            session_id: state.openJarSessions[0]?.sessionId || '',
                            search_term: terms.join(' '),
                            search_type: 'content',
                        });
                        results.jarSearchResults = searchResult.content.map(c => c.text).join('\n');
                    }
                }
                catch (err) {
                    results.delegateError = err instanceof Error ? err.message : String(err);
                }
                // Always try native string search as fallback/complement
                // This will be handled by the native tools once ported
                results.suggestion = `For deeper analysis, try: extract_strings_advanced("${assemblyPath}", "${terms[0]}")`;
                return JSON.stringify(results, null, 2);
            },
        },
        {
            name: 'build_and_deploy',
            description: 'Compile a mod project and deploy the output to the game mods directory.',
            inputSchema: {
                type: 'object',
                properties: {
                    project_path: { type: 'string', description: 'Path to the mod project directory' },
                    deploy_path: { type: 'string', description: 'Path to deploy the built mod (auto-detected if omitted)' },
                    build_command: { type: 'string', description: 'Custom build command (auto-detected if omitted)' },
                },
                required: ['project_path'],
            },
            handler: async (args) => {
                const projectPath = args.project_path;
                const state = session.getState();
                const result = {
                    projectPath,
                    modFramework: state.modFramework,
                    gamePath: state.gamePath,
                };
                // Determine deploy path
                let deployPath = args.deploy_path;
                if (!deployPath && state.gamePath) {
                    switch (state.modFramework) {
                        case 'bepinex5':
                        case 'bepinex6':
                            deployPath = join(state.gamePath, 'BepInEx', 'plugins');
                            break;
                        case 'melonloader':
                            deployPath = join(state.gamePath, 'Mods');
                            break;
                    }
                }
                result.deployPath = deployPath || 'Not auto-detected. Specify deploy_path parameter.';
                // Determine build command
                let buildCommand = args.build_command;
                if (!buildCommand) {
                    if (existsSync(join(projectPath, '*.csproj')) || existsSync(join(projectPath, '*.sln'))) {
                        buildCommand = `dotnet build "${projectPath}" -c Release`;
                    }
                }
                result.buildCommand = buildCommand || 'Could not auto-detect. Specify build_command parameter.';
                result.instructions = 'Run the build command above, then copy the output DLL to the deploy path.';
                return JSON.stringify(result, null, 2);
            },
        },
        {
            name: 'debug_mod',
            description: 'Analyze mod logs to diagnose errors and suggest fixes.',
            inputSchema: {
                type: 'object',
                properties: {
                    log_path: { type: 'string', description: 'Path to the mod log file' },
                    game_path: { type: 'string', description: 'Game directory (for auto-detecting log location)' },
                },
            },
            handler: async (args) => {
                let logPath = args.log_path;
                const gamePath = args.game_path || session.getState().gamePath;
                // Auto-detect log path if not provided
                if (!logPath && gamePath) {
                    const candidates = [
                        join(gamePath, 'BepInEx', 'LogOutput.log'),
                        join(gamePath, 'MelonLoader', 'Latest.log'),
                    ];
                    logPath = candidates.find(p => existsSync(p));
                }
                if (!logPath || !existsSync(logPath)) {
                    return JSON.stringify({
                        error: 'Log file not found',
                        triedPaths: logPath ? [logPath] : [],
                        suggestion: 'Provide log_path or ensure game has been run with mod framework installed.',
                    }, null, 2);
                }
                // Try to use BepInEx log analyzer via delegate
                const state = session.getState();
                if (state.modFramework === 'bepinex5' || state.modFramework === 'bepinex6') {
                    try {
                        const result = await childPool.call('unity-decompiler', 'analyze_bepinex_log', { log_path: logPath });
                        return result.content.map(c => c.text).join('\n');
                    }
                    catch {
                        // Fall through to basic analysis
                    }
                }
                // Basic log analysis
                const logContent = readFileSync(logPath, 'utf-8');
                const lines = logContent.split('\n');
                const errors = lines.filter(l => /error|exception|fail/i.test(l));
                const warnings = lines.filter(l => /warn/i.test(l));
                return JSON.stringify({
                    logPath,
                    totalLines: lines.length,
                    errors: errors.slice(0, 20),
                    warnings: warnings.slice(0, 10),
                    suggestion: errors.length > 0 ? 'Review the errors above. Common fixes: check assembly references, verify method signatures, ensure correct framework version.' : 'No errors found in log.',
                }, null, 2);
            },
        },
        {
            name: 'scaffold_mod',
            description: 'Generate a mod project skeleton from templates. Creates project files, plugin class, and build configuration.',
            inputSchema: {
                type: 'object',
                properties: {
                    mod_name: { type: 'string', description: 'Mod name (used for class name and project)' },
                    mod_guid: { type: 'string', description: 'Unique mod identifier (e.g. com.author.modname)' },
                    output_dir: { type: 'string', description: 'Where to create the mod project' },
                    framework: { type: 'string', description: 'Mod framework: bepinex5, melonloader, jar (auto-detected from loaded game if omitted)' },
                    game_managed_dir: { type: 'string', description: 'Path to game Managed directory (for .csproj references)' },
                },
                required: ['mod_name', 'output_dir'],
            },
            handler: async (args) => {
                const modName = args.mod_name;
                const modGuid = args.mod_guid || `com.modder.${modName.toLowerCase().replace(/\s+/g, '')}`;
                const outputDir = args.output_dir;
                const framework = args.framework || session.getState().modFramework || 'bepinex5';
                const managedDir = args.game_managed_dir;
                const config = loadConfig();
                const result = {
                    modName,
                    modGuid,
                    outputDir,
                    framework,
                    templateDir: config.modTemplatesDir,
                };
                // Check if templates exist
                if (config.modTemplatesDir && existsSync(config.modTemplatesDir)) {
                    const available = readdirSync(config.modTemplatesDir, { withFileTypes: true })
                        .filter(e => e.isDirectory())
                        .map(e => e.name);
                    result.availableTemplates = available;
                    result.instructions = [
                        `Templates available at: ${config.modTemplatesDir}`,
                        `Create the project at: ${outputDir}`,
                        'Use generate_plugin tool for BepInEx plugins with auto-generated code.',
                        'Or read templates and customize manually.',
                    ];
                }
                else {
                    result.instructions = [
                        'No template directory configured or found.',
                        'For BepInEx: use generate_plugin tool to create plugin code.',
                        'For Java: use jar_scaffold_mod tool to create mod structure.',
                    ];
                }
                if (managedDir) {
                    result.managedDir = managedDir;
                }
                return JSON.stringify(result, null, 2);
            },
        },
        {
            name: 'list_available_tools',
            description: 'List all tools available for the currently loaded game engine, grouped by category.',
            inputSchema: {
                type: 'object',
                properties: {
                    engine: { type: 'string', description: 'Engine to list tools for (uses current game if omitted)' },
                },
            },
            handler: async (args) => {
                const engine = args.engine || session.getState().engine;
                const toolGroups = {
                    'Always Available': [
                        'detect_engine', 'load_game', 'game_status', 'find_steam_games',
                        'mod_this_game', 'find_gameplay_values', 'build_and_deploy',
                        'debug_mod', 'scaffold_mod', 'list_available_tools',
                    ],
                    'Binary Analysis (any game)': [
                        'analyze_pe_full', 'analyze_dll_exports', 'analyze_dll_imports',
                        'analyze_file_format', 'hex_read', 'hex_write', 'hex_search', 'hex_replace',
                        'pattern_scan', 'pattern_scan_all', 'extract_strings_advanced',
                        'extract_dll_classes', 'search_binary_pattern', 'extract_strings',
                        'disassemble_function', 'calculate_checksums', 'compare_binaries_detailed',
                    ],
                };
                switch (engine) {
                    case 'unity-mono':
                        toolGroups['Unity Mono (Decompilation & Patching)'] = [
                            'load_assembly', 'list_types', 'inspect_type', 'decompile_type',
                            'decompile_method', 'get_method_il', 'search_code', 'find_references',
                            'get_inheritance_tree', 'list_monobehaviours', 'list_scriptableobjects',
                            'get_serialized_fields', 'generate_harmony_patch', 'generate_plugin',
                            'compile_plugin', 'validate_patch_target', 'list_patchable_methods',
                            'analyze_bepinex_log', 'validate_assembly', 'verify_patches',
                        ];
                        break;
                    case 'unity-il2cpp':
                        toolGroups['Unity IL2CPP (Metadata & Analysis)'] = [
                            'unity_il2cpp_dump_metadata', 'unity_il2cpp_find_class',
                            'actk_scan_obscured_values', 'actk_decrypt_value', 'actk_struct_info',
                            'unity_playerprefs_read', 'unity_playerprefs_write',
                        ];
                        break;
                    case 'unreal':
                        toolGroups['Unreal Engine (Asset Reading)'] = [
                            'open_game', 'unreal_game_status', 'list_assets', 'search_assets',
                            'read_asset', 'read_asset_export', 'list_exports', 'read_blueprint',
                            'find_blueprints_of_type', 'read_datatable', 'get_class_hierarchy',
                        ];
                        break;
                    case 'java':
                        toolGroups['Java (JAR Editing)'] = [
                            'jar_open', 'jar_close', 'jar_list', 'jar_search', 'jar_read_class',
                            'jar_read_file', 'jar_inspect_constant_pool', 'jar_edit_class_constants',
                            'jar_edit_constant_pool', 'jar_compile_java', 'jar_repack',
                            'jar_scaffold_mod', 'jar_diff', 'jar_restore_file',
                        ];
                        break;
                    case 'godot':
                        toolGroups['Godot (PCK Analysis)'] = ['analyze_godot_pck'];
                        break;
                }
                return JSON.stringify({ engine: engine || 'none', toolGroups }, null, 2);
            },
        },
    ];
}
function generateSearchTerms(objective) {
    const lower = objective.toLowerCase();
    const terms = [];
    const mappings = {
        health: ['Health', 'HP', 'HitPoint', 'HealthManager', 'PlayerHealth', 'maxHealth', 'currentHealth'],
        damage: ['Damage', 'Attack', 'DamageManager', 'baseDamage', 'attackPower'],
        speed: ['Speed', 'MoveSpeed', 'WalkSpeed', 'RunSpeed', 'PlayerMovement', 'moveSpeed'],
        money: ['Money', 'Gold', 'Currency', 'Coins', 'Cash', 'Balance', 'Wallet'],
        ammo: ['Ammo', 'Ammunition', 'Bullet', 'Magazine', 'maxAmmo', 'currentAmmo'],
        inventory: ['Inventory', 'Item', 'ItemManager', 'Backpack', 'Storage'],
        stamina: ['Stamina', 'Energy', 'Endurance', 'Fatigue'],
        level: ['Level', 'Experience', 'XP', 'LevelUp', 'PlayerLevel'],
        cooldown: ['Cooldown', 'Timer', 'CooldownManager', 'AbilityCooldown'],
    };
    for (const [key, values] of Object.entries(mappings)) {
        if (lower.includes(key)) {
            terms.push(...values);
        }
    }
    // If no specific terms matched, try to extract keywords
    if (terms.length === 0) {
        const words = objective.split(/\s+/).filter(w => w.length > 3);
        terms.push(...words.map(w => w.charAt(0).toUpperCase() + w.slice(1)));
    }
    return [...new Set(terms)];
}
//# sourceMappingURL=workflow-tools.js.map