/*
 * LumeOS - desktop/events.ts
 * A tiny, strictly-typed publish/subscribe event bus used for inter-app
 * communication (the LumeOS IPC layer).
 */

export type Listener<T> = (payload: T) => void;

export interface LumeEvents {
  'app:opened': { id: string; windowId: string };
  'app:closed': { id: string; windowId: string };
  'window:focused': { windowId: string };
  'window:minimized': { windowId: string };
  'window:closed': { windowId: string };
  'server:status': { online: boolean };
  'fs:changed': { path: string };
  'theme:changed': { theme: string };
  'toast': { title: string; body?: string; kind?: 'info' | 'success' | 'error' };
  'open-file': { path: string };
}

export class EventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  on<K extends keyof LumeEvents>(event: K, fn: Listener<LumeEvents[K]>): () => void {
    let set = this.listeners.get(event as string);
    if (!set) {
      set = new Set();
      this.listeners.set(event as string, set);
    }
    set.add(fn as Listener<unknown>);
    return () => this.off(event, fn);
  }

  off<K extends keyof LumeEvents>(event: K, fn: Listener<LumeEvents[K]>): void {
    const set = this.listeners.get(event as string);
    if (set) set.delete(fn as Listener<unknown>);
  }

  emit<K extends keyof LumeEvents>(event: K, payload: LumeEvents[K]): void {
    const set = this.listeners.get(event as string);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as Listener<LumeEvents[K]>)(payload);
      } catch (err) {
        console.error(`[LumeOS] listener for "${String(event)}" threw`, err);
      }
    }
  }
}

export const bus = new EventBus();
