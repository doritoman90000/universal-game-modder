import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '../utils/logger.js';
import { eventBus } from '../core/event-bus.js';
export class McpChild {
    config;
    client = null;
    transport = null;
    connected = false;
    connecting = false;
    pid;
    constructor(config) {
        this.config = config;
    }
    get name() {
        return this.config.name;
    }
    get isConnected() {
        return this.connected;
    }
    async ensureConnected() {
        if (this.connected)
            return;
        if (this.connecting) {
            // Wait for ongoing connection
            while (this.connecting) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (this.connected)
                return;
        }
        this.connecting = true;
        try {
            logger.info(`Spawning child MCP server: ${this.config.name}`, {
                command: this.config.command,
                args: this.config.args,
            });
            this.transport = new StdioClientTransport({
                command: this.config.command,
                args: this.config.args || [],
                env: { ...process.env, ...this.config.env },
                stderr: 'pipe',
            });
            this.client = new Client({ name: `ugm-${this.config.name}`, version: '1.0.0' }, { capabilities: {} });
            await this.client.connect(this.transport);
            this.connected = true;
            eventBus.emit('child:status', {
                name: this.config.name,
                pid: this.pid,
                status: 'spawned',
            });
            logger.info(`Child MCP server connected: ${this.config.name}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to connect child: ${this.config.name}`, msg);
            eventBus.emit('child:status', {
                name: this.config.name,
                status: 'error',
                error: msg,
            });
            throw err;
        }
        finally {
            this.connecting = false;
        }
    }
    async callTool(toolName, args) {
        await this.ensureConnected();
        if (!this.client)
            throw new Error(`Child ${this.config.name} not connected`);
        const result = await this.client.callTool({ name: toolName, arguments: args });
        return result;
    }
    async listTools() {
        await this.ensureConnected();
        if (!this.client)
            throw new Error(`Child ${this.config.name} not connected`);
        const result = await this.client.listTools();
        return result.tools;
    }
    async close() {
        if (this.client && this.connected) {
            try {
                await this.client.close();
            }
            catch {
                // Ignore close errors
            }
            this.connected = false;
            eventBus.emit('child:status', {
                name: this.config.name,
                status: 'exited',
                exitCode: 0,
            });
            logger.info(`Child MCP server closed: ${this.config.name}`);
        }
        this.client = null;
        this.transport = null;
    }
}
//# sourceMappingURL=mcp-child.js.map