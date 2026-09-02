#!/usr/bin/env node
import { startMcpServer } from './server.js';
import { startWebServer } from './web/web-server.js';
import { loadConfig } from './core/config.js';
import { logger } from './utils/logger.js';
async function main() {
    const config = loadConfig();
    // Start the web dashboard (runs on HTTP port, independent of MCP stdio)
    try {
        startWebServer(config.webPort);
    }
    catch (err) {
        logger.warn('Web dashboard failed to start', err);
        // Non-fatal: MCP server can run without the dashboard
    }
    // Start the MCP server (communicates via stdio)
    await startMcpServer();
}
main().catch((err) => {
    logger.error('Fatal error', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map