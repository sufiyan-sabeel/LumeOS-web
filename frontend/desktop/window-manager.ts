/*
 * LumeOS - desktop/window-manager.ts
 * Window lifecycle, focus stacking, dragging, resizing and edge snapping.
 */

import { LumeWindow, type WindowOptions } from '../components/window.js';
import type { AppManifest, LumeWindowHandle } from './types.js';
import { bus } from './events.js';

interface ManagedWindow {
  win: LumeWindow;
  appId: string;
  manifest: AppManifest;
  unmount?: () => void;
  taskButton: HTMLButtonElement;
}

const TASKBAR_HEIGHT = 52;

export class WindowManager {
  private windows = new Map<string, ManagedWindow>();
  private zCounter = 100;
  private cascade = 0;
  private layer: HTMLElement;
  private tasksEl: HTMLElement;
  private snapPreview: HTMLElement;

  constructor() {
    this.layer = document.getElementById('window-layer') as HTMLElement;
    this.tasksEl = document.getElementById('tb-tasks') as HTMLElement;

    const preview = document.createElement('div');
    preview.className = 'snap-preview';
    preview.hidden = true;
    this.layer.appendChild(preview);
    this.snapPreview = preview;
  }

  count(): number {
    return this.windows.size;
  }

  list(): LumeWindowHandle[] {
    return Array.from(this.windows.values()).map((m) => m.win);
  }

  findByApp(appId: string): ManagedWindow | undefined {
    for (const m of this.windows.values()) {
      if (m.appId === appId) return m;
    }
    return undefined;
  }

