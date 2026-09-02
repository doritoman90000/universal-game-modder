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
            logger.toolStart(name, 'unreal-assets');
            try {
                const result = await childPool.call('unreal-assets', name, args);
                const text = result.content.map(c => c.text).join('\n');
                const duration = Date.now() - start;
                logger.toolComplete(name, 'unreal-assets', duration, !result.isError);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: !result.isError, backend: 'unreal-assets' });
                return text;
            }
            catch (err) {
                const duration = Date.now() - start;
                const msg = err instanceof Error ? err.message : String(err);
                logger.toolComplete(name, 'unreal-assets', duration, false);
                session.recordToolCall({ tool: name, timestamp: start, duration, success: false, backend: 'unreal-assets' });
                return `ERROR: ${msg}`;
            }
        },
    };
}
export function getUnrealDelegateTools() {
    return [
        delegateTool('open_game', 'Open a game directory for Unreal asset reading. Scans for .pak/.ucas/.utoc files.', {
            type: 'object',
            properties: {
                game_path: { type: 'string', description: 'Path to game directory' },
                ue_version: { type: 'string', description: 'Unreal Engine version (auto-detected if omitted)' },
                aes_key: { type: 'string', description: 'AES decryption key if assets are encrypted' },
            },
            required: ['game_path'],
        }),
        delegateTool('list_assets', 'List assets in loaded game with file sizes.', {
            type: 'object',
            properties: {
                path_filter: { type: 'string', description: 'Filter assets by path substring' },
                type_filter: { type: 'string', description: 'Filter by asset type' },
                limit: { type: 'number', description: 'Max results (default 200)' },
                offset: { type: 'number', description: 'Skip first N results (default 0)' },
            },
        }),
        delegateTool('search_assets', 'Search for assets by name (case-insensitive).', {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', description: 'Max results (default 100)' },
            },
            required: ['query'],
        }),
        delegateTool('unreal_game_status', 'Check current state of Unreal asset reader.', {
            type: 'object',
            properties: {},
        }),
        delegateTool('read_asset', 'Read all exports and properties from an asset.', {
            type: 'object',
            properties: {
                asset_path: { type: 'string', description: 'Asset path (e.g. /Game/Maps/MainLevel)' },
                max_depth: { type: 'number', description: 'Max property nesting depth (default 4)' },
            },
            required: ['asset_path'],
        }),
        delegateTool('read_asset_export', 'Read a specific named export from an asset.', {
            type: 'object',
            properties: {
                asset_path: { type: 'string', description: 'Asset path' },
                export_name: { type: 'string', description: 'Export name to read' },
                max_depth: { type: 'number', description: 'Max depth (default 5)' },
            },
            required: ['asset_path', 'export_name'],
        }),
        delegateTool('read_blueprint', 'Read Blueprint class definition, components, and default properties.', {
            type: 'object',
            properties: {
                asset_path: { type: 'string', description: 'Blueprint asset path' },
                max_depth: { type: 'number', description: 'Max depth (default 3)' },
            },
            required: ['asset_path'],
        }),
        delegateTool('read_datatable', 'Read a DataTable asset with all rows and field values.', {
            type: 'object',
            properties: {
                asset_path: { type: 'string', description: 'DataTable asset path' },
                row_filter: { type: 'string', description: 'Optional row name filter' },
                limit: { type: 'number', description: 'Max rows (default 100)' },
            },
            required: ['asset_path'],
        }),
        delegateTool('list_exports', 'List all exports in a package without reading full properties.', {
            type: 'object',
            properties: {
                asset_path: { type: 'string', description: 'Asset path' },
            },
            required: ['asset_path'],
        }),
        delegateTool('get_class_hierarchy', 'Get inheritance chain for a Blueprint class.', {
            type: 'object',
            properties: {
                asset_path: { type: 'string', description: 'Blueprint asset path' },
                max_levels: { type: 'number', description: 'Max inheritance levels (default 10)' },
            },
            required: ['asset_path'],
        }),
        delegateTool('find_blueprints_of_type', 'Search for all Blueprint assets inheriting from a parent class.', {
            type: 'object',
            properties: {
                parent_class: { type: 'string', description: 'Parent class name' },
                path_filter: { type: 'string', description: 'Optional path filter' },
                limit: { type: 'number', description: 'Max results (default 50)' },
            },
            required: ['parent_class'],
        }),
    ];
}
//# sourceMappingURL=unreal-assets.js.map