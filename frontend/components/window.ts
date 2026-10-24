/*
 * LumeOS - components/window.ts
 * A single managed window: chrome, title bar, resize handles and body.
 * Interaction (drag / resize / snap) is wired by the WindowManager.
 */

import type { LumeWindowHandle } from '../desktop/types.js';

export interface WindowOptions {
  id: string;
  title: string;
  glyph?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
}

export class LumeWindow implements LumeWindowHandle {
  public readonly id: string;
  public readonly el: HTMLElement;
  public readonly body: HTMLElement;
  public readonly titlebar: HTMLElement;
  public minimized = false;
  public maximized = false;
  public resizable: boolean;

  private readonly titleEl: HTMLElement;
  private readonly opts: WindowOptions;
  private restoreGeom: { x: number; y: number; w: number; h: number } | null = null;

  constructor(opts: WindowOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.resizable = opts.resizable !== false;

    const el = document.createElement('div');
    el.className = 'window';
    el.dataset.windowId = opts.id;
    el.style.width = `${opts.width ?? 720}px`;
    el.style.height = `${opts.height ?? 480}px`;
    el.style.left = `${opts.x ?? 80}px`;
    el.style.top = `${opts.y ?? 60}px`;

    const titlebar = document.createElement('div');
    titlebar.className = 'titlebar';

    const glyph = document.createElement('span');
    glyph.className = 'titlebar__icon';
    glyph.textContent = opts.glyph ?? '▣';

    const title = document.createElement('span');
    title.className = 'titlebar__title';
    title.textContent = opts.title;

    const actions = document.createElement('div');
    actions.className = 'titlebar__actions';

    const minBtn = document.createElement('button');
    minBtn.className = 'win-btn';
    minBtn.title = 'Minimize';
    minBtn.textContent = '–';
    minBtn.onclick = (e) => {
      e.stopPropagation();
      this.minimize();
    };

    const maxBtn = document.createElement('button');
    maxBtn.className = 'win-btn';
    maxBtn.title = 'Maximize';
    maxBtn.textContent = '□';
    maxBtn.onclick = (e) => {
      e.stopPropagation();
      this.toggleMaximize();
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'win-btn close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      this.close();
    };

    actions.append(minBtn, maxBtn, closeBtn);
    titlebar.append(glyph, title, actions);

    const body = document.createElement('div');
    body.className = 'window__body';

    el.append(titlebar, body);

    if (this.resizable) {
      const se = document.createElement('div');
      se.className = 'resize-handle';
      se.dataset.resize = 'se';
      const e = document.createElement('div');
      e.className = 'resize-handle e';
      e.dataset.resize = 'e';
      const s = document.createElement('div');
      s.className = 'resize-handle s';
      s.dataset.resize = 's';
      el.append(se, e, s);
    }

    this.el = el;
    this.body = body;
    this.titlebar = titlebar;
    this.titleEl = title;
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title;
  }

  focus(): void {
    /* z-index handled by the WindowManager. */
  }

  minimize(): void {
    this.minimized = true;
    this.el.classList.add('minimized');
    this.opts.onMinimize?.();
  }

  restore(): void {
    this.minimized = false;
    this.el.classList.remove('minimized');
  }

  toggleMaximize(): void {
    const layer = this.el.parentElement;
    if (!layer) return;
    if (this.maximized) {
      this.maximized = false;
      this.el.classList.remove('maximized');
      if (this.restoreGeom) {
        this.el.style.left = `${this.restoreGeom.x}px`;
        this.el.style.top = `${this.restoreGeom.y}px`;
        this.el.style.width = `${this.restoreGeom.w}px`;
        this.el.style.height = `${this.restoreGeom.h}px`;
      }
    } else {
      this.restoreGeom = {
        x: this.el.offsetLeft,
        y: this.el.offsetTop,
        w: this.el.offsetWidth,
        h: this.el.offsetHeight,
      };
      this.maximized = true;
      this.el.classList.add('maximized');
    }
    this.opts.onMaximize?.();
  }

  close(): void {
    this.opts.onClose?.();
  }
}
