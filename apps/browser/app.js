/*
 * LumeOS - apps/browser/app.ts
 * Embedded viewer for local VFS documents and external URLs.
 *
 * Honest about its limits: a browser page cannot embed sites that send
 * X-Frame-Options / frame-ancestors, and it cannot inspect cross-origin
 * frames. Local documents are rendered from a blob URL; external URLs are
 * attempted in a sandboxed frame with a one-click escape to a real tab.
 */
import { iconEl } from '../../components/icons.js';
function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls)
        n.className = cls;
    if (text !== undefined)
        n.textContent = text;
    return n;
}
export const browserApp = {
    manifest: {
        id: 'browser',
        name: 'Browser',
        icon: 'globe',
        description: 'View local documents and external pages where the site allows embedding.',
        category: 'media',
        type: 'builtin',
        width: 960,
        height: 640,
        onDesktop: true,
    },
    mount(ctx) {
        const app = el('div', 'app');
        const toolbar = el('div', 'app__toolbar');
        const back = el('button', 'icon-btn');
        back.type = 'button';
        back.title = 'Back';
        back.setAttribute('aria-label', 'Back');
        back.appendChild(iconEl('back', 16));
        const reload = el('button', 'icon-btn');
        reload.type = 'button';
        reload.title = 'Reload';
        reload.setAttribute('aria-label', 'Reload');
        reload.appendChild(iconEl('refresh', 16));
        const omni = el('input', 'browser__omni');
        omni.type = 'text';
        omni.placeholder = 'Local path (/notes/…) or https://…';
        omni.setAttribute('aria-label', 'Address');
        omni.value = ctx.args.url ?? '/';
        const go = el('button', 'primary', 'Go');
        go.type = 'button';
        const external = el('button', 'icon-btn');
        external.type = 'button';
        external.title = 'Open in a new browser tab';
        external.setAttribute('aria-label', 'Open in a new tab');
        external.appendChild(iconEl('external', 16));
        toolbar.append(back, reload, omni, go, external);
        const notice = el('div', 'browser__notice');
        notice.appendChild(iconEl('info', 14));
        const noticeText = el('span');
        notice.appendChild(noticeText);
        const frame = el('iframe', 'browser__frame');
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
        frame.title = 'Page content';
        const status = el('div', 'app__status');
        app.append(toolbar, notice, frame, status);
        ctx.window.body.appendChild(app);
        const history = [];
        let blobUrl = null;
        let current = '';
        const releaseBlob = () => {
            if (blobUrl) {
                URL.revokeObjectURL(blobUrl);
                blobUrl = null;
            }
        };
        const setNotice = (text, kind = 'info') => {
            if (!text) {
                notice.hidden = true;
                return;
            }
            notice.hidden = false;
            notice.style.background = kind === 'warn' ? 'var(--lume-warn-dim)' : 'var(--lume-accent-dim)';
            noticeText.textContent = text;
        };
        const setStatus = (text) => {
            status.replaceChildren();
            status.appendChild(el('span', undefined, text));
        };
        const navigate = async (raw) => {
            const target = raw.trim();
            if (!target)
                return;
            releaseBlob();
            if (target.startsWith('/')) {
                /* Local document from the virtual file system. */
                setNotice('');
                try {
                    const text = await ctx.kernel.vfs.readText(target);
                    const type = /\.html?$/i.test(target) ? 'text/html' : 'text/plain';
                    blobUrl = URL.createObjectURL(new Blob([text], { type }));
                    frame.src = blobUrl;
                    current = target;
                    ctx.window.setTitle(`Browser — ${target}`);
                    setStatus(`Local document · ${target} · ${text.length} characters`);
                }
                catch (e) {
                    frame.removeAttribute('src');
                    setNotice(`Could not read ${target}: ${e.message}`, 'warn');
                    setStatus('Load failed');
                }
                return;
            }
            const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
            try {
                const parsed = new URL(url);
                frame.src = parsed.href;
                current = parsed.href;
                ctx.window.setTitle(`Browser — ${parsed.hostname}`);
                setStatus(`External page · ${parsed.href}`);
                setNotice('Many websites refuse to be embedded in a frame. If the page stays blank, use the ' +
                    'open-in-new-tab button.', 'warn');
            }
            catch {
                setNotice(`Not a valid address: ${target}`, 'warn');
            }
        };
        const doGo = () => {
            history.push(omni.value);
            void navigate(omni.value);
        };
        go.addEventListener('click', doGo);
        omni.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                doGo();
        });
        reload.addEventListener('click', () => void navigate(omni.value));
        back.addEventListener('click', () => {
            if (history.length > 1) {
                history.pop();
                const prev = history.pop();
                omni.value = prev;
                history.push(prev);
                void navigate(prev);
            }
        });
        external.addEventListener('click', () => {
            const target = current || omni.value;
            if (!target)
                return;
            const url = target.startsWith('/') ? new URL(target, location.origin).href : target;
            window.open(url, '_blank', 'noopener');
        });
        ctx.window.el.addEventListener('lume:unmount', releaseBlob);
        setNotice('Enter a local path such as /index.html, or an https:// address.');
        void navigate(omni.value);
    },
};
