import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createSignature, checkSignature, makeSelfSigned, importPfx, certNames } from "../src/sign/cms";

const has = (cmd: string) => {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("signatures (CMS)", () => {
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
