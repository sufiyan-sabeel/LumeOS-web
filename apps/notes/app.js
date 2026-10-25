/*
 * LumeOS - apps/notes/app.ts
 * A real notes application: list, create, rename, delete and autosave,
 * persisted through the virtual file system (C backend when online, OPFS
 * when offline). Nothing is stored only in memory.
 */
import { confirmDialog, promptDialog } from '../../components/modal.js';
import { iconEl } from '../../components/icons.js';
const NOTES_DIR = '/notes';
function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls)
        n.className = cls;
    if (text !== undefined)
        n.textContent = text;
    return n;
}
export const notesApp = {
    manifest: {
        id: 'notes',
        name: 'Notes',
        icon: 'notes',
        description: 'Create, edit and persist notes through the virtual file system.',
        category: 'productivity',
        type: 'builtin',
        width: 760,
        height: 520,
        onDesktop: true,
    },
    mount(ctx) {
        const app = el('div', 'app');
        const toolbar = el('div', 'app__toolbar');
        const split = el('div', 'app__split');
        const status = el('div', 'app__status');
        /* ---- list ---- */
        const list = el('div', 'notes__list');
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', 'Notes');
        /* ---- editor ---- */
        const editorWrap = el('div', 'notes__editor');
        const titleInput = el('input');
        titleInput.type = 'text';
        titleInput.placeholder = 'Note title';
        titleInput.setAttribute('aria-label', 'Note title');
        const area = el('textarea', 'notes__area');
        area.spellcheck = false;
        area.placeholder = 'Start writing…';
        area.setAttribute('aria-label', 'Note body');
        editorWrap.append(titleInput, area);
        split.append(list, editorWrap);
        app.append(toolbar, split, status);
        ctx.window.body.appendChild(app);
        /* ---- state ---- */
        let notes = [];
        let current = null;
        let dirty = false;
        let saveTimer;
        let loading = false;
        /**
         * The editor is inert until a note is selected, so a user typing into an
         * unsaved buffer never silently loses their text.
         */
        const setEditorEnabled = (on) => {
            area.disabled = !on;
            titleInput.disabled = !on;
            area.placeholder = on
                ? 'Start writing…'
                : 'Create or select a note to start writing.';
            for (const b of [saveBtn, renameBtn, deleteBtn])
                b.disabled = !on;
        };
        const setStatus = (msg, kind = 'plain') => {
            status.replaceChildren();
            if (kind === 'ok')
                status.appendChild(iconEl('checkCircle', 13));
            if (kind === 'err')
                status.appendChild(iconEl('alert', 13));
            status.appendChild(el('span', undefined, msg));
        };
        const markDirty = () => {
            dirty = true;
            if (saveTimer !== undefined)
                window.clearTimeout(saveTimer);
            saveTimer = window.setTimeout(() => void save(), 700);
        };
        /* ---- persistence ---- */
        const ensureDir = async () => {
            try {
                await ctx.kernel.vfs.mkdir(NOTES_DIR);
            }
            catch {
                /* already exists, or the backend forbids it — list() will tell us */
            }
        };
        const refreshList = async () => {
            try {
                const entries = await ctx.kernel.vfs.list(NOTES_DIR);
                notes = entries
                    .filter((e) => e.type === 'file')
                    .map((e) => ({ name: e.name.replace(/\.md$/i, ''), path: `${NOTES_DIR}/${e.name}`, size: e.size }))
                    .sort((a, b) => a.name.localeCompare(b.name));
            }
            catch {
                notes = [];
            }
            renderList();
        };
        const renderList = () => {
            list.replaceChildren();
            if (notes.length === 0) {
                const empty = el('div', 'state');
                empty.style.padding = '24px 12px';
                empty.appendChild(iconEl('notes', 20, 'state__icon'));
                empty.appendChild(el('div', 'state__title', 'No notes yet'));
                empty.appendChild(el('div', 'state__body', 'Use “New” to create your first note.'));
                list.appendChild(empty);
                return;
            }
            for (const n of notes) {
                const item = el('button', 'notes__item');
                item.type = 'button';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(current === n.path));
                if (current === n.path)
                    item.classList.add('active');
                item.appendChild(iconEl('file', 14));
                item.appendChild(el('span', undefined, n.name));
                item.addEventListener('click', () => void openNote(n.path, n.name));
                list.appendChild(item);
            }
        };
        const openNote = async (path, name) => {
            if (dirty)
                await save();
            loading = true;
            try {
                const text = await ctx.kernel.vfs.readText(path);
                current = path;
                titleInput.value = name;
                area.value = text;
                setEditorEnabled(true);
                ctx.window.setTitle(`Notes — ${name}`);
                setStatus(`Loaded ${path} · ${text.length} characters`);
                dirty = false;
            }
            catch (e) {
                setStatus(`Could not open ${path}: ${e.message}`, 'err');
            }
            finally {
                loading = false;
                renderList();
            }
        };
        const save = async () => {
            if (!current || loading)
                return;
            try {
                await ctx.kernel.vfs.writeText(current, area.value);
                dirty = false;
                setStatus(`Saved · ${area.value.length} characters`, 'ok');
                await refreshList();
            }
            catch (e) {
                setStatus(`Save failed: ${e.message}`, 'err');
                ctx.kernel.notify('Save failed', e.message, 'error');
            }
        };
        const safeName = (raw) => raw.trim().replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60);
        const createNote = async () => {
            const name = await promptDialog('New note', 'Note title', 'Untitled');
            if (name === null)
                return;
            const clean = safeName(name) || 'Untitled';
            const path = `${NOTES_DIR}/${clean}.md`;
            try {
                if (await ctx.kernel.vfs.exists(path)) {
                    ctx.kernel.notify('Note exists', `“${clean}” is already open-able`, 'error');
                    await openNote(path, clean);
                    return;
                }
                await ensureDir();
                await ctx.kernel.vfs.writeText(path, '');
                await refreshList();
                await openNote(path, clean);
                area.focus();
            }
            catch (e) {
                ctx.kernel.notify('Could not create note', e.message, 'error');
            }
        };
        const renameNote = async () => {
            if (!current)
                return;
            const clean = safeName(await promptDialog('Rename note', 'New title', titleInput.value) ?? '');
            if (!clean)
                return;
            const next = `${NOTES_DIR}/${clean}.md`;
            if (next === current)
                return;
            try {
                const text = await ctx.kernel.vfs.readText(current);
                await ctx.kernel.vfs.writeText(next, text);
                await ctx.kernel.vfs.remove(current);
                current = next;
                titleInput.value = clean;
                ctx.window.setTitle(`Notes — ${clean}`);
                await refreshList();
                setStatus(`Renamed to ${clean}`, 'ok');
            }
            catch (e) {
                ctx.kernel.notify('Rename failed', e.message, 'error');
            }
        };
        const deleteNote = async () => {
            if (!current)
                return;
            const ok = await confirmDialog('Delete note', `Delete “${titleInput.value}” permanently?`);
            if (!ok)
                return;
            const path = current;
            try {
                await ctx.kernel.vfs.remove(path);
                current = null;
                area.value = '';
                titleInput.value = '';
                dirty = false;
                setEditorEnabled(false);
                ctx.window.setTitle('Notes');
                await refreshList();
                setStatus(`Deleted ${path}`);
            }
            catch (e) {
                ctx.kernel.notify('Delete failed', e.message, 'error');
            }
        };
        /* ---- toolbar ---- */
        const mkBtn = (icon, label, onClick, primary = false) => {
            const b = el('button', primary ? 'primary' : undefined);
            b.type = 'button';
            b.appendChild(iconEl(icon, 15));
            b.appendChild(el('span', undefined, label));
            b.addEventListener('click', onClick);
            return b;
        };
        const newBtn = mkBtn('plus', 'New', () => void createNote(), true);
        const saveBtn = mkBtn('save', 'Save', () => void save());
        const renameBtn = mkBtn('file', 'Rename', () => void renameNote());
        const deleteBtn = mkBtn('trash', 'Delete', () => void deleteNote());
        toolbar.append(newBtn, saveBtn, renameBtn, deleteBtn);
        setEditorEnabled(false);
        /* ---- events ---- */
        area.addEventListener('input', markDirty);
        titleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void renameNote();
            }
        });
        area.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void save();
            }
        });
        /* Autosave on close so nothing is lost. */
        ctx.window.el.addEventListener('lume:unmount', () => {
            if (saveTimer !== undefined)
                window.clearTimeout(saveTimer);
            if (dirty)
                void ctx.kernel.vfs.writeText(current ?? '', area.value).catch(() => undefined);
        });
        /* ---- start ---- */
        void (async () => {
            await ensureDir();
            await refreshList();
            const initial = ctx.args.path;
            if (initial) {
                const name = initial.split('/').pop()?.replace(/\.md$/i, '') ?? 'Note';
                await openNote(initial, name);
            }
            else if (notes.length > 0) {
                await openNote(notes[0].path, notes[0].name);
            }
            else {
                setEditorEnabled(false);
                setStatus('No notes yet — use “New” to create one.');
            }
        })();
    },
};
