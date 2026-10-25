/*
 * LumeOS - components/icons.ts
 * A small, dependency-free Lucide-style icon set.
 *
 * Icons are 24x24, stroke-based, and inherit `currentColor`, so they adapt to
 * text colour and theme automatically. Emoji are deliberately not used for
 * interface icons: they render inconsistently across platforms and cannot be
 * styled or aligned reliably.
 *
 * Usage:
 *   icons.mount(el, 'folder')          // append an <svg>
 *   icons.html('folder', 20)           // markup string
 *   icons.el('folder', 20)             // detached <svg>
 */

type Prim =
  | { t: 'p'; d: string }
  | { t: 'c'; cx: number; cy: number; r: number }
  | { t: 'r'; x: number; y: number; w: number; h: number; rx?: number }
  | { t: 'l'; x1: number; y1: number; x2: number; y2: number };

/* eslint-disable @typescript-eslint/no-unused-vars */
const P = (d: string): Prim => ({ t: 'p', d });
const C = (cx: number, cy: number, r: number): Prim => ({ t: 'c', cx, cy, r });
const R = (x: number, y: number, w: number, h: number, rx = 0): Prim => ({ t: 'r', x, y, w, h, rx });
const L = (x1: number, y1: number, x2: number, y2: number): Prim => ({ t: 'l', x1, y1, x2, y2 });

const ICONS: Record<string, Prim[]> = {
  /* ---- applications ---- */
  folder: [P('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z')],
  terminal: [P('m4 17 6-6-6-6'), P('M12 19h8')],
  notes: [
    P('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'),
    P('M14 2v5h5'), P('M9 13h6'), P('M9 17h4'),
  ],
  calculator: [
    R(4, 2, 16, 20, 2), P('M8 6h8'), P('M8 11h.01'), P('M12 11h.01'),
    P('M16 11h.01'), P('M8 15h.01'), P('M12 15h.01'), P('M16 15h.01'),
    P('M8 19h.01'), P('M12 19h.01'), P('M16 19h.01'),
  ],
  settings: [
    P('M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z'),
    C(12, 12, 3),
  ],
  store: [
    P('M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z'),
    P('M3 6h18'), P('M16 10a4 4 0 0 1-8 0'),
  ],
  download: [P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), P('m7 10 5 5 5-5'), P('M12 15V3')],
  sparkles: [
    P('m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z'),
    P('M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z'),
    P('M5 16l.7 1.6L7.3 18l-1.6.7L5 20.3l-.7-1.6L2.7 18l1.6-.4Z'),
  ],
  globe: [C(12, 12, 10), P('M2 12h20'), P('M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20')],

  /* ---- window controls ---- */
  minimize: [P('M5 12h14')],
  maximize: [R(5, 5, 14, 14, 1)],
  restore: [R(8, 8, 12, 12, 1), P('M4 16V6a2 2 0 0 1 2-2h10')],
  close: [P('M18 6 6 18'), P('m6 6 12 12')],

  /* ---- navigation ---- */
  back: [P('M19 12H5'), P('m12 19-7-7 7-7')],
  chevronLeft: [P('m15 18-6-6 6-6')],
  chevronRight: [P('m9 18 6-6-6-6')],
  chevronDown: [P('m6 9 6 6 6-6')],
  home: [P('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z')],
  layers: [P('m12 2 9 5-9 5-9-5Z'), P('m3 12 9 5 9-5'), P('m3 17 9 5 9-5')],
  grid: [R(3, 3, 7, 7, 1), R(14, 3, 7, 7, 1), R(3, 14, 7, 7, 1), R(14, 14, 7, 7, 1)],
  more: [C(12, 5, 1), C(12, 12, 1), C(12, 19, 1)],
  up: [P('M12 19V5'), P('m5 12 7-7 7 7')],

  /* ---- actions ---- */
  search: [C(11, 11, 7), P('m21 21-4.3-4.3')],
  plus: [P('M12 5v14'), P('M5 12h14')],
  trash: [
    P('M3 6h18'), P('M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2'),
    P('M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'),
  ],
  refresh: [P('M21 12a9 9 0 1 1-3-6.7'), P('M21 3v6h-6')],
  folderPlus: [
    P('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'),
    P('M12 11v6'), P('M9 14h6'),
  ],
  save: [
    P('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z'),
    P('M17 21v-8H7v8'), P('M7 3v5h8'),
  ],
  file: [P('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'), P('M14 2v5h5')],
  play: [P('m5 3 14 9-14 9Z')],
  pause: [R(6, 4, 4, 16, 1), R(14, 4, 4, 16, 1)],
  external: [P('M15 3h6v6'), P('M10 14 21 3'), P('M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5')],

  /* ---- status ---- */
  check: [P('M20 6 9 17l-5-5')],
  checkCircle: [C(12, 12, 10), P('m9 12 2 2 4-4')],
  info: [C(12, 12, 10), P('M12 16v-5'), P('M12 8h.01')],
  alert: [
    P('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'),
    P('M12 9v4'), P('M12 17h.01'),
  ],
  xCircle: [C(12, 12, 10), P('m15 9-6 6'), P('m9 9 6 6')],
  loader: [P('M21 12a9 9 0 1 1-6.2-8.6')],
  cloudOff: [P('m2 2 20 20'), P('M5.8 5.8A7 7 0 0 0 4 11a6 6 0 0 0 2.4 11h11a6 6 0 0 0 4-10.7')],
  cloud: [P('M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6.5 19Z')],
  clock: [C(12, 12, 10), P('M12 7v5l3 2')],
  bell: [P('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'), P('M10.3 21a1.94 1.94 0 0 0 3.4 0')],
  monitor: [R(2, 3, 20, 14, 2), P('M8 21h8'), P('M12 17v4')],
  smartphone: [R(5, 2, 14, 20, 2), P('M12 18h.01')],
  sun: [C(12, 12, 4), P('M12 2v2'), P('M12 20v2'), P('M2 12h2'), P('M20 12h2'),
    P('m4.9 4.9 1.4 1.4'), P('m17.7 17.7 1.4 1.4'), P('m19.1 4.9-1.4 1.4'), P('m6.3 17.7-1.4 1.4')],
  moon: [P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z')],
  palette: [P('M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2 2 2 0 0 1 2-2h2a4 4 0 0 0 4-4 10 10 0 0 0-10-10Z'),
    C(8, 9, 1), C(12, 7, 1), C(16, 9, 1)],
  image: [R(3, 3, 18, 18, 2), C(9, 9, 2), P('m21 15-5-5L5 21')],
  drive: [P('M22 12H2'), P('M5.5 5h13l3.5 7v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5Z'),
    P('M6 16h.01'), P('M10 16h.01')],
  activity: [P('M22 12h-4l-3 9L9 3l-3 9H2')],
  list: [P('M8 6h13'), P('M8 12h13'), P('M8 18h13'), P('M3 6h.01'), P('M3 12h.01'), P('M3 18h.01')],
  power: [P('M12 2v10'), P('M18.4 6.6a9 9 0 1 1-12.8 0')],
};

