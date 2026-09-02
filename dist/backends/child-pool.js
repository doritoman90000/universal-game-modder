import { McpChild } from './mcp-child.js';
import { loadConfig } from '../core/config.js';
import { logger } from '../utils/logger.js';
export class ChildPool {
    children = new Map();
    configs;
    // A backend is only usable if every path it needs is set. jar-editor is the
    // special case: its `command` defaults to "python" (always non-empty), so the
    // command check alone would let it spawn and die with an opaque transport
    // error. Its real requirement is the script path.
    static requiredArgIndex = {
        'jar-editor': 0,
    };
    assertConfigured(backend, cfg) {
        if (!cfg.command) {
            throw new Error(`Backend ${backend} not configured (missing executable path)`);
        }
        const idx = ChildPool.requiredArgIndex[backend];
        if (idx !== undefined && !cfg.args?.[idx]) {
            throw new Error(`Backend ${backend} not configured (missing script path)`);
        }
    }
    constructor() {
        const config = loadConfig();
        this.configs = new Map([
            ['unity-decompiler', {
                    name: 'unity-decompiler',
                    command: config.unityDecompilerExe,
                    args: [],
                }],
            ['unreal-assets', {
                    name: 'unreal-assets',
                    command: config.unrealAssetExe,
                    args: [],
                }],
            ['jar-editor', {
                    name: 'jar-editor',
                    command: config.pythonExe,
                    args: [config.jarEditorScript],
                }],
        ]);
    }
    async call(backend, toolName, args) {
        let child = this.children.get(backend);
        if (!child) {
            const cfg = this.configs.get(backend);
            if (!cfg)
                throw new Error(`Unknown backend: ${backend}`);
            this.assertConfigured(backend, cfg);
            child = new McpChild(cfg);
            this.children.set(backend, child);
        }
        return child.callTool(toolName, args);
    }
    async listToolsFor(backend) {
        let child = this.children.get(backend);
        if (!child) {
            const cfg = this.configs.get(backend);
            if (!cfg)
                throw new Error(`Unknown backend: ${backend}`);
            this.assertConfigured(backend, cfg);
            child = new McpChild(cfg);
            this.children.set(backend, child);
        }
        return child.listTools();
    }
    getStatus() {
        const status = {};
        for (const [name, cfg] of this.configs) {
            const child = this.children.get(name);
            status[name] = {
                connected: child?.isConnected ?? false,
                configured: !!cfg.command,
            };
        }
        return status;
    }
    async closeAll() {
        for (const [name, child] of this.children) {
            try {
                await child.close();
            }
            catch (err) {
                logger.error(`Error closing child ${name}`, err);
            }
        }
        this.children.clear();
    }
}
export const childPool = new ChildPool();
//# sourceMappingURL=child-pool.js.map