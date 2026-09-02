import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllTools } from './tools/index.js';
import { logger } from './utils/logger.js';
// Single source of truth for the version: package.json. A hardcoded string here
// silently drifts from the shipped package (it once reported 1.0.0 for a 0.1.0
// release), which makes it impossible to tell which build a user is running.
function getVersion() {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
export async function startMcpServer() {
    const server = new Server({ name: 'universal-game-modder', version: getVersion() }, { capabilities: { tools: {} } });
    // Register tool list handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = getAllTools();
        return {
            tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            })),
        };
    });
    // Register tool call handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const tools = getAllTools();
        const tool = tools.find(t => t.name === name);
        if (!tool) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}. Use list_available_tools to see available tools.` }],
                isError: true,
            };
        }
        try {
            const result = await tool.handler(args || {});
            return {
                content: [{ type: 'text', text: result }],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Tool ${name} failed`, msg);
            return {
                content: [{ type: 'text', text: `ERROR in ${name}: ${msg}` }],
                isError: true,
            };
        }
    });
    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Universal Game Modder MCP server started on stdio');
}
//# sourceMappingURL=server.js.map