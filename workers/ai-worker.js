/*
 * LumeOS - workers/ai-worker.ts
 * Off-main-thread inference surface. Ships a deterministic rule-based
 * micro-model so the AI Center can respond fully offline without a neural
 * runtime; the message protocol is model-agnostic so a real runtime can be
 * dropped in behind it later.
 */
const scope = self;
function respond(prompt) {
    const p = prompt.trim().toLowerCase();
    if (!p)
        return 'Ask me something.';
    if (/^(hi|hello|hey|namaste)\b/.test(p))
        return 'Hello! I am Lume, the offline micro-model running in a Web Worker.';
    if (p.includes('time'))
        return `The current time is ${new Date().toLocaleString()}.`;
    if (p.includes('help') || p.includes('what can you do'))
        return 'I handle greetings, arithmetic, time/date and simple LumeOS questions — entirely offline.';
    const math = p.match(/^[0-9+\-*/().\s%^]+$/);
    if (math) {
        try {
            const js = p.replace(/\^/g, '**').replace(/%/g, '/100');
            const result = Function(`"use strict";return (${js});`)();
            if (typeof result === 'number' && isFinite(result))
                return `${prompt.trim()} = ${result}`;
        }
        catch {
            /* fall through */
        }
    }
    const words = prompt.trim().split(/\s+/).length;
    return `Received ${words} word(s). I am a rule-based micro-model and cannot reason generally; ` +
        `a neural runtime is not bundled in this build.`;
}
scope.onmessage = (e) => {
    const data = e.data;
    if (!data || typeof data.id !== 'number')
        return;
    scope.postMessage({ id: data.id, text: respond(data.prompt ?? '') });
};
export {};
