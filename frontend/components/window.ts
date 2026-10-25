/*
 * LumeOS - components/window.ts
 * The application frame: title bar, controls, body and resize handles.
 *
 * The same element is used for a desktop window and a mobile app view —
 * only the shell mode changes how CSS presents it — so application state
 * survives switching between desktop and mobile layouts.
 */

import type { LumeWindowHandle } from '../desktop/types.js';
import { iconEl, mountIcon } from './icons.js';

export interface WindowOptions {
  id: string;
  title: string;
  /** Icon name from components/icons.ts. */
  icon?: string;
  /** Legacy/third-party packages may supply an emoji glyph instead. */
  glyph?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onBack?: () => void;
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
  private readonly iconEl: HTMLElement;
  private readonly opts: WindowOptions;
  private restoreGeom: { x: number; y: number; w: number; h: number } | null = null;

  constructor(opts: WindowOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.resizable = opts.resizable !== false;

    const el = document.createElement('div');
    el.className = 'window';
    el.dataset.windowId = opts.id;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', opts.title);
    el.tabIndex = -1;
    el.style.width = `${opts.width ?? 760}px`;
    el.style.height = `${opts.height ?? 500}px`;
    el.style.left = `${opts.x ?? 90}px`;
    el.style.top = `${opts.y ?? 70}px`;

    /* ---- title bar ---- */
    const titlebar = document.createElement('div');
    titlebar.className = 'titlebar';

    const back = document.createElement('button');
    back.className = 'titlebar__back';
    back.type = 'button';
    back.title = 'Back';
    back.setAttribute('aria-label', 'Back');
    back.appendChild(iconEl('back', 20));
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onBack?.();
    });

    const icon = document.createElement('span');
    icon.className = 'titlebar__icon';

    const title = document.createElement('span');
    title.className = 'titlebar__title';
    title.textContent = opts.title;

    const actions = document.createElement('div');
    actions.className = 'titlebar__actions';

    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'win-btn min';
    minBtn.title = 'Minimise';
    minBtn.setAttribute('aria-label', 'Minimise');
    minBtn.appendChild(iconEl('minimize', 15));
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.minimize();
    });

    const maxBtn = document.createElement('button');
    maxBtn.type = 'button';
    maxBtn.className = 'win-btn max';
    maxBtn.title = 'Maximise';
    maxBtn.setAttribute('aria-label', 'Maximise');
    maxBtn.appendChild(iconEl('maximize', 13));
    maxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMaximize();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'win-btn close';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.appendChild(iconEl('close', 16));
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });

    actions.append(minBtn, maxBtn, closeBtn);
    titlebar.append(back, icon, title, actions);

    /* ---- body ---- */
    const body = document.createElement('div');
    body.className = 'window__body';

    el.append(titlebar, body);

    if (this.resizable) {
      for (const dir of ['se', 'e', 's', 'w', 'n'] as const) {
        const h = document.createElement('div');
        h.className = `resize-handle ${dir}`;
        h.dataset.resize = dir;
        el.appendChild(h);
      }
    }

    this.el = el;
    this.body = body;
    this.titlebar = titlebar;
    this.titleEl = title;
    this.iconEl = icon;
    this.setIcon(opts.icon, opts.glyph);
  }

  setIcon(icon?: string, glyph?: string): void {
    this.iconEl.replaceChildren();
    if (icon) {
      mountIcon(this.iconEl, icon, 16);
    } else if (glyph) {
      this.iconEl.textContent = glyph;
    }
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title;
    this.el.setAttribute('aria-label', title);
  }

  focus(): void {
    /* stacking is owned by the WindowManager */
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

  /** Mobile shells show exactly one application view at a time. */
  setMobileActive(active: boolean): void {
    this.el.classList.toggle('mobile-active', active);
  }

  close(): void {
    this.opts.onClose?.();
  }
}
