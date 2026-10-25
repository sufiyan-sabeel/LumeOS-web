/*
 * LumeOS - desktop/window-manager.ts
 * Window lifecycle, focus stacking, dragging, resizing, edge snapping and
 * keyboard-driven window management.
 *
 * The manager is shell-mode aware: in desktop mode windows live in
 * #window-layer and are freely positioned; in mobile mode the same elements
 * are moved into #app-layer and presented full-screen, one at a time.
 */

import { LumeWindow, type WindowOptions } from '../components/window.js';
import type { AppManifest, LumeWindowHandle, ShellMode } from './types.js';
import { bus } from './events.js';

const MIN_W = 320;
const MIN_H = 200;
const EDGE = 8; // px from a viewport edge that triggers snapping

interface ManagedWindow {
  win: LumeWindow;
  appId: string;
  manifest: AppManifest;
  unmount?: () => void;
}

export class WindowManager {
  private windows = new Map<string, ManagedWindow>();
  private order: string[] = [];
  private z = 100;
  private cascade = 0;
  private mode: ShellMode = 'desktop';
  private activeId: string | null = null;
  private snapPreview: HTMLElement;
  private shortcutsBound = false;
  private backHandler: (() => void) | null = null;

  /** Mobile: invoked by an app view's back button. */
  setBackHandler(fn: () => void): void {
    this.backHandler = fn;
  }

  constructor(private onChange: () => void) {
    this.snapPreview = document.createElement('div');
    this.snapPreview.className = 'snap-preview';
    this.snapPreview.hidden = true;
  }

  private get windowLayer(): HTMLElement {
    return document.getElementById('window-layer') as HTMLElement;
  }

  private get appLayer(): HTMLElement {
    return document.getElementById('app-layer') as HTMLElement;
  }

  private get hostLayer(): HTMLElement {
    return this.mode === 'mobile' ? this.appLayer : this.windowLayer;
  }

  /* ================================================================== */
  /* Queries                                                            */
  /* ================================================================== */
  count(): number { return this.windows.size; }
  list(): LumeWindowHandle[] { return Array.from(this.windows.values()).map((m) => m.win); }
  activeWindowId(): string | null { return this.activeId; }

  findByApp(appId: string): ManagedWindow | undefined {
    for (const m of this.windows.values()) if (m.appId === appId) return m;
    return undefined;
  }

  entries(): Array<{ id: string; appId: string; manifest: AppManifest; minimized: boolean }> {
    return this.order
      .map((id) => this.windows.get(id))
      .filter((m): m is ManagedWindow => !!m)
      .map((m) => ({ id: m.win.id, appId: m.appId, manifest: m.manifest, minimized: m.win.minimized }));
  }