  create(
    appId: string,
    manifest: AppManifest,
    mount: (win: LumeWindowHandle) => void | Promise<void>,
    unmount?: () => void,
    args: Record<string, unknown> = {}
  ): LumeWindow {
    void args;
    const id = `win-${appId}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

    const offset = (this.cascade % 6) * 28;
    this.cascade++;

    const geom: WindowOptions = {
      id,
      title: manifest.name,
      glyph: manifest.glyph,
      width: manifest.width ?? 760,
      height: manifest.height ?? 500,
      x: 72 + offset,
      y: 56 + offset,
      onClose: () => this.close(id),
      onMinimize: () => {
        this.updateTaskbar();
        this.focusTop();
      },
      onMaximize: () => this.updateTaskbar(),
    };

    const win = new LumeWindow(geom);
    this.layer.appendChild(win.el);

    const taskButton = document.createElement('button');
    taskButton.className = 'tb-task';
    taskButton.innerHTML = `<span>${manifest.glyph}</span><span class="tb-task__label"></span>`;
    (taskButton.querySelector('.tb-task__label') as HTMLElement).textContent = manifest.name;
    taskButton.onclick = () => {
      const m = this.windows.get(id);
      if (!m) return;
      if (m.win.minimized) {
        m.win.restore();
        this.focus(id);
      } else if (m.win.el.style.zIndex === String(this.zCounter)) {
        m.win.minimize();
      } else {
        this.focus(id);
      }
      this.updateTaskbar();
    };
    this.tasksEl.appendChild(taskButton);

    const managed: ManagedWindow = { win, appId, manifest, unmount, taskButton };
    this.windows.set(id, managed);

    /* interaction */
    win.el.addEventListener('pointerdown', () => this.focus(id), true);
    this.wireDrag(managed);
    if (win.resizable) this.wireResize(managed);

    this.focus(id);
    void mount(win);
    this.updateTaskbar();
    bus.emit('app:opened', { id: appId, windowId: id });

    return win;
  }

  /* ---------------- focus & stacking ---------------- */
  private focus(id: string): void {
    const m = this.windows.get(id);
    if (!m) return;
    m.win.el.style.zIndex = String(++this.zCounter);
    for (const other of this.windows.values())
      other.win.el.classList.toggle('focused', other === m);
    this.updateTaskbar();
    bus.emit('window:focused', { windowId: id });
  }

  private focusTop(): void {
    let top: ManagedWindow | null = null;
    let topZ = -1;
    for (const m of this.windows.values()) {
      if (m.win.minimized) continue;
      const z = parseInt(m.win.el.style.zIndex || '0', 10);
      if (z > topZ) {
        topZ = z;
        top = m;
      }
    }
    if (top) this.focus(top.win.id);
  }

  close(id: string): void {
    const m = this.windows.get(id);
    if (!m) return;
    m.unmount?.();
    m.win.el.remove();
    m.taskButton.remove();
    this.windows.delete(id);
    this.updateTaskbar();
    this.focusTop();
    bus.emit('app:closed', { id: m.appId, windowId: id });
    bus.emit('window:closed', { windowId: id });
  }

  closeByApp(appId: string): void {
    const m = this.findByApp(appId);
    if (m) this.close(m.win.id);
  }

  private updateTaskbar(): void {
    const active = Array.from(this.windows.values()).find(
      (m) => !m.win.minimized && m.win.el.style.zIndex === String(this.zCounter)
    );
    for (const m of this.windows.values()) {
      m.taskButton.classList.toggle('active', m === active);
    }
  }

  /* ---------------- drag & snap ---------------- */
  private wireDrag(m: ManagedWindow): void {
    const win = m.win;
    const titlebar = win.titlebar;

    titlebar.addEventListener('pointerdown', (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.win-btn')) return;
      if (e.button !== 0) return;

      if (win.maximized) {
        /* dragging a maximized window restores it under the cursor */
        win.toggleMaximize();
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const origX = win.el.offsetLeft;
      const origY = win.el.offsetTop;

      titlebar.setPointerCapture(e.pointerId);
      win.el.classList.add('dragging');

      const onMove = (ev: PointerEvent): void => {
        const nx = origX + (ev.clientX - startX);
        const ny = origY + (ev.clientY - startY);
        const maxY = window.innerHeight - TASKBAR_HEIGHT - 40;
        win.el.style.left = `${Math.max(-win.el.offsetWidth + 120, nx)}px`;
        win.el.style.top = `${Math.min(maxY, Math.max(0, ny))}px`;
        this.showSnapHint(ev);
      };

      const onUp = (ev: PointerEvent): void => {
        titlebar.removeEventListener('pointermove', onMove);
        titlebar.removeEventListener('pointerup', onUp);
        win.el.classList.remove('dragging');
        this.hideSnapHint();
        this.applySnap(ev, win);
      };

      titlebar.addEventListener('pointermove', onMove);
      titlebar.addEventListener('pointerup', onUp);
    });
  }

  private showSnapHint(e: PointerEvent): void {
    const zone = this.snapZone(e.clientX, e.clientY);
    if (!zone) {
      this.snapPreview.hidden = true;
      return;
    }
    const layerW = this.layer.clientWidth;
    const layerH = this.layer.clientHeight;
    const p = this.snapPreview;
    p.hidden = false;
    p.style.top = '0px';
    p.style.height = `${layerH}px`;
    if (zone === 'left') {
      p.style.left = '0px';
      p.style.width = `${layerW / 2}px`;
    } else if (zone === 'right') {
      p.style.left = `${layerW / 2}px`;
      p.style.width = `${layerW / 2}px`;
    } else {
      p.style.left = '0px';
      p.style.width = `${layerW}px`;
    }
  }

  private hideSnapHint(): void {
    this.snapPreview.hidden = true;
  }

  private snapZone(x: number, y: number): 'left' | 'right' | 'top' | null {
    if (y < 8) return 'top';
    if (x < 8) return 'left';
    if (x > window.innerWidth - 8) return 'right';
    return null;
  }

  private applySnap(e: PointerEvent, win: LumeWindow): void {
    const zone = this.snapZone(e.clientX, e.clientY);
    if (!zone) return;
    const layerW = this.layer.clientWidth;
    const layerH = this.layer.clientHeight;

    win.el.classList.add('snapped');
    if (zone === 'top') {
      win.toggleMaximize();
    } else if (zone === 'left') {
      win.el.style.left = '0px';
      win.el.style.top = '0px';
      win.el.style.width = `${layerW / 2}px`;
      win.el.style.height = `${layerH}px`;
    } else {
      win.el.style.left = `${layerW / 2}px`;
      win.el.style.top = '0px';
      win.el.style.width = `${layerW / 2}px`;
      win.el.style.height = `${layerH}px`;
    }
    setTimeout(() => win.el.classList.remove('snapped'), 200);
  }

  /* ---------------- resize ---------------- */
  private wireResize(m: ManagedWindow): void {
    const win = m.win;
    win.el.querySelectorAll<HTMLElement>('.resize-handle').forEach((handle) => {
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const dir = handle.dataset.resize ?? 'se';
        const startX = e.clientX;
        const startY = e.clientY;
        const w0 = win.el.offsetWidth;
        const h0 = win.el.offsetHeight;

        handle.setPointerCapture(e.pointerId);
        const onMove = (ev: PointerEvent): void => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dir.includes('e')) win.el.style.width = `${Math.max(320, w0 + dx)}px`;
          if (dir.includes('s')) win.el.style.height = `${Math.max(200, h0 + dy)}px`;
        };
        const onUp = (): void => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });
    });
  }
}