export type IconName = keyof typeof ICONS | (string & {});

const SVG_NS = 'http://www.w3.org/2000/svg';

function render(name: string, size: number, cls: string): SVGSVGElement {
  const prims = ICONS[name] ?? ICONS.file;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('lume-icon');
  if (cls) svg.classList.add(...cls.split(' ').filter(Boolean));

  for (const p of prims) {
    let node: SVGElement;
    if (p.t === 'p') {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', p.d);
    } else if (p.t === 'c') {
      node = document.createElementNS(SVG_NS, 'circle');
      node.setAttribute('cx', String(p.cx));
      node.setAttribute('cy', String(p.cy));
      node.setAttribute('r', String(p.r));
    } else if (p.t === 'r') {
      node = document.createElementNS(SVG_NS, 'rect');
      node.setAttribute('x', String(p.x));
      node.setAttribute('y', String(p.y));
      node.setAttribute('width', String(p.w));
      node.setAttribute('height', String(p.h));
      if (p.rx) node.setAttribute('rx', String(p.rx));
    } else {
      node = document.createElementNS(SVG_NS, 'line');
      node.setAttribute('x1', String(p.x1));
      node.setAttribute('y1', String(p.y1));
      node.setAttribute('x2', String(p.x2));
      node.setAttribute('y2', String(p.y2));
    }
    svg.appendChild(node);
  }
  return svg;
}

/** Detached <svg> element for the given icon. */
export function iconEl(name: IconName, size = 18, cls = ''): SVGSVGElement {
  return render(name, size, cls);
}

/** Append an icon to `parent` and return it. */
export function mountIcon(parent: HTMLElement, name: IconName, size = 18, cls = ''): SVGSVGElement {
  const svg = render(name, size, cls);
  parent.appendChild(svg);
  return svg;
}

/** Markup string, for the few places that build innerHTML. */
export function iconHtml(name: IconName, size = 18, cls = ''): string {
  const svg = render(name, size, cls);
  return svg.outerHTML;
}

export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

export const iconNames = Object.keys(ICONS);
