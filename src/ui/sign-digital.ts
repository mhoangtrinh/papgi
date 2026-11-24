// "Sign digitally…": who signs (a certificate kept on this device: made here, or from a
// .p12/.pfx file), in which signature box, and why. Also the list of signatures in a PDF.
import { lang, t } from "../i18n";
import { importPfx, makeSelfSigned } from "../sign/cms";
import { addIdentity, listIdentities, removeIdentity, type Identity } from "../sign/identities";
import type { SigReport } from "../sign/signpdf";
import { confirmDialog, modal, toast } from "./dialogs";
import { esc, form, no, remember } from "./doc-tools";
import { icon } from "./icons";

export interface SignBox {
  page: number;
  widget: number;
  name: string;
}

export interface SignChoice {
  identity: Identity;
  field: { page: number; widget: number } | null;
  reason: string;
  location: string;
}

const last = remember("signing", { id: "", reason: "", location: "" });

const date = (ms: number) => new Date(ms).toLocaleDateString(lang === "de" ? "de-DE" : undefined, { dateStyle: "medium" });

function idRow(i: Identity, on: boolean): string {
  const who = i.selfSigned ? t("Your own certificate") : `${t("Issued by")} ${esc(i.issuer)}`;
  const old = i.until < Date.now();
  return `<label class="sd-id${on ? " on" : ""}"><input type="radio" name="sd-id" value="${i.id}" ${on ? "checked" : ""}>
    <span class="sd-id-text"><b translate="no">${esc(i.name)}</b>${i.email ? ` <span class="muted" translate="no">${esc(i.email)}</span>` : ""}<br><span class="muted small">${who} · ${old ? `<span class="sd-bad">${t("expired")} ${date(i.until)}</span>` : `${t("valid until")} ${date(i.until)}`}</span></span>
    <button type="button" class="icon-btn sm" data-v="remove:${i.id}" title="Remove from this device">${icon("trash")}</button></label>`;
}

