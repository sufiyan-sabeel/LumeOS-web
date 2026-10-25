/*
 * LumeOS - components/modal.ts
 * Promise-based modal dialogs (confirm / prompt).
 */
function openModal(build) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 'modal';
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        const close = (value) => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const onKey = (e) => {
            if (e.key === 'Escape')
                close(null);
        };
        document.addEventListener('keydown', onKey);
        backdrop.addEventListener('mousedown', (e) => {
            if (e.target === backdrop)
                close(null);
        });
        build(modal, close);
    });
}
export function confirmDialog(title, message) {
    return openModal((root, close) => {
        const h = document.createElement('h2');
        h.textContent = title;
        const p = document.createElement('p');
        p.className = 'dim';
        p.textContent = message;
        const actions = document.createElement('div');
        actions.className = 'modal__actions';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.onclick = () => close(false);
        const ok = document.createElement('button');
        ok.className = 'primary';
        ok.textContent = 'Confirm';
        ok.onclick = () => close(true);
        actions.append(cancel, ok);
        root.append(h, p, actions);
    }).then((v) => v === true);
}
export function promptDialog(title, label, initial = '') {
    return openModal((root, close) => {
        const h = document.createElement('h2');
        h.textContent = title;
        const p = document.createElement('p');
        p.className = 'dim';
        p.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = initial;
        input.style.width = '100%';
        const actions = document.createElement('div');
        actions.className = 'modal__actions';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.onclick = () => close(null);
        const ok = document.createElement('button');
        ok.className = 'primary';
        ok.textContent = 'OK';
        ok.onclick = () => close(input.value);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                close(input.value);
        });
        actions.append(cancel, ok);
        root.append(h, p, input, actions);
        setTimeout(() => input.focus(), 20);
    }).then((v) => (typeof v === 'string' ? v : null));
}
