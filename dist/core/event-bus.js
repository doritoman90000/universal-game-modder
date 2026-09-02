import { EventEmitter } from 'events';
class UgmEventBus {
    emitter = new EventEmitter();
    constructor() {
        this.emitter.setMaxListeners(50);
    }
    on(event, listener) {
        this.emitter.on(event, listener);
    }
    off(event, listener) {
        this.emitter.off(event, listener);
    }
    emit(event, data) {
        this.emitter.emit(event, data);
    }
}
export const eventBus = new UgmEventBus();
//# sourceMappingURL=event-bus.js.map