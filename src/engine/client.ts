// Main-thread proxy for the engine worker: engine.method(...) returns a Promise.
import type { WorkerEngine } from "./worker";

type AnyFn = (...args: never[]) => unknown;
export type Remote<T> = {
  [K in keyof T as T[K] extends AnyFn ? K : never]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export type Engine = Remote<WorkerEngine>;

export function createEngine(): { engine: Engine; ready: Promise<void> } {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let markReady!: () => void;
  let failReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    markReady = res;
    failReady = rej;
  });

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.ready) return markReady();
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || "The PDF engine failed to load");
    failReady(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const engine = new Proxy({} as Engine, {
    get(_t, method: string) {
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          const transfer = args.filter((a): a is Uint8Array => a instanceof Uint8Array).map((a) => a.buffer as ArrayBuffer);
          worker.postMessage({ id, method, args }, transfer);
        });
    },
  });
  return { engine, ready };
}
