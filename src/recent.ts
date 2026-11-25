// Recent files, kept in the browser's IndexedDB on this device only.
// Where the browser gives a file handle (Edge/Chrome on a computer), papgi remembers the file
// itself and reopens it from disk. Elsewhere (iPhone, Safari, Firefox) it keeps a copy of
// files up to MAX_COPY_BYTES so they can be reopened. Each entry has a small thumbnail.

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  opened: number; // ms since 1970
  thumb: string; // data: URL (small JPEG), may be ""
  handle?: FileSystemFileHandle;
  copy?: Blob;
}

export const MAX_RECENT = 8;
export const MAX_COPY_BYTES = 40e6;

const DB = "papgi";
const STORE = "recent";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      d.close();
      resolve(req ? req.result : undefined);
    };
    // (a full disk aborts the transaction without an error event: settle either way)
    t.onerror = t.onabort = () => {
      d.close();
      reject(t.error ?? new Error("Storage transaction aborted"));
    };
  });
}

/** Newest first. Never throws (private browsing, storage off): returns [] instead. */
export async function listRecent(): Promise<RecentFile[]> {
  try {
    const all = (await tx<RecentFile[]>("readonly", (s) => s.getAll())) ?? [];
    return all.sort((a, b) => b.opened - a.opened);
  } catch {
    return [];
  }
}

/** Two entries are the same file when the handle points to the same file, else same name + size. */
async function sameFile(a: RecentFile, b: Pick<RecentFile, "name" | "size" | "handle">): Promise<boolean> {
  if (a.handle && b.handle) {
    try {
      return await a.handle.isSameEntry(b.handle);
    } catch {
      return false;
    }
  }
  return a.name === b.name && a.size === b.size;
}

/** Add or refresh a file (most recent first, at most MAX_RECENT kept). */
export async function rememberFile(f: { name: string; bytes: Uint8Array; handle: FileSystemFileHandle | null; pages: number; thumb: string }): Promise<void> {
  try {
    const all = await listRecent();
    const entry: RecentFile = {
      id: "",
      name: f.name,
      size: f.bytes.length,
      pages: f.pages,
      opened: Date.now(),
      thumb: f.thumb,
    };
    if (f.handle) entry.handle = f.handle;
    else if (f.bytes.length <= MAX_COPY_BYTES) entry.copy = new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
    let old: RecentFile | undefined;
    for (const r of all) if (await sameFile(r, { name: f.name, size: f.bytes.length, handle: f.handle ?? undefined })) old = r;
    entry.id = old?.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!entry.thumb && old) entry.thumb = old.thumb;
    const keep = [entry, ...all.filter((r) => r.id !== entry.id)];
    await tx("readwrite", (s) => {
      s.put(entry);
      for (const r of keep.slice(MAX_RECENT)) s.delete(r.id);
    });
  } catch {
    // (no storage: recent files are just a convenience)
  }
}

export async function forgetFile(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

export async function forgetAll(): Promise<void> {
  try {
    await tx("readwrite", (s) => s.clear());
  } catch {
    /* ignore */
  }
}

/**
 * The bytes of a recent file: from disk (asks for permission if needed; must run from a click)
 * or from the stored copy. Throws with a readable message if it's gone.
 */
export async function readRecent(r: RecentFile): Promise<{ bytes: Uint8Array; handle: FileSystemFileHandle | null }> {
  if (r.handle) {
    const h = r.handle as FileSystemFileHandle & {
      queryPermission?: (d: unknown) => Promise<string>;
      requestPermission?: (d: unknown) => Promise<string>;
    };
    try {
      let perm = h.queryPermission ? await h.queryPermission({ mode: "read" }) : "granted";
      if (perm !== "granted" && h.requestPermission) perm = await h.requestPermission({ mode: "read" });
      if (perm === "granted") {
        const file = await h.getFile();
        return { bytes: new Uint8Array(await file.arrayBuffer()), handle: r.handle };
      }
    } catch {
      // moved or deleted: fall back to a copy if there is one
    }
    if (!r.copy) throw new Error(`Couldn't open “${r.name}”: it may have been moved, renamed or deleted, or access was not allowed.`);
  }
  if (r.copy) return { bytes: new Uint8Array(await r.copy.arrayBuffer()), handle: null };
  throw new Error(`“${r.name}” is too big to keep a copy of. Open it again from your files.`);
}

/** "just now", "5 min ago", "yesterday", "12 Mar" */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(t);
  const today = new Date(now);
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return `${Math.floor(s / 3600)} h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
