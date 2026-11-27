import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { createSignature, checkSignature, makeSelfSigned, importPfx, certNames, hasBadSerial, reissueSelfSigned } from "../src/sign/cms";

const has = (cmd: string) => {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("signatures (CMS)", { timeout: 30000 }, () => {
  it("serial numbers of your own certificates are always strict DER (OpenSSL and others reject the rest)", async () => {
    for (let i = 0; i < 40; i++) expect(hasBadSerial((await makeSelfSigned("A", "")).cert)).toBe(false);
  });

  it.runIf(has("openssl"))("a certificate made before with a badly encoded serial number is made again, and its signatures check out elsewhere", async () => {
    const me = await makeSelfSigned("Hoang Trinh", "hoang@example.com");
    // as about 1 in 256 certificates were: a first byte of 0 before one below 0x80
    const c = pkijs.Certificate.fromBER(me.cert.buffer.slice(me.cert.byteOffset, me.cert.byteOffset + me.cert.byteLength) as ArrayBuffer);
    c.serialNumber = new asn1js.Integer({ valueHex: new Uint8Array([0x00, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33]).buffer });
    await c.sign(me.key, "SHA-256");
    const bad = { ...me, cert: new Uint8Array(c.toSchema(true).toBER(false)) };
    expect(hasBadSerial(bad.cert)).toBe(true);
    const data = new TextEncoder().encode("%PDF-1.7 signed bytes");
    const opensslOk = async (s: typeof me) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-"));
      fs.writeFileSync(path.join(dir, "sig.der"), await createSignature(data, s));
      fs.writeFileSync(path.join(dir, "data.bin"), data);
      try {
        return /Verification successful/.test(execSync(`openssl cms -verify -binary -inform DER -in sig.der -content data.bin -noverify -out /dev/null 2>&1`, { cwd: dir }).toString());
      } catch {
        return false;
      }
    };
    expect(await opensslOk(bad)).toBe(false);
    const fixed = await reissueSelfSigned(bad);
    expect(hasBadSerial(fixed.cert)).toBe(false);
    expect(certNames(fixed.cert)).toEqual(certNames(bad.cert));
    expect(await opensslOk(fixed)).toBe(true);
    expect(await checkSignature(data, await createSignature(data, fixed))).toMatchObject({ status: "valid", signer: "Hoang Trinh" });
  });

  it("signs with a certificate of your own; the signature checks out, and not for changed bytes", async () => {
    const me = await makeSelfSigned("Hoang Trinh", "hoang@example.com");
    expect(certNames(me.cert)).toMatchObject({ name: "Hoang Trinh", email: "hoang@example.com", selfSigned: true });
    const data = new TextEncoder().encode("%PDF-1.7 the signed parts of a file");
    const der = await createSignature(data, me);
    const ok = await checkSignature(data, der);
    expect(ok).toMatchObject({ status: "valid", signer: "Hoang Trinh", email: "hoang@example.com", selfSigned: true });
    expect(ok.time).toBeGreaterThan(Date.now() - 60_000);
    // zeros after the signature (the rest of its room in the file) don't matter
    const padded = new Uint8Array(der.length + 500);
    padded.set(der);
    expect((await checkSignature(data, padded)).status).toBe("valid");
    const changed = data.slice();
    changed[3] ^= 1;
    expect((await checkSignature(changed, der)).status).toBe("invalid");
    if (has("openssl")) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-"));
      fs.writeFileSync(path.join(dir, "sig.der"), der);
      fs.writeFileSync(path.join(dir, "data.bin"), data);
      const out = execSync(`openssl cms -verify -binary -inform DER -in sig.der -content data.bin -noverify -out /dev/null 2>&1`, { cwd: dir }).toString();
      expect(out).toMatch(/Verification successful/);
    }
  });

  it.runIf(has("openssl"))("reads a .p12 certificate file (with its chain) and signs with it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p12-"));
    const run = (c: string) => execSync(c, { cwd: dir, stdio: "pipe" });
    run(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 30 -subj "/CN=Test CA"`);
    run(`openssl req -newkey rsa:2048 -nodes -keyout me.key -out me.csr -subj "/CN=Aga Example/emailAddress=aga@example.com"`);
    run(`openssl x509 -req -in me.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out me.crt -days 30`);
    run(`openssl pkcs12 -export -inkey me.key -in me.crt -certfile ca.crt -out me.p12 -passout pass:secret`);
    const p12 = new Uint8Array(fs.readFileSync(path.join(dir, "me.p12")));
    await expect(importPfx(p12, "wrong")).rejects.toThrow(/password/i);
    const s = await importPfx(p12, "secret");
    expect(certNames(s.cert)).toMatchObject({ name: "Aga Example", issuer: "Test CA", selfSigned: false });
    expect(s.chain).toHaveLength(1);
    const data = new TextEncoder().encode("some bytes");
    const der = await createSignature(data, s);
    expect(await checkSignature(data, der)).toMatchObject({ status: "valid", signer: "Aga Example", issuer: "Test CA", selfSigned: false });
    // an elliptic-curve key works too
    run(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ec.key -out ec.crt -days 30 -subj "/CN=EC Person"`);
    run(`openssl pkcs12 -export -inkey ec.key -in ec.crt -out ec.p12 -passout pass:x`);
    const ec = await importPfx(new Uint8Array(fs.readFileSync(path.join(dir, "ec.p12"))), "x");
    const der2 = await createSignature(data, ec);
    expect(await checkSignature(data, der2)).toMatchObject({ status: "valid", signer: "EC Person" });
  });
});
