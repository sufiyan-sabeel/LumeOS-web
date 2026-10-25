/*
 * LumeOS - desktop/events.ts
 * A tiny, strictly-typed publish/subscribe event bus used for inter-app
 * communication (the LumeOS IPC layer).
 */
export class EventBus {
    listeners = new Map();
    on(event, fn) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(fn);
        return () => this.off(event, fn);
    }
    off(event, fn) {
        const set = this.listeners.get(event);
        if (set)
            set.delete(fn);
    }
    emit(event, payload) {
        const set = this.listeners.get(event);
        if (!set)
            return;
        for (const fn of Array.from(set)) {
            try {
                fn(payload);
            }
            catch (err) {
                console.error(`[LumeOS] listener for "${String(event)}" threw`, err);
            }
        }
    }
}
export const bus = new EventBus();