/** Ask who signs, where and why. `boxes`: the empty signature boxes. */
export async function signDialog(boxes: SignBox[], author: string, warn: string): Promise<SignChoice | null> {
  let state = { ...last.get(), field: boxes.length ? "0" : "none" };
  for (;;) {
    const ids = await listIdentities();
    if (!ids.some((i) => i.id === state.id)) state.id = ids[0]?.id ?? "";
    const html =
      `<div class="sd-section"><div class="sd-label">Who signs</div>` +
      (ids.length ? `<div class="sd-ids">${ids.map((i) => idRow(i, i.id === state.id)).join("")}</div>` : `<p class="muted">No certificate on this device yet.</p>`) +
      `<div class="sd-add"><button type="button" class="btn small" data-v="own">${icon("plus")}Make my own…</button><button type="button" class="btn small" data-v="import">${icon("open")}Use a certificate file…</button></div></div>` +
      `<label class="dt-row"><span>Where</span><select class="field" data-k="field">${boxes.map((b, k) => `<option value="${k}" ${state.field === String(k) ? "selected" : ""}>${t("Signature box")} „${esc(b.name)}“ · ${t("page")} ${b.page + 1}</option>`).join("")}<option value="none" ${state.field === "none" ? "selected" : ""}>Not shown on a page</option></select></label>` +
      (boxes.length ? "" : `<p class="muted dt-note">To show the signature on a page, first add a signature box there with the Form tool (F).</p>`) +
      `<label class="dt-row"><span>Reason</span><input class="field" data-k="reason" maxlength="120" placeholder="optional, e.g. I agree" value="${esc(state.reason)}"></label>` +
      `<label class="dt-row"><span>Place</span><input class="field" data-k="location" maxlength="80" placeholder="optional, e.g. Aachen" value="${esc(state.location)}"></label>` +
      `<p class="muted dt-note">${warn ? `<b>${warn}</b> ` : ""}The signed PDF is saved as a new file. Any later change to it makes the signature invalid.</p>`;
    const read = (root: HTMLElement) => ({
      id: root.querySelector<HTMLInputElement>('input[name="sd-id"]:checked')?.value ?? state.id,
      field: root.querySelector<HTMLSelectElement>('[data-k="field"]')!.value,
      reason: root.querySelector<HTMLInputElement>('[data-k="reason"]')!.value.trim(),
      location: root.querySelector<HTMLInputElement>('[data-k="location"]')!.value.trim(),
    });
    const r = await form(
      "Sign digitally",
      html,
      "Sign and save",
      (root) => {
        root.addEventListener("change", (e) => {
          const el = e.target as HTMLInputElement;
          if (el.name === "sd-id") root.querySelectorAll(".sd-id").forEach((l) => l.classList.toggle("on", l.contains(el)));
        });
      },
      (root, action) => {
        const v = read(root);
        if (action === "ok" && !ids.some((i) => i.id === v.id)) return no("Choose who signs, or make a certificate first");
        return v;
      },
    );
    if (!r) return null;
    state = r.value;
    if (r.action === "ok") {
      last.set({ id: state.id, reason: state.reason, location: state.location });
      const b = state.field === "none" ? null : boxes[Number(state.field)];
      return { identity: ids.find((i) => i.id === state.id)!, field: b ? { page: b.page, widget: b.widget } : null, reason: state.reason, location: state.location };
    }
    try {
      if (r.action === "own") {
        const made = await ownDialog(author);
        if (made) state.id = made.id;
      } else if (r.action === "import") {
        const got = await importDialog();
        if (got) state.id = got.id;
      } else if (r.action.startsWith("remove:")) {
        const id = r.action.slice(7);
        const who = ids.find((i) => i.id === id);
        if (who && (await confirmDialog("Remove this certificate?", `${who.name}: ${t("papgi forgets it on this device. Signatures already made stay valid.")}`, "Remove", true))) await removeIdentity(id);
      }
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
}

/** Make a certificate of your own (signed by itself). */
async function ownDialog(author: string): Promise<Identity | null> {
  const r = await form(
    "Make my own certificate",
    `<label class="dt-row"><span>Name</span><input class="field" data-k="name" maxlength="80" autocomplete="name" value="${esc(author)}"></label>` +
      `<label class="dt-row"><span>E-mail</span><input class="field" data-k="email" type="email" maxlength="120" autocomplete="email" placeholder="optional"></label>` +
      `<p class="muted dt-note">Made on this device and kept here; valid for 5 years. Apps like Acrobat show who signed and that the PDF wasn't changed since, but say nobody confirmed the name: that needs a certificate from a trust service (use it with “Use a certificate file”).</p>`,
    "Make certificate",
    () => {},
    (root) => {
      const name = root.querySelector<HTMLInputElement>('[data-k="name"]')!.value.trim();
      const email = root.querySelector<HTMLInputElement>('[data-k="email"]')!.value.trim();
      if (!name) return no("Type your name");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return no("That e-mail address doesn't look right");
      return { name, email };
    },
  );
  if (!r) return null;
  return addIdentity(await makeSelfSigned(r.value.name, r.value.email));
}

/** Use a certificate from a .p12 / .pfx file (it stays on this device). */
async function importDialog(): Promise<Identity | null> {
  let file: File | null = null;
  const r = await form(
    "Use a certificate file",
    `<label class="dt-row"><span>File</span><input class="field" type="file" data-k="file" accept=".p12,.pfx,application/x-pkcs12"></label>` +
      `<label class="dt-row"><span>Password</span><input class="field" type="password" data-k="pw" autocomplete="off"></label>` +
      `<p class="muted dt-note">A .p12 or .pfx file with your certificate and its private key (exported from your certificate provider, Windows or macOS Keychain). The key is kept on this device and can't be read back out.</p>`,
    "Add",
    (root) => root.querySelector<HTMLInputElement>('[data-k="file"]')!.addEventListener("change", (e) => (file = (e.target as HTMLInputElement).files?.[0] ?? null)),
    (root) => (file ? { pw: root.querySelector<HTMLInputElement>('[data-k="pw"]')!.value } : no("Choose the certificate file")),
  );
  if (!r || !file) return null;
  const signer = await importPfx(new Uint8Array(await (file as File).arrayBuffer()), r.value.pw);
  return addIdentity(signer);
}

/** The signatures in a PDF, checked. */
export async function showSignatures(list: SigReport[], changed: boolean): Promise<void> {
  const when = (ms: number) => (ms ? new Date(ms).toLocaleString(lang === "de" ? "de-DE" : undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
  const rows = list
    .map((s) => {
      const ok = s.status === "valid";
      const state = ok ? (s.whole ? t("Valid. The PDF wasn't changed since it was signed.") : t("Valid for the PDF as it was signed; something was added to it later.")) : s.status === "invalid" ? t(s.problem) : t(s.problem || "This signature couldn't be checked.");
      const who = s.selfSigned ? t("The signer made this certificate themselves: nobody confirmed the name.") : s.issuer ? `${t("Certificate issued by")} ${esc(s.issuer)} (${t("not checked against a list of trusted issuers")}).` : "";
      return `<div class="sd-sig ${ok ? (s.whole ? "ok" : "warn") : s.status === "invalid" ? "bad" : "warn"}">
        <div class="sd-sig-icon">${icon(ok ? "check" : "close")}</div>
        <div><b translate="no">${esc(s.signer || s.info.name || t("Unknown signer"))}</b>${s.email ? ` <span class="muted" translate="no">${esc(s.email)}</span>` : ""}
        <div class="small">${when(s.time)}${s.info.page >= 0 ? ` · ${t("page")} ${s.info.page + 1}` : ` · ${t("not shown on a page")}`}${s.info.reason ? ` · <span translate="no">${esc(s.info.reason)}</span>` : ""}</div>
        <div class="small">${state}</div>${who ? `<div class="small muted">${who}</div>` : ""}</div></div>`;
    })
    .join("");
  const note = changed ? `<p class="dt-note"><b>${t("You changed this PDF: saving it will make these signatures invalid.")}</b></p>` : "";
  await modal({ title: list.length === 1 ? "Digital signature" : "Digital signatures", body: `<div class="dt">${rows}${note}</div>`, actions: [{ label: "Close", value: "", primary: true }], wide: true });
}
