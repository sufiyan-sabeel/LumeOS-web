/*
 * LumeOS - desktop/mobile.ts
 * The mobile shell: home screen, bottom navigation and the recents
 * (app switcher) sheet.
 *
 * This is a deliberate phone interface, not a squeezed desktop: one
 * application is shown full-screen at a time, navigation lives at the
 * bottom within thumb reach, and the hardware/browser back action is
 * wired through the History API.
 */

import type { AppManifest } from './types.js';
import type { DesktopHost } from './desktop.js';
import { iconEl, mountIcon } from '../components/icons.js';

export class MobileShell {
  private home: HTMLElement;
  private nav: HTMLElement;
  private recents: HTMLElement | null = null;
  private homeVisible = true;
  private historyDepth = 0;

  constructor(private host: DesktopHost) {
    this.home = document.getElementById('mobile-home') as HTMLElement;
    this.nav = document.getElementById('mobile-nav') as HTMLElement;
  }

  mount(): void {
    this.buildNav();
    this.renderHome();
    this.showHome();

    window.addEventListener('popstate', () => this.onBack());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.recents) this.closeRecents();
    });
  }

  /**
   * Called by the kernel whenever windows open, close, focus or the shell
   * mode changes. The home screen is only managed while in mobile mode, so
   * opening an app on the desktop never leaves the home screen hidden when
   * the user later switches to a phone layout.
   */
  sync(): void {
    if (this.host.shellMode() !== 'mobile') return;
    const active = this.host.activeWindowId();
    this.homeVisible = !active;
    this.home.hidden = !!active;
    this.updateNav();
  }

  /* ================================================================== */
  /* Home screen                                                        */
  /* ================================================================== */
  renderHome(): void {
    this.home.replaceChildren();

    const greeting = document.createElement('div');
    greeting.className = 'mobile-home__greeting';
    const clock = document.createElement('div');
    clock.className = 'mobile-home__clock';
    const date = document.createElement('div');
    date.className = 'mobile-home__date';

    const tick = (): void => {
      const d = new Date();
      clock.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      date.textContent = d.toLocaleDateString([], {
        weekday: 'long', day: 'numeric', month: 'long',
      });
    };
    tick();
    setInterval(tick, 20000);
    greeting.append(clock, date);

    const heading = document.createElement('h2');
    heading.className = 'mobile-home__section';
    heading.textContent = 'Applications';

    const grid = document.createElement('div');
    grid.className = 'mobile-home__grid';
    for (const m of this.host.manifests()) {
      grid.appendChild(this.appTile(m));
    }

    this.home.append(greeting, heading, grid);
  }

  private appTile(m: AppManifest): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-app';
    btn.setAttribute('aria-label', `Open ${m.name}`);

    const glyph = document.createElement('div');
    glyph.className = 'mobile-app__glyph';
    if (m.icon) mountIcon(glyph, m.icon, 24);
    else if (m.glyph) glyph.textContent = m.glyph;
    else mountIcon(glyph, 'file', 24);

    const label = document.createElement('div');
    label.className = 'mobile-app__label';
    label.textContent = m.name;

    btn.append(glyph, label);
    btn.addEventListener('click', () => this.host.launch(m.id));
    return btn;
  }

  /* ================================================================== */
  /* Bottom navigation                                                  */
  /* ================================================================== */
  private buildNav(): void {
    this.nav.replaceChildren();

    const mk = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mobile-nav__btn';
      b.appendChild(iconEl(icon, 20));
      const span = document.createElement('span');
      span.textContent = label;
      b.appendChild(span);
      b.addEventListener('click', onClick);
      return b;
    };

    const back = mk('back', 'Back', () => this.onBack());
    back.setAttribute('aria-label', 'Back');

    const home = mk('home', 'Home', () => this.showHome());
    home.setAttribute('aria-label', 'Home');

    const apps = mk('grid', 'Apps', () => {
      this.host.launch('app-store');
    });
    apps.setAttribute('aria-label', 'App Store');

    const recents = mk('layers', 'Recents', () => this.toggleRecents());
    recents.setAttribute('aria-label', 'Recent applications');

    this.nav.append(back, home, apps, recents);
    this.updateNav();
  }

  private updateNav(): void {
    const buttons = Array.from(this.nav.querySelectorAll<HTMLButtonElement>('.mobile-nav__btn'));
    const backBtn = buttons[0];
    const homeBtn = buttons[1];
    if (backBtn) backBtn.disabled = this.homeVisible;
    if (homeBtn) homeBtn.setAttribute('aria-current', String(this.homeVisible));
  }

  /* ================================================================== */
  /* Navigation                                                         */
  /* ================================================================== */
  showHome(): void {
    this.homeVisible = true;
    this.home.hidden = false;
    this.closeRecents();
    this.host.blurWindows?.();
    this.updateNav();
  }

  /** Handle the browser/device back action. */
  private onBack(): void {
    if (this.recents) {
      this.closeRecents();
      return;
    }
    if (!this.homeVisible) {
      /* Returning to the home screen is the back action from an app. */
      this.historyDepth = Math.max(0, this.historyDepth - 1);
      this.showHome();
      return;
    }
    /* Already home: let the browser leave LumeOS. */
    history.back();
  }

  /** Called by the kernel when an app is opened on mobile. */
  notifyAppOpened(): void {
    this.homeVisible = false;
    this.home.hidden = true;
    this.updateNav();
  }

  /* ================================================================== */
  /* Recents / app switcher                                             */
  /* ================================================================== */
  toggleRecents(): void {
    if (this.recents) this.closeRecents();
    else this.openRecents();
  }

  openRecents(): void {
    this.closeRecents();
    const entries = this.host.windows();

    const sheet = document.createElement('div');
    sheet.className = 'recents-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Recent applications');

    const panel = document.createElement('div');
    panel.className = 'recents-sheet__panel';

    const title = document.createElement('h2');
    title.className = 'side-panel__section-title';
    title.textContent = entries.length ? 'Recent applications' : 'No recent applications';
    panel.appendChild(title);

    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'recents-item';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'recents-item';
      openBtn.style.cssText = 'flex:1;background:transparent;border:none;padding:0;min-height:0';
      if (e.manifest.icon) mountIcon(openBtn, e.manifest.icon, 20);
      else if (e.manifest.glyph) openBtn.textContent = e.manifest.glyph;
      else mountIcon(openBtn, 'file', 20);
      const label = document.createElement('span');
      label.className = 'recents-item__title';
      label.textContent = e.manifest.name;
      openBtn.appendChild(label);
      openBtn.addEventListener('click', () => {
        this.closeRecents();
        this.host.focusWindow(e.id);
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'icon-btn';
      closeBtn.title = 'Close';
      closeBtn.setAttribute('aria-label', `Close ${e.manifest.name}`);
      closeBtn.appendChild(iconEl('close', 16));
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.host.closeWindow(e.id);
        this.closeRecents();
      });

      row.append(openBtn, closeBtn);
      panel.appendChild(row);
    }

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'state';
      empty.appendChild(iconEl('layers', 22, 'state__icon'));
      const t = document.createElement('div');
      t.className = 'state__title';
      t.textContent = 'Nothing running';
      const b = document.createElement('div');
      b.className = 'state__body';
      b.textContent = 'Applications you open will appear here.';
      empty.append(t, b);
      panel.appendChild(empty);
    }

    sheet.appendChild(panel);
    sheet.addEventListener('pointerdown', (e) => {
      if (e.target === sheet) this.closeRecents();
    });
    (document.querySelector('.workspace') as HTMLElement).appendChild(sheet);
    this.recents = sheet;
  }

  closeRecents(): void {
    this.recents?.remove();
    this.recents = null;
  }

  isHomeVisible(): boolean {
    return this.homeVisible;
  }

  /** Push a history entry so the device back button returns home first. */
  pushHistory(): void {
    if (this.historyDepth > 0) return;
    try {
      history.pushState({ lume: 'app' }, '');
      this.historyDepth = 1;
    } catch {
      /* History API unavailable (sandboxed frame): the Back button still works. */
    }
  }

  resetHistory(): void {
    this.historyDepth = 0;
  }
}
