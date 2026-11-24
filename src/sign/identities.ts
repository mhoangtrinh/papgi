// Certificates to sign with, kept in this browser (IndexedDB). The private key is stored as a
// key the browser can sign with but never hands out (not extractable).
import { certNames, type Signer } from "./cms";

export interface Identity extends Signer {
  id: string;
  name: string;
  email: string;
  issuer: string;
  selfSigned: boolean;
  /** Valid until (ms). */
  until: number;
  added: number;
}

const DB = "papgi-sign";
const STORE = "ids";

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
    t.onerror = () => {
      d.close();
      reject(t.error);
    };
  });
}

/** Newest first; [] if storage isn't available. */
export async function listIdentities(): Promise<Identity[]> {
  try {
    return ((await tx<Identity[]>("readonly", (s) => s.getAll())) ?? []).sort((a, b) => b.added - a.added);
  } catch {
    return [];
  }
}

/** Keep a certificate and its key on this device. */
export async function addIdentity(s: Signer): Promise<Identity> {
  const n = certNames(s.cert);
  const id: Identity = { ...s, id: crypto.randomUUID(), name: n.name, email: n.email, issuer: n.issuer, selfSigned: n.selfSigned, until: n.until, added: Date.now() };
  try {
    await tx("readwrite", (st) => st.put(id));
  } catch {
    throw new Error("This browser can't keep the certificate (private browsing?).");
  }
  return id;
}

export async function removeIdentity(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}
