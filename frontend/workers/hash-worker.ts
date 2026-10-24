/*
 * LumeOS - workers/hash-worker.ts
 * Off-main-thread SHA-256 hashing for package integrity verification.
 *
 * Written with explicit `self` casts so it type-checks under the DOM lib
 * while still running inside a dedicated worker.
 */

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
}

const scope = self as unknown as WorkerScope;

interface HashRequest {
  id: number;
  buffer: ArrayBuffer;
}

scope.onmessage = (e: MessageEvent) => {
  const data = e.data as HashRequest;
  if (!data || typeof data.id !== 'number' || !data.buffer) return;
  crypto.subtle
    .digest('SHA-256', data.buffer)
    .then((digest) => {
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      scope.postMessage({ id: data.id, hex });
    })
    .catch((err: unknown) => {
      scope.postMessage({ id: data.id, error: String(err) });
    });
};

export {};
