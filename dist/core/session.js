import { eventBus } from './event-bus.js';
class GameSession {
    state;
    constructor() {
        this.state = this.createEmptyState();
    }
    createEmptyState() {
        return {
            gamePath: null,
            gameName: null,
            engine: null,
            engineVersion: null,
            runtime: null,
            loadedAssemblies: [],
            loadedUnrealGame: null,
            openJarSessions: [],
            discoveredTypes: new Map(),
            discoveredValues: new Map(),
            decompilationCache: new Map(),
            modFramework: null,
            modProjectPath: null,
            lastBuildResult: null,
            deployPath: null,
            toolCallHistory: [],
        };
    }
    getState() {
        return this.state;
    }
    getSerializableState() {
        return {
            gamePath: this.state.gamePath,
            gameName: this.state.gameName,
            engine: this.state.engine,
            engineVersion: this.state.engineVersion,
            runtime: this.state.runtime,
            loadedAssemblies: this.state.loadedAssemblies,
            loadedUnrealGame: this.state.loadedUnrealGame,
            openJarSessions: this.state.openJarSessions,
            discoveredTypesCount: this.state.discoveredTypes.size,
            discoveredValuesCount: this.state.discoveredValues.size,
            decompilationCacheSize: this.state.decompilationCache.size,
            modFramework: this.state.modFramework,
            modProjectPath: this.state.modProjectPath,
            lastBuildResult: this.state.lastBuildResult,
            deployPath: this.state.deployPath,
            toolCallCount: this.state.toolCallHistory.length,
            recentToolCalls: this.state.toolCallHistory.slice(-20),
        };
    }
    setGame(gamePath, gameName, engine, runtime) {
        this.state.gamePath = gamePath;
        this.state.gameName = gameName;
        this.state.engine = engine;
        this.state.runtime = runtime;
        eventBus.emit('session:updated', {
            gamePath,
            gameName,
            engine,
            runtime,
        });
    }
    addAssembly(key, path, typeCount) {
        const existing = this.state.loadedAssemblies.find(a => a.key === key);
        if (existing) {
            existing.typeCount = typeCount;
        }
        else {
            this.state.loadedAssemblies.push({ key, path, typeCount });
        }
    }
    cacheType(name, info) {
        this.state.discoveredTypes.set(name, info);
    }
    cacheValue(key, info) {
        this.state.discoveredValues.set(key, info);
    }
    cacheDecompilation(typeKey, source) {
        this.state.decompilationCache.set(typeKey, source);
    }
    getCachedDecompilation(typeKey) {
        return this.state.decompilationCache.get(typeKey);
    }
    recordToolCall(record) {
        this.state.toolCallHistory.push(record);
        // Keep last 500 entries
        if (this.state.toolCallHistory.length > 500) {
            this.state.toolCallHistory = this.state.toolCallHistory.slice(-500);
        }
    }
    setModFramework(framework) {
        this.state.modFramework = framework;
    }
    setBuildResult(result) {
        this.state.lastBuildResult = result;
    }
    setDeployPath(path) {
        this.state.deployPath = path;
    }
    setModProjectPath(path) {
        this.state.modProjectPath = path;
    }
    reset() {
        this.state = this.createEmptyState();
        eventBus.emit('session:updated', {
            gamePath: null,
            gameName: null,
            engine: null,
            runtime: null,
        });
    }
}
export const session = new GameSession();
//# sourceMappingURL=session.js.map