/*
 * LumeOS - apps/calculator/app.ts
 * Scientific / programmer calculator utility.
 */
export const calculatorApp = {
    manifest: {
        id: 'calculator',
        name: 'Calculator',
        icon: 'calculator',
        description: 'Scientific and programmer calculator.',
        category: 'utility',
        type: 'builtin',
        width: 360,
        height: 560,
        onDesktop: true,
    },
    mount(ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'calc';
        const display = document.createElement('div');
        display.className = 'calc__display';
        display.textContent = '0';
        const grid = document.createElement('div');
        grid.className = 'calc__grid';
        const hist = document.createElement('div');
        hist.className = 'calc__hist';
        let expr = '';
        let justEvaluated = false;
        const setDisplay = () => {
            display.textContent = expr || '0';
        };
        const evaluate = () => {
            try {
                /* Restrict to a safe arithmetic grammar (no eval of arbitrary code). */
                const sanitized = expr.replace(/\s+/g, '');
                if (!/^[0-9+\-*/%().^eE]*$/.test(sanitized)) {
                    throw new Error('invalid characters');
                }
                const js = sanitized.replace(/\^/g, '**').replace(/%/g, '/100');
                // eslint-disable-next-line no-new-func
                const result = Function(`"use strict";return (${js});`)();
                if (typeof result !== 'number' || !isFinite(result)) {
                    throw new Error('not a number');
                }
                const line = document.createElement('div');
                line.textContent = `${expr} = ${result}`;
                hist.prepend(line);
                expr = String(result);
                justEvaluated = true;
                setDisplay();
            }
            catch (e) {
                display.textContent = `Error: ${e.message}`;
                expr = '';
            }
        };
        const press = (label, cls, action) => {
            const b = document.createElement('button');
            b.textContent = label;
            if (cls)
                b.className = cls;
            b.onclick = () => {
                if (action)
                    action();
                else {
                    if (justEvaluated && /[0-9.]/.test(label)) {
                        expr = '';
                    }
                    justEvaluated = false;
                    expr += label;
                    setDisplay();
                }
            };
            grid.appendChild(b);
        };
        const keys = [
            ['C', 'op', () => { expr = ''; justEvaluated = false; setDisplay(); }],
            ['⌫', 'op', () => { expr = expr.slice(0, -1); setDisplay(); }],
            ['%', 'op'],
            ['/', 'op'],
            ['7'], ['8'], ['9'],
            ['*', 'op'],
            ['4'], ['5'], ['6'],
            ['-', 'op'],
            ['1'], ['2'], ['3'],
            ['+', 'op'],
            ['0'], ['.'],
            ['(', 'op'], [')', 'op'],
            ['=', 'eq', evaluate],
            ['√', 'op', () => { expr = `Math.sqrt(${expr || 0})`; evaluate(); }],
            ['^', 'op'],
            ['π', 'op', () => { expr += '3.141592653589793'; setDisplay(); }],
        ];
        for (const [label, cls, action] of keys)
            press(label, cls, action);
        wrap.append(display, grid, hist);
        ctx.window.body.appendChild(wrap);
        const onKey = (e) => {
            if (/^[0-9+\-*/.%()^]$/.test(e.key)) {
                expr += e.key;
                setDisplay();
            }
            else if (e.key === 'Enter') {
                evaluate();
            }
            else if (e.key === 'Backspace') {
                expr = expr.slice(0, -1);
                setDisplay();
            }
        };
        ctx.window.el.addEventListener('keydown', onKey);
    },
};