  /* ================================================================== */
  /* Lifecycle                                                          */
  /* ================================================================== */
  create(
    appId: string,
    manifest: AppManifest,
    mount: (win: LumeWindowHandle) => void | Promise<void>,
    unmount?: () => void,
    args: Record<string, unknown> = {}
  ): LumeWindow {
    void args;
    const id = `win-${appId}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    const offset = (this.cascade % 6) * 26;
    this.cascade++;

    const geom: WindowOptions = {
      id,
      title: manifest.name,
      icon: manifest.icon,
      glyph: manifest.glyph,
      width: manifest.width ?? 780,
      height: manifest.height ?? 520,
      x: 88 + offset,
      y: 64 + offset,
      resizable: true,
      onClose: () => this.close(id),
      onMinimize: () => { this.onChange(); this.focusTop(); },
      onMaximize: () => { this.onChange(); },
      /* Back means "return to the home screen" on mobile — the app keeps
       * running — and closes the window on desktop. */
      onBack: () => {
        if (this.mode === 'mobile' && this.backHandler) this.backHandler();
        else this.close(id);
      },
    };

    const win = new LumeWindow(geom);
    this.hostLayer.appendChild(win.el);

    const managed: ManagedWindow = { win, appId, manifest, unmount };
    this.windows.set(id, managed);
    this.order.push(id);

    /* Focus on any pointer interaction without swallowing the event, so
     * buttons, links, text selection and scrolling inside apps keep working. */
    win.el.addEventListener('pointerdown', () => this.focus(id), true);

    if (this.mode === 'desktop') {
      this.wireDrag(managed);
      this.wireResize(managed);
    }

    this.focus(id);
    void mount(win);
    this.bindShortcuts();
    this.onChange();
    bus.emit('app:opened', { id: appId, windowId: id });
    return win;
  }

  close(id: string): void {
    const m = this.windows.get(id);
    if (!m) return;

    /* Give applications a chance to clean up their own listeners. */
    m.win.el.dispatchEvent(new Event('lume:unmount'));
    m.unmount?.();
    m.win.el.remove();

    this.windows.delete(id);
    this.order = this.order.filter((x) => x !== id);

    if (this.activeId === id) {
      this.activeId = null;
      this.focusTop();
    }
    this.onChange();
    bus.emit('app:closed', { id: m.appId, windowId: id });
    bus.emit('window:closed', { windowId: id });
  }

  closeByApp(appId: string): void {
    for (const m of Array.from(this.windows.values())) {
      if (m.appId === appId) this.close(m.win.id);
    }
  }

  /* ================================================================== */
  /* Focus & stacking                                                   */
  /* ================================================================== */
  focus(id: string): void {
    const m = this.windows.get(id);
    if (!m) return;

    if (m.win.minimized) m.win.restore();

    this.z += 1;
    m.win.el.style.zIndex = String(this.z);

    for (const other of this.windows.values()) {
      other.win.el.classList.toggle('focused', other === m);
    }
    this.activeId = id;

    if (this.mode === 'mobile') {
      for (const other of this.windows.values()) other.win.setMobileActive(other === m);
    }

    this.onChange();
    bus.emit('window:focused', { windowId: id });
  }

  private focusTop(): void {
    const visible = this.order.filter((id) => {
      const m = this.windows.get(id);
      return m && !m.win.minimized;
    });
    if (visible.length === 0) {
      this.activeId = null;
      if (this.mode === 'mobile') {
        for (const m of this.windows.values()) m.win.setMobileActive(false);
      }
      this.onChange();
      return;
    }
    this.focus(visible[visible.length - 1]);
  }

  /** Cycle focus through the open windows (used by Alt+Tab style shortcuts). */
  focusNext(delta = 1): void {
    const ids = this.order.filter((id) => {
      const m = this.windows.get(id);
      return m && !m.win.minimized;
    });
    if (ids.length < 2) return;
    const idx = this.activeId ? ids.indexOf(this.activeId) : -1;
    const next = ids[(idx + delta + ids.length * 2) % ids.length];
    this.focus(next);
  }

  /** Mobile: show the home screen while keeping applications running. */
  blur(): void {
    if (this.mode !== 'mobile') return;
    this.activeId = null;
    for (const m of this.windows.values()) {
      m.win.setMobileActive(false);
      m.win.el.classList.remove('focused');
    }
    this.onChange();
  }

  /* ================================================================== */
  /* Shell mode                                                         */
  /* ================================================================== */
  setMode(mode: ShellMode): void {
    if (this.mode === mode) return;
    this.mode = mode;

    /* Move the same elements into the other layer: application state and
     * DOM survive the switch untouched. */
    const target = this.hostLayer;
    for (const m of this.windows.values()) {
      target.appendChild(m.win.el);
      m.win.el.classList.remove('maximized', 'dragging', 'snapping');
      m.win.maximized = false;
      if (mode === 'mobile') {
        m.win.el.classList.remove('minimized');
        m.win.minimized = false;
      }
    }

    if (mode === 'mobile') {
      for (const m of this.windows.values()) m.win.setMobileActive(m.win.id === this.activeId);
      if (!this.activeId) this.focusTop();
    } else {
      for (const m of this.windows.values()) m.win.setMobileActive(false);
    }
    this.onChange();
  }

  /* ================================================================== */
  /* Dragging, snapping, resizing (desktop only)                        */
  /* ================================================================== */
  private wireDrag(m: ManagedWindow): void {
    const win = m.win;

    win.titlebar.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.win-btn, .titlebar__back')) return;
      if (this.mode === 'mobile') return;

      if (win.maximized) win.toggleMaximize();

      const startX = e.clientX;
      const startY = e.clientY;
      const origX = win.el.offsetLeft;
      const origY = win.el.offsetTop;
      const layer = this.windowLayer;
      let moved = false;

      win.titlebar.setPointerCapture(e.pointerId);
      win.el.classList.add('dragging');

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        moved = true;

        const maxY = layer.clientHeight - 40;
        win.el.style.left = `${Math.min(layer.clientWidth - 80, Math.max(-win.el.offsetWidth + 120, origX + dx))}px`;
        win.el.style.top = `${Math.min(maxY, Math.max(0, origY + dy))}px`;
        this.showSnapHint(ev);
      };

      const onUp = (ev: PointerEvent): void => {
        win.titlebar.removeEventListener('pointermove', onMove);
        win.titlebar.removeEventListener('pointerup', onUp);
        win.titlebar.removeEventListener('pointercancel', onUp);
        win.el.classList.remove('dragging');
        this.hideSnapHint();
        if (moved) this.applySnap(ev, win);
      };

      win.titlebar.addEventListener('pointermove', onMove);
      win.titlebar.addEventListener('pointerup', onUp);
      win.titlebar.addEventListener('pointercancel', onUp);
    });

    /* Double-clicking the title bar toggles maximise. */
    win.titlebar.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.win-btn, .titlebar__back')) return;
      if (this.mode === 'desktop') win.toggleMaximize();
    });
  }

  private snapZone(x: number, y: number): 'left' | 'right' | 'top' | null {
    const layer = this.windowLayer;
    const rect = layer.getBoundingClientRect();
    if (y - rect.top < EDGE) return 'top';
    if (x - rect.left < EDGE) return 'left';
    if (rect.right - x < EDGE) return 'right';
    return null;
  }

  private showSnapHint(e: PointerEvent): void {
    const zone = this.snapZone(e.clientX, e.clientY);
    if (!zone) { this.hideSnapHint(); return; }
    const layer = this.windowLayer;
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    const p = this.snapPreview;
    if (!p.isConnected) layer.appendChild(p);
    p.hidden = false;
    p.style.top = '0px';
    p.style.height = `${h}px`;
    if (zone === 'left') { p.style.left = '0px'; p.style.width = `${w / 2}px`; }
    else if (zone === 'right') { p.style.left = `${w / 2}px`; p.style.width = `${w / 2}px`; }
    else { p.style.left = '0px'; p.style.width = `${w}px`; }
  }

  private hideSnapHint(): void {
    this.snapPreview.hidden = true;
  }

  private applySnap(e: PointerEvent, win: LumeWindow): void {
    const zone = this.snapZone(e.clientX, e.clientY);
    if (!zone) return;
    const layer = this.windowLayer;
    const w = layer.clientWidth;
    const h = layer.clientHeight;

    win.el.classList.add('snapping');
    if (zone === 'top') {
      win.toggleMaximize();
    } else {
      if (win.maximized) win.toggleMaximize();
      win.el.style.top = '0px';
      win.el.style.height = `${h}px`;
      win.el.style.width = `${w / 2}px`;
      win.el.style.left = zone === 'left' ? '0px' : `${w / 2}px`;
    }
    setTimeout(() => win.el.classList.remove('snapping'), 220);
  }

  private wireResize(m: ManagedWindow): void {
    const win = m.win;
    win.el.querySelectorAll<HTMLElement>('.resize-handle').forEach((handle) => {
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (this.mode === 'mobile') return;
        e.preventDefault();
        e.stopPropagation();

        const dir = handle.dataset.resize ?? 'se';
        const startX = e.clientX;
        const startY = e.clientY;
        const w0 = win.el.offsetWidth;
        const h0 = win.el.offsetHeight;
        const l0 = win.el.offsetLeft;
        const t0 = win.el.offsetTop;

        handle.setPointerCapture(e.pointerId);

        const onMove = (ev: PointerEvent): void => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dir.includes('e')) win.el.style.width = `${Math.max(MIN_W, w0 + dx)}px`;
          if (dir.includes('s')) win.el.style.height = `${Math.max(MIN_H, h0 + dy)}px`;
          if (dir.includes('w')) {
            const nw = Math.max(MIN_W, w0 - dx);
            win.el.style.width = `${nw}px`;
            win.el.style.left = `${l0 + (w0 - nw)}px`;
          }
          if (dir.includes('n')) {
            const nh = Math.max(MIN_H, h0 - dy);
            win.el.style.height = `${nh}px`;
            win.el.style.top = `${t0 + (h0 - nh)}px`;
          }
        };
        const onUp = (): void => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    });
  }

  /* ================================================================== */
  /* Keyboard window management                                         */
  /* ================================================================== */
  private bindShortcuts(): void {
    if (this.shortcutsBound) return;
    this.shortcutsBound = true;

    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (this.mode !== 'desktop' || !this.activeId) return;

      const m = this.windows.get(this.activeId);
      if (!m) return;
      const win = m.win;
      const STEP = e.shiftKey ? 24 : 16;

      const nudge = (dx: number, dy: number): void => {
        win.el.style.left = `${win.el.offsetLeft + dx}px`;
        win.el.style.top = `${win.el.offsetTop + dy}px`;
      };

      switch (e.key) {
        case 'ArrowLeft':
          if (e.shiftKey) win.el.style.width = `${Math.max(MIN_W, win.el.offsetWidth - STEP)}px`;
          else nudge(-STEP, 0);
          break;
        case 'ArrowRight':
          if (e.shiftKey) win.el.style.width = `${win.el.offsetWidth + STEP}px`;
          else nudge(STEP, 0);
          break;
        case 'ArrowUp':
          if (e.shiftKey) win.el.style.height = `${Math.max(MIN_H, win.el.offsetHeight - STEP)}px`;
          else nudge(0, -STEP);
          break;
        case 'ArrowDown':
          if (e.shiftKey) win.el.style.height = `${win.el.offsetHeight + STEP}px`;
          else nudge(0, STEP);
          break;
        case 'q':
        case 'Q':
          this.close(this.activeId);
          break;
        case 'w':
        case 'W':
          win.toggleMaximize();
          break;
        case 'm':
        case 'M':
          win.minimize();
          this.focusTop();
          break;
        case 'Tab':
          this.focusNext(e.shiftKey ? -1 : 1);
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }
}
