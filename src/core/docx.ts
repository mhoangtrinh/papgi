// A small .docx (Word) writer: sections with page size, margins and columns; paragraphs
// with runs, tabs and spacing; pictures inline or placed on the page. Pure (no DOM), so
// it runs in the worker and in tests. Sizes are in points.
import { zip, type ZipEntry } from "./zip";

export interface DocxRun {
  /** Text; "\t" becomes a tab. */
  text: string;
  font?: string;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** "RRGGBB". */
  color?: string;
  vert?: "superscript" | "subscript";
}

export interface DocxTab {
  pos: number;
  align?: "left" | "center" | "right" | "decimal";
}

interface BlockBase {
  align?: "left" | "center" | "right" | "both";
  /** Left indent (pt). */
  indLeft?: number;
  /** First-line indent (pt); negative = hanging. */
  indFirst?: number;
  /** Space before (pt). */
  before?: number;
  /** Starts in the next column. */
  colBreak?: boolean;
}

export interface DocxParagraph extends BlockBase {
  kind: "p";
  runs: DocxRun[];
  /** Line height at least this (pt). */
  line?: number;
  /** Exact line height (pt); wins over `line`. */
  lineExact?: number;
  tabs?: DocxTab[];
  /** Outline level 1-3 (Heading 1-3 style; shows in Word's navigation pane). */
  heading?: number;
  keepNext?: boolean;
}

export interface DocxImage extends BlockBase {
  kind: "img";
  data: Uint8Array;
  type: "png" | "jpeg";
  /** Shown size (pt). */
  w: number;
  h: number;
  /** Placed on the page at this spot (from the page's top-left corner), behind the text. */
  anchor?: { x: number; y: number };
  name?: string;
}

export type DocxBlock = DocxParagraph | DocxImage;

export interface DocxSection {
  width: number;
  height: number;
  margins: { top: number; right: number; bottom: number; left: number };
  /** Columns (widths and the space after each); one column if left out. */
  cols?: { w: number; space: number }[];
  /** How this section starts: on a new page (default) or right below the one before. */
  start?: "page" | "continuous";
  blocks: DocxBlock[];
}

