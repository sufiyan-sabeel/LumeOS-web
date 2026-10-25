/*
 * LumeOS - apps/ai-center/app.ts
 * Hardware capability detector plus an offline inference surface.
 *
 * This build ships a deterministic rule-based micro-model as the always-
 * available fallback. Neural weights (GGUF/ONNX) can be downloaded into
 * OPFS/models/ by the App Store, but executing them requires an inference
 * runtime that is not bundled here — the UI states this plainly rather than
 * pretending to run a model it cannot.
 */

import type { LumeApp, AppContext } from '../../desktop/types.js';
import { localFs } from '../../storage/local-fs.js';

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1,
  8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

interface Capabilities {
  webgpu: boolean;
  wasm: boolean;
  simd: boolean;
  threads: boolean;
  storageQuota: number;
  deviceMemoryGb: number | null;
}

async function detect(): Promise<Capabilities> {
  const nav = navigator as Navigator & {
    gpu?: unknown;
    deviceMemory?: number;
  };
  let storageQuota = 0;
  try {
    const est = await navigator.storage?.estimate?.();
    storageQuota = est?.quota ?? 0;
  } catch {
    storageQuota = 0;
  }
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  return {
    webgpu: typeof nav.gpu !== 'undefined',
    wasm: typeof WebAssembly !== 'undefined',
    simd,
    threads: typeof SharedArrayBuffer !== 'undefined',
    storageQuota,
    deviceMemoryGb: nav.deviceMemory ?? null,
  };
}

/** Deterministic offline micro-model (no weights, no network). */
function microModel(prompt: string): string {
  const p = prompt.trim().toLowerCase();
  if (!p) return 'Ask me something.';
  if (/^(hi|hello|hey|namaste)\b/.test(p)) return 'Hello! I am Lume, the offline micro-model running inside LumeOS.';
  if (p.includes('who are you') || p.includes('your name'))
    return 'I am Lume, a deterministic rule-based assistant bundled with LumeOS. I run entirely offline.';
  if (p.includes('time')) return `The current time is ${new Date().toLocaleString()}.`;
  if (p.includes('date')) return `Today is ${new Date().toDateString()}.`;
  if (p.includes('help') || p.includes('what can you do'))
    return 'I can answer simple questions, do arithmetic, tell the time, and explain LumeOS features. For real generative inference, download a model in the App Store — but note this build has no neural runtime.';
  if (p.includes('lumeos') || p.includes('os'))
    return 'LumeOS is a hybrid web-desktop OS: a C backend server plus a zero-framework TypeScript desktop, installable as a PWA with offline storage.';

  const math = p.match(/^[0-9+\-*/().\s%^]+$/);
  if (math) {
    try {
      const js = p.replace(/\^/g, '**').replace(/%/g, '/100');
      const result = Function(`"use strict";return (${js});`)() as number;
      if (typeof result === 'number' && isFinite(result)) return `${prompt.trim()} = ${result}`;
    } catch {
      /* fall through */
    }
  }

  const words = prompt.trim().split(/\s+/).length;
  return `I received ${words} word(s). As a rule-based micro-model I cannot reason about this generally. ` +
    `Install a neural model in the App Store for richer responses (runtime required).`;
}

export const aiCenterApp: LumeApp = {
  manifest: {
    id: 'ai-center',
    name: 'AI Center',
    icon: 'sparkles',
    description: 'Detect AI capabilities and run local prompts offline.',
    category: 'ai',
    type: 'builtin',
    width: 720,
    height: 600,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const app = el('div', 'app');
    const toolbar = el('div', 'app__toolbar');
    const content = el('div', 'app__content');

    const refresh = el('button', undefined, '⟳ Re-scan hardware') as HTMLButtonElement;
    toolbar.append(refresh);

    const capGrid = el('div', 'cap-grid');
    const modelsBox = el('div');
    const chat = el('div', 'ai-chat');
    const log = el('div', 'ai-log');
    const inputRow = el('div', 'ai-input');
    const input = el('input') as HTMLInputElement;
    input.placeholder = 'Ask the offline micro-model…';
    const send = el('button', 'primary', 'Send') as HTMLButtonElement;
    inputRow.append(input, send);
    chat.append(log, inputRow);

    content.append(capGrid, modelsBox, chat);
    app.append(toolbar, content);
    ctx.window.body.appendChild(app);

    const badge = (ok: boolean): HTMLElement => {
      const b = el('span', `badge ${ok ? 'badge--ok' : 'badge--off'}`, ok ? 'yes' : 'no');
      return b;
    };

    const scan = async (): Promise<void> => {
      capGrid.innerHTML = '';
      const caps = await detect();
      const items: Array<[string, boolean]> = [
        ['WebGPU', caps.webgpu],
        ['WebAssembly', caps.wasm],
        ['WASM SIMD', caps.simd],
        ['WASM threads', caps.threads],
      ];
      for (const [label, ok] of items) {
        const c = el('div', 'cap');
        c.append(el('span', undefined, label), badge(ok));
        capGrid.appendChild(c);
      }
      const storage = el('div', 'cap');
      storage.append(
        el('span', undefined, 'Storage quota'),
        el('span', 'badge', `${(caps.storageQuota / 1024 / 1024 / 1024).toFixed(1)} GB`)
      );
      capGrid.appendChild(storage);

      /* Discover downloaded models in OPFS. */
      modelsBox.innerHTML = '';
      modelsBox.appendChild(el('h3', 'muted', 'Downloaded models (OPFS/models)'));
      try {
        const models = await localFs.list('/models');
        if (models.length === 0) {
          modelsBox.appendChild(
            el('p', 'muted', 'No models downloaded. Use App Store → AI models.')
          );
        } else {
          for (const m of models) {
            const row = el('div', 'settings__row');
            row.append(
              el('label', undefined, `${m.name} (${m.type})`),
              el('span', 'badge badge--warn', 'runtime required')
            );
            modelsBox.appendChild(row);
          }
        }
      } catch (e) {
        /* A missing /models folder is the normal case, not a failure. */
        const name = (e as { name?: string } | null)?.name ?? '';
        modelsBox.appendChild(
          el('p', 'muted', name === 'NotFoundError'
            ? 'No models downloaded yet. Use App Store → AI models.'
            : `Could not read local storage: ${(e as Error).message}`)
        );
      }
    };

    const addMsg = (text: string, who: 'user' | 'bot'): void => {
      log.appendChild(el('div', `msg ${who}`, text));
      log.scrollTop = log.scrollHeight;
    };

    const respond = (): void => {
      const q = input.value;
      if (!q.trim()) return;
      input.value = '';
      addMsg(q, 'user');
      /* Simulate a small think delay for UX; inference is local + instant. */
      setTimeout(() => addMsg(microModel(q), 'bot'), 120);
    };

    send.onclick = respond;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') respond();
    });
    refresh.onclick = () => void scan();

    addMsg('Lume offline micro-model ready. This build runs a deterministic rule-based model; no neural runtime is bundled.', 'bot');
    void scan();
  },
};
