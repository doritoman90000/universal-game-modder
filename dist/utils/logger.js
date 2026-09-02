import { eventBus } from '../core/event-bus.js';
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
let minLevel = 'info';
export function setLogLevel(level) {
    minLevel = level;
}
function log(level, message, data) {
    if (LOG_LEVELS[level] < LOG_LEVELS[minLevel])
        return;
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...(data !== undefined ? { data } : {}),
    };
    // Write to stderr (stdout is reserved for MCP stdio transport)
    process.stderr.write(JSON.stringify(entry) + '\n');
}
export const logger = {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
    toolStart(tool, backend) {
        log('info', `Tool call: ${tool} [${backend}]`);
        eventBus.emit('tool:start', {
            tool,
            args: null,
            timestamp: Date.now(),
            backend,
        });
    },
    toolComplete(tool, backend, duration, success) {
        log(success ? 'info' : 'warn', `Tool ${success ? 'completed' : 'failed'}: ${tool} [${backend}] (${duration}ms)`);
        eventBus.emit('tool:complete', {
            tool,
            result: '',
            duration,
            backend,
            success,
        });
    },
};
//# sourceMappingURL=logger.js.map