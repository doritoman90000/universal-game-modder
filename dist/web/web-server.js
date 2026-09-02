import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { session } from '../core/session.js';
import { eventBus } from '../core/event-bus.js';
import { childPool } from '../backends/child-pool.js';
import { logger } from '../utils/logger.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let wss;
function broadcast(event, data) {
    if (!wss)
        return;
    const message = JSON.stringify({ event, data, timestamp: Date.now() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}
export function startWebServer(port) {
    const app = express();
    app.use(express.json());
    // Serve static files (React build)
    const publicDir = join(__dirname, '..', 'web', 'public');
    if (existsSync(publicDir)) {
        app.use(express.static(publicDir));
    }
    // API endpoints
    app.get('/api/session', (_req, res) => {
        res.json(session.getSerializableState());
    });
    app.get('/api/children', (_req, res) => {
        res.json(childPool.getStatus());
    });
    app.get('/api/health', (_req, res) => {
        res.json({
            status: 'ok',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            session: {
                gameName: session.getState().gameName,
                engine: session.getState().engine,
            },
        });
    });
    // SPA fallback
    app.get('*', (_req, res) => {
        const indexPath = join(publicDir, 'index.html');
        if (existsSync(indexPath)) {
            res.sendFile(indexPath);
        }
        else {
            // Serve inline dashboard if no React build exists
            res.send(getInlineDashboard());
        }
    });
    const server = createServer(app);
    // WebSocket for real-time updates
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
        // Send current state on connect
        ws.send(JSON.stringify({
            event: 'session:full',
            data: session.getSerializableState(),
            timestamp: Date.now(),
        }));
        ws.send(JSON.stringify({
            event: 'children:status',
            data: childPool.getStatus(),
            timestamp: Date.now(),
        }));
    });
    // Wire up event bus to WebSocket broadcast
    const events = [
        'tool:start', 'tool:complete', 'tool:error',
        'session:updated', 'child:status', 'build:output', 'engine:detected',
    ];
    for (const event of events) {
        eventBus.on(event, (data) => broadcast(event, data));
    }
    // A dashboard bind failure (e.g. EADDRINUSE) must never kill the MCP server.
    // listen() errors are emitted async on the 'error' event, so a try/catch
    // around startWebServer() cannot catch them.
    server.on('error', (err) => {
        logger.warn(`UGM Web Dashboard unavailable (port ${port}): ${err.message}`);
    });
    wss.on('error', (err) => {
        logger.warn(`UGM Web Dashboard WebSocket error: ${err.message}`);
    });
    server.listen(port, () => {
        logger.info(`UGM Web Dashboard running at http://localhost:${port}`);
    });
}
function getInlineDashboard() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Universal Game Modder</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      padding: 20px 30px; border-bottom: 2px solid #e94560;
      display: flex; align-items: center; gap: 15px;
    }
    .header h1 { font-size: 24px; color: #fff; }
    .header .subtitle { color: #888; font-size: 14px; }
    .engine-badge {
      padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 1px;
    }
    .engine-unity { background: #1a73e8; color: white; }
    .engine-unreal { background: #9b59b6; color: white; }
    .engine-java { background: #e67e22; color: white; }
    .engine-godot { background: #27ae60; color: white; }
    .engine-native { background: #666; color: white; }
    .engine-none { background: #333; color: #888; }
    .container { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px; max-width: 1600px; margin: 0 auto; }
    .panel { background: #12121a; border: 1px solid #2a2a3a; border-radius: 8px; overflow: hidden; }
    .panel-header { padding: 12px 16px; background: #1a1a2e; border-bottom: 1px solid #2a2a3a; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
    .panel-body { padding: 16px; max-height: 400px; overflow-y: auto; }
    .panel-body::-webkit-scrollbar { width: 6px; }
    .panel-body::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1a1a2a; }
    .info-label { color: #888; }
    .info-value { color: #e0e0e0; font-family: 'Cascadia Code', monospace; }
    .log-entry { padding: 6px 8px; border-bottom: 1px solid #1a1a2a; font-size: 13px; font-family: monospace; }
    .log-entry.success { border-left: 3px solid #27ae60; }
    .log-entry.error { border-left: 3px solid #e94560; }
    .log-entry.pending { border-left: 3px solid #f39c12; }
    .log-time { color: #555; font-size: 11px; }
    .log-tool { color: #1a73e8; font-weight: 600; }
    .log-backend { color: #888; font-size: 11px; }
    .log-duration { color: #27ae60; float: right; }
    .child-status { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-dot.connected { background: #27ae60; box-shadow: 0 0 6px #27ae60; }
    .status-dot.idle { background: #555; }
    .status-dot.disconnected { background: #e94560; }
    .status-dot.error { background: #e94560; box-shadow: 0 0 6px #e94560; }
    .full-width { grid-column: 1 / -1; }
    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .stat-card { background: #1a1a2e; border-radius: 6px; padding: 16px; text-align: center; }
    .stat-value { font-size: 28px; font-weight: 700; color: #e94560; }
    .stat-label { font-size: 12px; color: #888; margin-top: 4px; }
    .empty-state { color: #555; text-align: center; padding: 40px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Universal Game Modder</h1>
      <div class="subtitle">MCP Tool Orchestrator</div>
    </div>
    <span id="engineBadge" class="engine-badge engine-none">No Game Loaded</span>
    <div style="margin-left: auto; color: #555; font-size: 12px;">
      <span id="connectionStatus">Connecting...</span>
    </div>
  </div>

  <div class="container">
    <!-- Stats -->
    <div class="panel full-width">
      <div class="panel-body">
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-value" id="statToolCalls">0</div>
            <div class="stat-label">Tool Calls</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="statSuccessRate">-</div>
            <div class="stat-label">Success Rate</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="statTypesFound">0</div>
            <div class="stat-label">Types Cached</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="statUptime">0s</div>
            <div class="stat-label">Uptime</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Game Info -->
    <div class="panel">
      <div class="panel-header">Game Info</div>
      <div class="panel-body" id="gameInfo">
        <div class="empty-state">No game loaded. Use load_game or mod_this_game to start.</div>
      </div>
    </div>

    <!-- Child Processes -->
    <div class="panel">
      <div class="panel-header">Backend Processes</div>
      <div class="panel-body" id="childProcesses">
        <div class="child-status" data-name="unity-decompiler"><span class="status-dot disconnected"></span> unity-decompiler <span style="color:#555;margin-left:auto">idle</span></div>
        <div class="child-status" data-name="unreal-assets"><span class="status-dot disconnected"></span> unreal-assets <span style="color:#555;margin-left:auto">idle</span></div>
        <div class="child-status" data-name="jar-editor"><span class="status-dot disconnected"></span> jar-editor <span style="color:#555;margin-left:auto">idle</span></div>
      </div>
    </div>

    <!-- Tool Log -->
    <div class="panel full-width">
      <div class="panel-header">
        Tool Call Log
        <span id="logCount" style="color:#555;font-size:12px">0 calls</span>
      </div>
      <div class="panel-body" id="toolLog" style="max-height: 500px;">
        <div class="empty-state">Waiting for tool calls...</div>
      </div>
    </div>
  </div>

  <script>
    const state = { toolCalls: 0, successes: 0, startTime: Date.now() };

    function connect() {
      const ws = new WebSocket('ws://' + location.host);

      ws.onopen = () => {
        document.getElementById('connectionStatus').textContent = 'Connected';
        document.getElementById('connectionStatus').style.color = '#27ae60';
      };

      ws.onclose = () => {
        document.getElementById('connectionStatus').textContent = 'Disconnected';
        document.getElementById('connectionStatus').style.color = '#e94560';
        setTimeout(connect, 2000);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleEvent(msg.event, msg.data);
      };
    }

    function handleEvent(event, data) {
      switch (event) {
        case 'session:full':
        case 'session:updated':
          updateGameInfo(data);
          break;
        case 'tool:start':
          addLogEntry(data, 'pending');
          break;
        case 'tool:complete':
          updateLogEntry(data);
          state.toolCalls++;
          if (data.success) state.successes++;
          updateStats();
          break;
        case 'tool:error':
          addLogEntry(data, 'error');
          state.toolCalls++;
          updateStats();
          break;
        case 'child:status':
          updateChildStatus(data);
          break;
        case 'engine:detected':
          updateEngineBadge(data.engine, data.runtime);
          break;
        case 'children:status':
          updateAllChildren(data);
          break;
      }
    }

    function updateGameInfo(data) {
      const el = document.getElementById('gameInfo');
      if (!data.gameName && !data.gamePath) return;
      el.innerHTML = [
        row('Game', data.gameName || 'Unknown'),
        row('Path', data.gamePath || '-'),
        row('Engine', data.engine || 'Not detected'),
        row('Runtime', data.runtime || '-'),
        row('Assemblies', (data.loadedAssemblies || []).length),
        row('Framework', data.modFramework || '-'),
      ].join('');
      if (data.engine) updateEngineBadge(data.engine, data.runtime);
      if (data.discoveredTypesCount) document.getElementById('statTypesFound').textContent = data.discoveredTypesCount;
    }

    function row(label, value) {
      return '<div class="info-row"><span class="info-label">' + label + '</span><span class="info-value">' + value + '</span></div>';
    }

    function addLogEntry(data, status) {
      const el = document.getElementById('toolLog');
      if (el.querySelector('.empty-state')) el.innerHTML = '';
      const entry = document.createElement('div');
      entry.className = 'log-entry ' + status;
      entry.id = 'log-' + data.tool + '-' + (data.timestamp || Date.now());
      entry.innerHTML = '<span class="log-time">' + new Date().toLocaleTimeString() + '</span> '
        + '<span class="log-tool">' + data.tool + '</span> '
        + '<span class="log-backend">[' + data.backend + ']</span>'
        + (status === 'pending' ? '<span class="log-duration" style="color:#f39c12">running...</span>' : '');
      el.insertBefore(entry, el.firstChild);
      document.getElementById('logCount').textContent = el.children.length + ' calls';
    }

    function updateLogEntry(data) {
      const entries = document.querySelectorAll('.log-entry.pending');
      for (const entry of entries) {
        if (entry.querySelector('.log-tool')?.textContent === data.tool) {
          entry.className = 'log-entry ' + (data.success ? 'success' : 'error');
          const dur = entry.querySelector('.log-duration');
          if (dur) { dur.textContent = data.duration + 'ms'; dur.style.color = data.success ? '#27ae60' : '#e94560'; }
          return;
        }
      }
      addLogEntry(data, data.success ? 'success' : 'error');
    }

    function updateChildStatus(data) {
      const container = document.getElementById('childProcesses');
      const dotClass = { spawned: 'connected', running: 'connected', idle: 'idle', exited: 'disconnected', error: 'error' };
      const labelText = { spawned: 'running', running: 'running', idle: 'idle', exited: 'stopped', error: 'error' };
      const labelColor = { spawned: '#27ae60', running: '#27ae60', idle: '#888', exited: '#e94560', error: '#e94560' };
      const s = data.status || 'idle';
      const existing = container.querySelector('[data-name="' + data.name + '"]');
      const html = '<span class="status-dot ' + (dotClass[s] || 'idle') + '"></span> '
        + data.name + ' <span style="color:' + (labelColor[s] || '#888') + ';margin-left:auto">' + (labelText[s] || s) + '</span>';
      if (existing) { existing.innerHTML = html; }
      else { const div = document.createElement('div'); div.className = 'child-status'; div.dataset.name = data.name; div.innerHTML = html; container.appendChild(div); }
    }

    function updateAllChildren(data) {
      for (const [name, info] of Object.entries(data)) {
        updateChildStatus({ name, status: info.connected ? 'running' : 'idle' });
      }
    }

    function updateEngineBadge(engine, runtime) {
      const el = document.getElementById('engineBadge');
      const engineClasses = { 'unity-mono': 'unity', 'unity-il2cpp': 'unity', 'unreal': 'unreal', 'java': 'java', 'godot': 'godot' };
      const cls = engineClasses[engine] || 'native';
      el.className = 'engine-badge engine-' + cls;
      el.textContent = (engine || 'Unknown') + (runtime ? ' (' + runtime + ')' : '');
    }

    function updateStats() {
      document.getElementById('statToolCalls').textContent = state.toolCalls;
      document.getElementById('statSuccessRate').textContent = state.toolCalls > 0
        ? Math.round(state.successes / state.toolCalls * 100) + '%' : '-';
    }

    setInterval(() => {
      const secs = Math.floor((Date.now() - state.startTime) / 1000);
      const mins = Math.floor(secs / 60);
      const hrs = Math.floor(mins / 60);
      document.getElementById('statUptime').textContent = hrs > 0 ? hrs + 'h' + (mins%60) + 'm' : mins > 0 ? mins + 'm' : secs + 's';
    }, 1000);

    connect();
  </script>
</body>
</html>`;
}
//# sourceMappingURL=web-server.js.map