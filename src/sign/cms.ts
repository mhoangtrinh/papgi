// Signatures as PDF readers expect them (adbe.pkcs7.detached): a CMS SignedData over the
// signed bytes, with the signer's certificate(s). Made and checked with the browser's own
// cryptography (WebCrypto) through PKI.js.
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  commonName: "2.5.4.3",
  org: "2.5.4.10",
  email: "1.2.840.113549.1.9.1",
  rsa: "1.2.840.113549.1.1.1",
  ec: "1.2.840.10045.2.1",
};

/** A certificate and the key to sign with (the key never leaves the device). */
export interface Signer {
  cert: Uint8Array;
  /** Certificates up to the issuer, if any (included so others can check the chain). */
  chain: Uint8Array[];
  key: CryptoKey;
}

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Sign `data` (the signed bytes of the PDF); returns the DER to write into /Contents. */
export async function createSignature(data: Uint8Array, signer: Signer, when = new Date()): Promise<Uint8Array> {
  const cert = pkijs.Certificate.fromBER(buf(signer.cert));
  const chain = signer.chain.map((c) => pkijs.Certificate.fromBER(buf(c)));
  const digest = await crypto.subtle.digest("SHA-256", buf(data));
  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
            new pkijs.Attribute({ type: OID.signingTime, values: [new asn1js.UTCTime({ valueDate: when })] }),
            new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: digest })] }),
          ],
        }),
      }),
    ],
    certificates: [cert, ...chain],
  });
  await signedData.sign(signer.key, 0, "SHA-256", buf(data));
  const info = new pkijs.ContentInfo({ contentType: OID.signedData, content: signedData.toSchema(true) });
  return new Uint8Array(info.toSchema().toBER(false));
}

export type SigStatus = "valid" | "invalid" | "unknown";

export interface SigCheck {
  status: SigStatus;
  /** Who signed (the certificate's name), and their e-mail if it says. */
  signer: string;
  email: string;
  /** The certificate's issuer, and whether it signed itself (made by the signer). */
  issuer: string;
  selfSigned: boolean;
  /** When it was signed, per the signature (ms), 0 if it doesn't say. */
  time: number;
  /** Why it couldn't be checked or isn't valid. */
  problem: string;
}

/** A name from a certificate's subject or issuer. */
function nameOf(rdn: pkijs.RelativeDistinguishedNames, oid: string): string {
  const v = rdn.typesAndValues.find((t) => t.type === oid)?.value as { valueBlock?: { value?: string } } | undefined;
  return v?.valueBlock?.value ?? "";
}

/** Check a signature over `data` (DER of a CMS SignedData, any zeros after it are ignored). */
export async function checkSignature(data: Uint8Array, der: Uint8Array): Promise<SigCheck> {
  const out: SigCheck = { status: "unknown", signer: "", email: "", issuer: "", selfSigned: false, time: 0, problem: "" };
  try {
    const asn = asn1js.fromBER(buf(der));
    if (asn.offset === -1) throw new Error("not readable");
    const info = new pkijs.ContentInfo({ schema: asn.result });
    if (info.contentType !== OID.signedData) throw new Error("not a CMS signature");
    const sd = new pkijs.SignedData({ schema: info.content });
    const si = sd.signerInfos[0];
    const sid = si.sid as pkijs.IssuerAndSerialNumber;
    const certs = (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
    const cert = certs.find((c) => sid.serialNumber && c.serialNumber.isEqual(sid.serialNumber)) ?? certs[0];
    if (cert) {
      out.signer = nameOf(cert.subject, OID.commonName) || nameOf(cert.subject, OID.org);
      out.email = nameOf(cert.subject, OID.email);
      out.issuer = nameOf(cert.issuer, OID.commonName) || nameOf(cert.issuer, OID.org);
      out.selfSigned = cert.issuer.isEqual(cert.subject);
    }
    const time = si.signedAttrs?.attributes.find((a) => a.type === OID.signingTime)?.values[0] as asn1js.UTCTime | asn1js.GeneralizedTime | undefined;
    if (time) out.time = time.toDate().getTime();
    const r = await sd.verify({ signer: 0, data: buf(data), checkChain: false, extendedMode: true });
    out.status = r.signatureVerified ? "valid" : "invalid";
    if (!r.signatureVerified) out.problem = "The document was changed after it was signed, or the signature is broken.";
  } catch (e) {
    const msg = (e as { message?: string; resultMessage?: string })?.resultMessage ?? (e as Error)?.message ?? String(e);
    // (a wrong digest is a changed document; anything else couldn't be checked)
    if (/digest|signature verification/i.test(msg)) {
      out.status = "invalid";
      out.problem = "The document was changed after it was signed, or the signature is broken.";
    } else out.problem = `This signature couldn't be checked (${msg}).`;
  }
  return out;
}

// ---------- your own certificate ----------

const RSA: RsaHashedKeyGenParams = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

/** Make a certificate for signing, signed by itself (others see who signed, but nobody vouches for it). */
export async function makeSelfSigned(name: string, email: string, years = 5): Promise<Signer> {
  const keys = (await crypto.subtle.generateKey(RSA, false, ["sign", "verify"])) as CryptoKeyPair;
  const cert = new pkijs.Certificate();
  cert.version = 2;
  const serial = crypto.getRandomValues(new Uint8Array(12));
  serial[0] &= 0x7f;
  cert.serialNumber = new asn1js.Integer({ valueHex: serial.buffer });
  // (name and e-mail as two parts of the name, "CN=…, E=…")
  const dn = () => {
    const n = new pkijs.RelativeDistinguishedNames();
    n.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.commonName, value: new asn1js.Utf8String({ value: name }) }));
    if (email) n.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.email, value: new asn1js.IA5String({ value: email }) }));
    n.valueBeforeDecode = new asn1js.Sequence({ value: n.typesAndValues.map((t) => new asn1js.Set({ value: [t.toSchema()] })) }).toBER(false);
    return n;
  };
  cert.subject = dn();
  cert.issuer = dn();
  const now = new Date();
  cert.notBefore.value = new Date(now.getTime() - 60_000);
  const until = new Date(now);
  until.setFullYear(until.getFullYear() + years);
  cert.notAfter.value = until;
  // for signing (digital signature, non-repudiation); not a CA
  const usage = new asn1js.BitString({ valueHex: new Uint8Array([0xc0]).buffer, unusedBits: 6 });
  cert.extensions = [
    new pkijs.Extension({ extnID: "2.5.29.19", critical: true, extnValue: new pkijs.BasicConstraints({ cA: false }).toSchema().toBER(false), parsedValue: new pkijs.BasicConstraints({ cA: false }) }),
    new pkijs.Extension({ extnID: "2.5.29.15", critical: true, extnValue: usage.toBER(false) }),
  ];
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, "SHA-256");
  return { cert: new Uint8Array(cert.toSchema(true).toBER(false)), chain: [], key: keys.privateKey };
}

