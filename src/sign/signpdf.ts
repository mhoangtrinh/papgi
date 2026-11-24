// Signing a PDF and checking the signatures in one: the file bytes (from the engine) and the
// signature (made here, with the key that stays on this device).
import type { SigInfo } from "../engine/sigfield";
import { checkSignature, createSignature, type SigCheck, type Signer } from "./cms";
import { fillByteRange, fillContents, findPlaceholder, signedBytes } from "./pdfsig";

/** Sign a file the engine prepared (prepareSign): returns the signed file. */
export async function finishSignature(prepared: Uint8Array, signer: Signer, when = new Date()): Promise<Uint8Array> {
  const b = prepared.slice();
  const p = findPlaceholder(b);
  const range = fillByteRange(b, p);
  const der = await createSignature(signedBytes(b, range), signer, when);
  fillContents(b, p, der);
  return b;
}

export interface SigReport extends SigCheck {
  info: SigInfo;
  /** The signature covers the whole file: nothing was added after it was signed. */
  whole: boolean;
}

const KINDS = ["adbe.pkcs7.detached", "ETSI.CAdES.detached"];

/** Check the signatures (as listed by the engine) against the file as it was opened. */
export async function checkSignatures(file: Uint8Array, sigs: SigInfo[]): Promise<SigReport[]> {
  const out: SigReport[] = [];
  for (const info of sigs) {
    const [a, b, c, d] = info.byteRange;
    const fits = info.byteRange.length === 4 && a === 0 && b > 0 && c > b && d >= 0 && c + d <= file.length;
    let check: SigCheck;
    if (!KINDS.includes(info.subFilter)) check = { status: "unknown", signer: info.name, email: "", issuer: "", selfSigned: false, time: info.time, problem: `This kind of signature (${info.subFilter || "unknown"}) can't be checked here.` };
    else if (!fits) check = { status: "invalid", signer: info.name, email: "", issuer: "", selfSigned: false, time: info.time, problem: "The signature doesn't fit this file: it was changed." };
    else check = await checkSignature(signedBytes(file, info.byteRange), info.contents);
    // (only white space may follow what was signed)
    let end = fits ? c + d : 0;
    while (end < file.length && (file[end] === 0x0a || file[end] === 0x0d || file[end] === 0x20 || file[end] === 0)) end++;
    out.push({ ...check, signer: check.signer || info.name, time: check.time || info.time, info, whole: fits && end >= file.length });
  }
  return out;
}
