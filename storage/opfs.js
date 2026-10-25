/*
 * LumeOS - storage/opfs.ts  (compatibility shim)
 *
 * The OPFS-only manager has been superseded by storage/local-fs.ts, which
 * prefers OPFS and transparently falls back to an IndexedDB file store when
 * OPFS is unavailable. This module is kept so that any older import path
 * keeps working.
 */
export { LocalFs, localFs, localFs as opfs } from './local-fs.js';