/** The name and e-mail in a certificate. */
export function certNames(der: Uint8Array): { name: string; email: string; issuer: string; until: number; selfSigned: boolean } {
  const c = pkijs.Certificate.fromBER(buf(der));
  return {
    name: nameOf(c.subject, OID.commonName) || nameOf(c.subject, OID.org),
    email: nameOf(c.subject, OID.email),
    issuer: nameOf(c.issuer, OID.commonName) || nameOf(c.issuer, OID.org),
    until: c.notAfter.value.getTime(),
    selfSigned: c.issuer.isEqual(c.subject),
  };
}

/**
 * Read a certificate file (.p12 / .pfx) with its password: the certificate with a private
 * key, and the others in the file as its chain.
 */
export async function importPfx(bytes: Uint8Array, password: string): Promise<Signer> {
  const pw = new TextEncoder().encode(password).buffer;
  const asn = asn1js.fromBER(buf(bytes));
  if (asn.offset === -1) throw new Error("This isn't a certificate file (.p12 or .pfx).");
  const pfx = new pkijs.PFX({ schema: asn.result });
  try {
    await pfx.parseInternalValues({ password: pw, checkIntegrity: true });
  } catch {
    throw new Error("Wrong password, or a file papgi can't read.");
  }
  const safe = pfx.parsedValue?.authenticatedSafe;
  if (!safe) throw new Error("This certificate file is empty.");
  try {
    await safe.parseInternalValues({ safeContents: safe.safeContents.map(() => ({ password: pw })) });
  } catch (e) {
    throw new Error(/algorithm|not supported|unsupported/i.test(String((e as Error)?.message ?? e)) ? "This certificate file uses an old kind of encryption papgi can't read. Export it again with AES encryption." : "Wrong password, or a file papgi can't read.");
  }
  const certs: pkijs.Certificate[] = [];
  let keyDer: ArrayBuffer | null = null;
  for (const sc of safe.parsedValue?.safeContents ?? []) {
    for (const bag of sc.value.safeBags) {
      if (bag.bagId === "1.2.840.113549.1.12.10.1.3") certs.push((bag.bagValue as pkijs.CertBag).parsedValue as pkijs.Certificate);
      else if (bag.bagId === "1.2.840.113549.1.12.10.1.2") {
        const shrouded = bag.bagValue as pkijs.PKCS8ShroudedKeyBag;
        await (shrouded as unknown as { parseInternalValues(p: { password: ArrayBuffer }): Promise<void> }).parseInternalValues({ password: pw });
        keyDer = shrouded.parsedValue!.toSchema().toBER(false);
      } else if (bag.bagId === "1.2.840.113549.1.12.10.1.1") keyDer = (bag.bagValue as pkijs.PrivateKeyInfo).toSchema().toBER(false);
    }
  }
  if (!keyDer) throw new Error("This file has no private key, so it can't sign.");
  if (!certs.length) throw new Error("This file has no certificate.");
  const pki = pkijs.PrivateKeyInfo.fromBER(keyDer);
  const alg = pki.privateKeyAlgorithm.algorithmId;
  let params: RsaHashedImportParams | EcKeyImportParams;
  if (alg === OID.rsa) params = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  else if (alg === OID.ec) {
    const curve = (pki.privateKeyAlgorithm.algorithmParams as asn1js.ObjectIdentifier)?.valueBlock.toString();
    const named = { "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384", "1.3.132.0.35": "P-521" }[curve ?? ""];
    if (!named) throw new Error("This key's kind isn't supported.");
    params = { name: "ECDSA", namedCurve: named };
  } else throw new Error("This key's kind isn't supported.");
  const key = await crypto.subtle.importKey("pkcs8", keyDer, params, false, ["sign"]);
  // the certificate that goes with the key: the one that isn't anyone's issuer (the end of the chain)
  const own = certs.find((c) => !certs.some((o) => o !== c && o.issuer.isEqual(c.subject))) ?? certs[0];
  return {
    cert: new Uint8Array(own.toSchema(true).toBER(false)),
    chain: certs.filter((c) => c !== own).map((c) => new Uint8Array(c.toSchema(true).toBER(false))),
    key,
  };
}
