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
 * Save as a new file: a normal browser download (it shows in the browser's downloads and lands
 * in the Downloads folder, or wherever the browser is set to ask). Always null: no file handle.
 */
export async function saveAs(bytes: Uint8Array, suggestedName: string): Promise<null> {
  download(bytes, suggestedName);
  return null;
}

/** Save a result file (any type) as a normal download. */
export async function saveFile(bytes: Uint8Array, name: string, type: string): Promise<void> {
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

/** MuPDF's messages in plain words. */
export function friendlyError(msg: string): string {
  if (/no objects found|cannot recognize version|not a pdf|unknown keyword|syntax error|cannot find startxref|no pages/i.test(msg)) return "it isn't a PDF, or it is too damaged to open.";
  if (/out of memory|memory|alloc.*failed/i.test(msg)) return "it's too big for this device's memory.";
  return msg;
}
