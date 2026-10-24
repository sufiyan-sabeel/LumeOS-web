/*
 * LumeOS - storage/zip.ts
 * Minimal, dependency-free ZIP reader built on the browser's native
 * DecompressionStream. This is what lets the App Store install a real
 * `.lume` archive (a standard ZIP) entirely client-side and offline.
 *
 * Supports the two methods that matter for packages: STORE (0) and
 * DEFLATE (8, raw). Sizes are taken from the central directory, which is
 * always authoritative even when the writer used a streaming data
 * descriptor.
 */

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const EOCD_SIG = 0x06054b50; // end of central directory
const CEN_SIG = 0x02014b50; //  central directory file header
const LOC_SIG = 0x04034b50; //  local file header

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  /* Feed and drain concurrently to avoid a deadlock on large members. */
  const writeDone = writer.write(data as BufferSource).then(() => writer.close());

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value as Uint8Array);
      total += (value as Uint8Array).length;
    }
  }
  await writeDone.catch(() => undefined);

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function unzip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const decoder = new TextDecoder();

  /* Locate the end-of-central-directory record (scan back over the comment). */
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > u8.length || dv.getUint32(off, true) !== CEN_SIG) {
      throw new Error('corrupt zip: bad central directory entry');
    }
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = decoder.decode(u8.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry

    if (dv.getUint32(localOff, true) !== LOC_SIG) {
      throw new Error(`corrupt zip: bad local header for ${name}`);
    }
    /* Local header's own name/extra lengths may differ from the central copy. */
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(dataStart, dataStart + compSize);

    let bytes: Uint8Array;
    if (method === 0) {
      bytes = comp.slice();
    } else if (method === 8) {
      bytes = await inflateRaw(comp);
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    entries.push({ name, bytes });
  }
  return entries;
}

/** Strip any leading directory component from archive entry names. */
export function normalizeEntryName(name: string): string {
  return name.replace(/^\.\//, '').replace(/^\/+/, '');
}
