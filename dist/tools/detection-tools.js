import { detectEngine } from '../core/engine-detector.js';
import { session } from '../core/session.js';
import { eventBus } from '../core/event-bus.js';
import { extractGameName } from '../utils/path-utils.js';
import { findSteamGames } from '../utils/steam-finder.js';
export function getDetectionTools() {
    return [
        {
            name: 'detect_engine',
            description: 'Scan a game directory and detect what engine it uses (Unity, Unreal, Godot, Java, etc.). Returns engine type, runtime, and primary assembly path.',
            inputSchema: {
                type: 'object',
                properties: {
                    game_path: { type: 'string', description: 'Full path to the game directory' },
                },
                required: ['game_path'],
            },
            handler: async (args) => {
                const gamePath = args.game_path;
                const result = detectEngine(gamePath);
                eventBus.emit('engine:detected', {
                    engine: result.engine || 'unknown',
                    runtime: result.runtime,
                    path: gamePath,
                    confidence: result.confidence,
                });
                return JSON.stringify(result, null, 2);
            },
        },
        {
            name: 'load_game',
            description: 'Set a game as the active modding target. Auto-detects engine, sets up session state, and returns what tools are available for this game type.',
            inputSchema: {
                type: 'object',
                properties: {
                    game_path: { type: 'string', description: 'Full path to the game directory' },
                    game_name: { type: 'string', description: 'Optional human-readable game name (auto-detected from path if omitted)' },
                },
                required: ['game_path'],
            },
            handler: async (args) => {
                const gamePath = args.game_path;
                const gameName = args.game_name || extractGameName(gamePath);
                const detection = detectEngine(gamePath);
                session.setGame(gamePath, gameName, detection.engine, detection.runtime);
                // Suggest mod framework based on engine
                let suggestedFramework = '';
                switch (detection.engine) {
                    case 'unity-mono':
                        suggestedFramework = 'BepInEx 5 + Harmony';
                        session.setModFramework('bepinex5');
                        break;
                    case 'unity-il2cpp':
                        suggestedFramework = 'MelonLoader or BepInEx 6';
                        session.setModFramework('melonloader');
                        break;
                    case 'unreal':
                        suggestedFramework = 'UE4SS or binary patching';
                        break;
                    case 'java':
                        suggestedFramework = 'JAR editor (direct class modification)';
                        session.setModFramework('jar-edit');
                        break;
                    case 'godot':
                        suggestedFramework = 'PCK editor (GDScript modification)';
                        session.setModFramework('pck-edit');
                        break;
                    case 'native':
                        suggestedFramework = 'Binary patching / DLL injection';
                        session.setModFramework('binary-patch');
                        break;
                    case 'lua':
                        suggestedFramework = 'Direct Lua script editing';
                        session.setModFramework('lua-edit');
                        break;
                    case 'electron':
                        suggestedFramework = 'Direct JS source modification';
                        session.setModFramework('js-edit');
                        break;
                }
                const response = {
                    gameName,
                    gamePath,
                    engine: detection.engine,
                    runtime: detection.runtime,
                    confidence: detection.confidence,
                    details: detection.details,
                    primaryAssembly: detection.primaryAssembly || null,
                    metadataPath: detection.metadataPath || null,
                    suggestedFramework,
                    nextSteps: getNextSteps(detection),
                };
                return JSON.stringify(response, null, 2);
            },
        },
        {
            name: 'game_status',
            description: 'Get the current session state including loaded game, engine type, cached analysis data, and mod build status.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            handler: async () => {
                return JSON.stringify(session.getSerializableState(), null, 2);
            },
        },
        {
            name: 'find_steam_games',
            description: 'Search configured Steam library paths for installed games. Optionally filter by name.',
            inputSchema: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional name filter (case-insensitive partial match)' },
                },
            },
            handler: async (args) => {
                const filter = args.filter;
                const games = findSteamGames(filter);
                if (games.length === 0) {
                    return 'No Steam games found' + (filter ? ` matching "${filter}"` : '') + '. Check steamPaths in ugm.config.json.';
                }
                return JSON.stringify(games, null, 2);
            },
        },
    ];
}
function getNextSteps(detection) {
    const steps = [];
    switch (detection.engine) {
        case 'unity-mono':
            steps.push(`Load the assembly: load_assembly("${detection.primaryAssembly}")`);
            steps.push('List game types: list_types(assembly_key, filter)');
            steps.push('Search for gameplay values: find_gameplay_values(search_terms)');
            break;
        case 'unity-il2cpp':
            steps.push(`Dump IL2CPP metadata: unity_il2cpp_dump_metadata("${detection.metadataPath}")`);
            steps.push('Search for classes: unity_il2cpp_find_class(metadata_path, class_name)');
            steps.push('Check for anti-cheat: actk_scan_obscured_values(metadata_path)');
            break;
        case 'unreal':
            steps.push(`Open game: open_game("${detection.primaryAssembly || ''}")`);
            steps.push('List assets: list_assets(path_filter)');
            steps.push('Search assets: search_assets(query)');
            break;
        case 'java':
            steps.push(`Open JAR: jar_open("${detection.primaryAssembly}")`);
            steps.push('List contents: jar_list(session_id)');
            steps.push('Search classes: jar_search(session_id, query)');
            break;
        case 'godot':
            steps.push(`Analyze PCK: analyze_godot_pck("${detection.primaryAssembly}")`);
            break;
        case 'native':
            steps.push(`Analyze executable: analyze_pe_full("${detection.primaryAssembly}")`);
            steps.push('Extract strings: extract_strings_advanced(path, filter)');
            steps.push('Search patterns: pattern_scan(path, pattern)');
            break;
        default:
            steps.push('Engine not detected. Try analyze_file_format on the main executable.');
            break;
    }
    return steps;
}
//# sourceMappingURL=detection-tools.js.map