export interface DocxOptions {
  title?: string;
  /** Default font and size of the document. */
  font?: string;
  size?: number;
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const tw = (pt: number) => Math.round(pt * 20);
const emu = (pt: number) => Math.round(pt * 12700);

/** XML text: escaped, without characters XML can't hold. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      "",
    )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDocx(
  sections: DocxSection[],
  opts: DocxOptions = {},
): Uint8Array {
  const media: { name: string; data: Uint8Array; rel: string }[] = [];
  let drawId = 0;

  const runXml = (r: DocxRun): string => {
    const p: string[] = [];
    if (r.font) {
      const f = xmlText(r.font);
      p.push(
        `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>`,
      );
    }
    if (r.bold) p.push("<w:b/><w:bCs/>");
    if (r.italic) p.push("<w:i/><w:iCs/>");
    if (r.color && r.color !== "000000")
      p.push(`<w:color w:val="${r.color}"/>`);
    if (r.size)
      p.push(
        `<w:sz w:val="${Math.max(2, Math.round(r.size * 2))}"/><w:szCs w:val="${Math.max(2, Math.round(r.size * 2))}"/>`,
      );
    if (r.underline) p.push('<w:u w:val="single"/>');
    if (r.vert) p.push(`<w:vertAlign w:val="${r.vert}"/>`);
    const rpr = p.length ? `<w:rPr>${p.join("")}</w:rPr>` : "";
    const parts = r.text.split("\t");
    const body = parts
      .map(
        (t, i) =>
          (i ? "<w:tab/>" : "") +
          (t ? `<w:t xml:space="preserve">${xmlText(t)}</w:t>` : ""),
      )
      .join("");
    return `<w:r>${rpr}${body}</w:r>`;
  };

  const pPr = (b: BlockBase & Partial<DocxParagraph>, sect = ""): string => {
    const p: string[] = [];
    if (b.kind === "p" && b.heading)
      p.push(
        `<w:pStyle w:val="Heading${Math.min(3, Math.max(1, b.heading))}"/>`,
      );
    if (b.kind === "p" && b.keepNext) p.push("<w:keepNext/>");
    if (b.kind === "p" && b.tabs?.length)
      p.push(
        `<w:tabs>${b.tabs.map((t) => `<w:tab w:val="${t.align ?? "left"}" w:pos="${tw(t.pos)}"/>`).join("")}</w:tabs>`,
      );
    const sp: string[] = [
      `w:before="${tw(Math.max(0, b.before ?? 0))}"`,
      'w:after="0"',
    ];
    if (b.kind === "p" && b.lineExact)
      sp.push(`w:line="${Math.max(20, tw(b.lineExact))}" w:lineRule="exact"`);
    else if (b.kind === "p" && b.line)
      sp.push(`w:line="${Math.max(20, tw(b.line))}" w:lineRule="atLeast"`);
    else if ((b as { kind?: string }).kind === "img")
      sp.push('w:line="240" w:lineRule="auto"');
    p.push(`<w:spacing ${sp.join(" ")}/>`);
    const ind: string[] = [];
    if (b.indLeft) ind.push(`w:left="${tw(b.indLeft)}"`);
    if (b.indFirst)
      ind.push(
        b.indFirst > 0
          ? `w:firstLine="${tw(b.indFirst)}"`
          : `w:hanging="${tw(-b.indFirst)}"`,
      );
    if (ind.length) p.push(`<w:ind ${ind.join(" ")}/>`);
    if (b.align && b.align !== "left") p.push(`<w:jc w:val="${b.align}"/>`);
    return `<w:pPr>${p.join("")}${sect}</w:pPr>`;
  };

  const imageXml = (im: DocxImage): string => {
    const id = ++drawId;
    const name = `image${id}.${im.type === "png" ? "png" : "jpeg"}`;
    const rel = `rIdImg${id}`;
    media.push({ name, data: im.data, rel });
    const cx = emu(im.w);
    const cy = emu(im.h);
    const graphic = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlText(im.name ?? name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
    const docPr = `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`;
    if (im.anchor)
      return `<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(im.anchor.x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(im.anchor.y)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>${docPr}${graphic}</wp:anchor></w:drawing>`;
    return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${docPr}${graphic}</wp:inline></w:drawing>`;
  };

  const sectPr = (s: DocxSection, first: boolean): string => {
    const m = s.margins;
    const cols =
      s.cols && s.cols.length > 1
        ? `<w:cols w:num="${s.cols.length}" w:equalWidth="0">${s.cols.map((c, i) => `<w:col w:w="${tw(c.w)}"${i < s.cols!.length - 1 ? ` w:space="${tw(c.space)}"` : ""}/>`).join("")}</w:cols>`
        : '<w:cols w:space="720"/>';
    const type =
      !first && s.start === "continuous" ? '<w:type w:val="continuous"/>' : "";
    return `<w:sectPr>${type}<w:pgSz w:w="${tw(s.width)}" w:h="${tw(s.height)}"${s.width > s.height ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.right)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.left)}" w:header="0" w:footer="0" w:gutter="0"/>${cols}</w:sectPr>`;
  };

  const brk = '<w:r><w:br w:type="column"/></w:r>';
  const body: string[] = [];
  sections.forEach((s, si) => {
    const last = si === sections.length - 1;
    const blocks: DocxBlock[] = s.blocks.length
      ? s.blocks
      : [{ kind: "p", runs: [] }];
    blocks.forEach((b, bi) => {
      // a section's settings go into its last paragraph (the last section's into the body)
      const sect = !last && bi === blocks.length - 1 ? sectPr(s, si === 0) : "";
      const lead = b.colBreak ? brk : "";
      if (b.kind === "img") {
        const host = b.anchor
          ? { ...b, kind: "p" as const, runs: [], lineExact: 1 }
          : b;
        body.push(
          `<w:p>${pPr(host as DocxParagraph, sect)}${lead}<w:r>${b.anchor ? '<w:rPr><w:sz w:val="2"/></w:rPr>' : ""}${imageXml(b)}</w:r></w:p>`,
        );
      } else {
        body.push(
          `<w:p>${pPr(b, sect)}${lead}${b.runs.map(runXml).join("")}</w:p>`,
        );
      }
    });
    if (last) body.push(sectPr(s, si === 0));
  });

  const font = xmlText(opts.font ?? "Calibri");
  const size = Math.round((opts.size ?? 11) * 2);
  const heading = (n: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>${heading(1)}${heading(2)}${heading(3)}</w:styles>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body.join("")}</w:body></w:document>`;

  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${media
    .map(
      (m) =>
        `<Relationship Id="${m.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`,
    )
    .join("")}</Relationships>`;
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(opts.title ?? "")}</dc:title><dc:creator>papgi</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>papgi</Application></Properties>`;

  const enc = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", bytes: enc.encode(types) },
    { name: "_rels/.rels", bytes: enc.encode(rels) },
    { name: "word/document.xml", bytes: enc.encode(document) },
    { name: "word/_rels/document.xml.rels", bytes: enc.encode(docRels) },
    { name: "word/styles.xml", bytes: enc.encode(styles) },
    { name: "word/settings.xml", bytes: enc.encode(settings) },
    { name: "docProps/core.xml", bytes: enc.encode(core) },
    { name: "docProps/app.xml", bytes: enc.encode(app) },
    ...media.map((m) => ({ name: `word/media/${m.name}`, bytes: m.data })),
  ];
  return zip(entries, new Date(), true);
}
