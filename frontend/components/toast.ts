/*
 * LumeOS - components/toast.ts
 * Non-blocking desktop notifications.
 */

export type ToastKind = 'info' | 'success' | 'error';

export function toast(title: string, body = '', kind: ToastKind = 'info'): void {
  const layer = document.getElementById('toast-layer');
  if (!layer) return;

  const el = document.createElement('div');
  el.className = `toast${kind !== 'info' ? ` toast--${kind}` : ''}`;

  const t = document.createElement('div');
  t.className = 'toast__title';
  t.textContent = title;
  el.appendChild(t);

  if (body) {
    const b = document.createElement('div');
    b.className = 'toast__body';
    b.textContent = body;
    el.appendChild(b);
  }

  layer.appendChild(el);
  const ttl = kind === 'error' ? 6000 : 3800;
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'all 200ms ease';
    setTimeout(() => el.remove(), 220);
  }, ttl);
}
