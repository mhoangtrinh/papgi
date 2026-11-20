// Opening and saving files. Uses the File System Access API where available
// (Edge/Chrome on Windows: real "Save" back to the same file), with download fallback.

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  handle: FileSystemFileHandle | null;
}

const PDF_TYPES = [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }];

interface FsWindow {
  showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
}
const fsw = window as unknown as FsWindow;

export const canSaveInPlace = typeof fsw.showSaveFilePicker === "function";

export async function fileToOpened(file: File, handle: FileSystemFileHandle | null = null): Promise<OpenedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle };
}

/** Ask the user for PDF file(s). Resolves to [] if cancelled. */
export async function pickPdfs(multiple = false): Promise<OpenedFile[]> {
  if (fsw.showOpenFilePicker) {
    try {
      const handles = await fsw.showOpenFilePicker({ types: PDF_TYPES, multiple, id: "papgi-open" });
      return Promise.all(handles.map(async (h) => fileToOpened(await h.getFile(), h)));
    } catch (e) {
      if ((e as Error).name === "AbortError") return [];
      // fall through to the classic picker
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = multiple;
    input.onchange = async () => resolve(Promise.all([...(input.files ?? [])].map((f) => fileToOpened(f))));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/** Write bytes back to an existing handle. Throws if permission is refused. */
export async function writeToHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (d: unknown) => Promise<string>;
    requestPermission?: (d: unknown) => Promise<string>;
  };
  if (h.queryPermission && (await h.queryPermission({ mode: "readwrite" })) !== "granted") {
    if (!h.requestPermission || (await h.requestPermission({ mode: "readwrite" })) !== "granted") {
      throw new Error("No permission to write to the file");
    }
  }
  const w = await handle.createWritable();
  await w.write(bytes as Uint8Array<ArrayBuffer>);
  await w.close();
}

/**
 * Save as a new file. Returns the new handle (File System Access API) or null when
 * it fell back to a download. Returns undefined if the user cancelled.
 */
export async function saveAs(bytes: Uint8Array, suggestedName: string): Promise<FileSystemFileHandle | null | undefined> {
  if (fsw.showSaveFilePicker) {
    try {
      const handle = await fsw.showSaveFilePicker({ suggestedName, types: PDF_TYPES, id: "papgi-save" });
      await writeToHandle(handle, bytes);
      return handle;
    } catch (e) {
      if ((e as Error).name === "AbortError") return undefined;
      throw e;
    }
  }
  download(bytes, suggestedName);
  return null;
}

const SAVE_TYPES: Record<string, { description: string; accept: Record<string, string[]> }> = {
  "application/pdf": { description: "PDF documents", accept: { "application/pdf": [".pdf"] } },
  "application/zip": { description: "ZIP archive", accept: { "application/zip": [".zip"] } },
  "image/png": { description: "PNG picture", accept: { "image/png": [".png"] } },
  "image/jpeg": { description: "JPG picture", accept: { "image/jpeg": [".jpg", ".jpeg"] } },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { description: "Word document", accept: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"] } },
};

/** Save a result file: a "Save as" dialog where the browser has one, otherwise a download. */
export async function saveFile(bytes: Uint8Array, name: string, type: string): Promise<void> {
  const t = SAVE_TYPES[type];
  if (fsw.showSaveFilePicker && t) {
    try {
      const handle = await fsw.showSaveFilePicker({ suggestedName: name, types: [t], id: "papgi-tools" });
      await writeToHandle(handle, bytes);
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // (e.g. not allowed in this context): fall back to a download
    }
  }
  download(bytes, name, type);
}

export function download(bytes: Uint8Array, name: string, type = "application/pdf"): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Files passed in by the OS ("Open with papgi" on an installed app). */
export function onLaunchFiles(cb: (f: OpenedFile) => void): void {
  const lq = (window as unknown as { launchQueue?: { setConsumer: (fn: (p: { files: FileSystemFileHandle[] }) => void) => void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    for (const h of params.files ?? []) cb(await fileToOpened(await h.getFile(), h));
  });
}

export function baseName(name: string): string {
  return name.replace(/\.pdf$/i, "");
}
