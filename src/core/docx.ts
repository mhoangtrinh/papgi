// A small .docx (Word) writer: sections with page size, margins and columns; paragraphs
// with runs, tabs, line breaks and spacing; tables (spans, borders, shading); pictures
// inline, in the text, or placed on the page (behind the text or with text around them).
// Pure (no DOM), so it runs in the worker and in tests. Sizes are in points.
import { zip, type ZipEntry } from "./zip";

export interface DocxRun {
  /** Text; "\t" becomes a tab, "\n" a line break. */
  text: string;
  font?: string;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** "RRGGBB". */
  color?: string;
  vert?: "superscript" | "subscript";
  /** Extra space between letters (pt; negative = tighter). */
  spacing?: number;
  /** Background colour behind the letters ("RRGGBB"). */
  shade?: string;
  /** A picture in the line instead of text. */
  image?: DocxImage;
}

export interface DocxTab {
  pos: number;
  align?: "left" | "center" | "right" | "decimal";
}

interface BlockBase {
  align?: "left" | "center" | "right" | "both";
  /** Left / right indent (pt). */
  indLeft?: number;
  indRight?: number;
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
  /** Placed on the page at this spot (from the page's top-left corner). */
  anchor?: { x: number; y: number; wrap?: "none" | "square"; behind?: boolean };
  name?: string;
}

export interface DocxBorder {
  color: string;
  /** Line width (pt). */
  width: number;
}

export interface DocxCell {
  /** Grid columns this cell covers. */
  span?: number;
  /** Part of a cell that covers several rows: its first row ("restart") or one below. */
  vmerge?: "restart" | "continue";
  fill?: string;
  borders?: { top?: DocxBorder | null; left?: DocxBorder | null; bottom?: DocxBorder | null; right?: DocxBorder | null };
  valign?: "top" | "center" | "bottom";
  blocks: DocxBlock[];
}

export interface DocxTable extends BlockBase {
  kind: "table";
  /** Column widths (pt). */
  cols: number[];
  rows: { height?: number; cells: DocxCell[] }[];
  /** Space inside cells, left/right (pt). */
  pad?: number;
}

export type DocxBlock = DocxParagraph | DocxImage | DocxTable;

export interface DocxSection {
  width: number;
  height: number;
  margins: { top: number; right: number; bottom: number; left: number };
  /** Columns (widths and the space after each); one column if left out. */
  cols?: { w: number; space: number }[];
  /** How this section starts: on a new page (default) or right below the one before. */
  start?: "page" | "continuous";
  blocks: DocxBlock[];
  /** Page header and footer (text, without pictures), and their distance from the page edge (pt).
   *  Sections can share the same arrays (one part each). */
  header?: DocxBlock[];
  footer?: DocxBlock[];
  headerDist?: number;
  footerDist?: number;
}

export interface DocxOptions {
  title?: string;
  /** Default font and size of the document. */
  font?: string;
  size?: number;
  /** Language of the text ("en-US", "de-DE"…): spelling and hyphenation. */
  lang?: string;
  /** Let Word hyphenate words at line ends. */
  hyphenate?: boolean;
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const tw = (pt: number) => Math.round(pt * 20);
const emu = (pt: number) => Math.round(pt * 12700);

/** XML text: escaped, without characters XML can't hold. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDocx(sections: DocxSection[], opts: DocxOptions = {}): Uint8Array {
  const media: { name: string; data: Uint8Array; rel: string }[] = [];
  let drawId = 0;

  const imageXml = (im: DocxImage): string => {
    const id = ++drawId;
    const name = `image${id}.${im.type === "png" ? "png" : "jpeg"}`;
    const rel = `rIdImg${id}`;
    media.push({ name, data: im.data, rel });
    const cx = emu(Math.max(0.5, im.w));
    const cy = emu(Math.max(0.5, im.h));
    const graphic = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlText(im.name ?? name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
    const docPr = `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`;
    const a = im.anchor;
    if (a) {
      const square = a.wrap === "square";
      const behind = !square && a.behind !== false;
      const dist = square ? 'distT="0" distB="0" distL="57150" distR="57150"' : 'distT="0" distB="0" distL="0" distR="0"';
      const wrap = square ? '<wp:wrapSquare wrapText="bothSides"/>' : "<wp:wrapNone/>";
      return `<w:drawing><wp:anchor ${dist} simplePos="0" relativeHeight="${id}" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(a.x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(a.y)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}${docPr}${graphic}</wp:anchor></w:drawing>`;
    }
    return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${docPr}${graphic}</wp:inline></w:drawing>`;
  };

  const runXml = (r: DocxRun): string => {
    if (r.image) return `<w:r>${imageXml(r.image)}</w:r>`;
    const p: string[] = [];
    if (r.font) {
      const f = xmlText(r.font);
      p.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>`);
    }
    if (r.bold) p.push("<w:b/><w:bCs/>");
    if (r.italic) p.push("<w:i/><w:iCs/>");
    if (r.strike) p.push("<w:strike/>");
    if (r.color && r.color !== "000000") p.push(`<w:color w:val="${r.color}"/>`);
    if (r.spacing) p.push(`<w:spacing w:val="${tw(r.spacing)}"/>`);
    if (r.size) {
      const s = Math.max(2, Math.round(r.size * 2));
      p.push(`<w:sz w:val="${s}"/><w:szCs w:val="${s}"/>`);
    }
    if (r.underline) p.push('<w:u w:val="single"/>');
    if (r.shade) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${r.shade}"/>`);
    if (r.vert) p.push(`<w:vertAlign w:val="${r.vert}"/>`);
    const rpr = p.length ? `<w:rPr>${p.join("")}</w:rPr>` : "";
    const body = r.text
      .split(/(\t|\n)/)
      .map((t) => (t === "\t" ? "<w:tab/>" : t === "\n" ? "<w:br/>" : t ? `<w:t xml:space="preserve">${xmlText(t)}</w:t>` : ""))
      .join("");
    return `<w:r>${rpr}${body}</w:r>`;
  };

  const pPr = (b: BlockBase & { kind: string; heading?: number; keepNext?: boolean; tabs?: DocxTab[]; lineExact?: number; line?: number }, sect = ""): string => {
    const p: string[] = [];
    if (b.heading) p.push(`<w:pStyle w:val="Heading${Math.min(3, Math.max(1, b.heading))}"/>`);
    if (b.keepNext) p.push("<w:keepNext/>");
    if (b.tabs?.length) p.push(`<w:tabs>${b.tabs.map((t) => `<w:tab w:val="${t.align ?? "left"}" w:pos="${tw(t.pos)}"/>`).join("")}</w:tabs>`);
    const sp: string[] = [`w:before="${tw(Math.max(0, b.before ?? 0))}"`, 'w:after="0"'];
    if (b.lineExact) sp.push(`w:line="${Math.max(20, tw(b.lineExact))}" w:lineRule="exact"`);
    else if (b.line) sp.push(`w:line="${Math.max(20, tw(b.line))}" w:lineRule="atLeast"`);
    else if (b.kind === "img") sp.push('w:line="240" w:lineRule="auto"');
    p.push(`<w:spacing ${sp.join(" ")}/>`);
    const ind: string[] = [];
    if (b.indLeft) ind.push(`w:left="${tw(b.indLeft)}"`);
    if (b.indRight) ind.push(`w:right="${tw(b.indRight)}"`);
    if (b.indFirst) ind.push(b.indFirst > 0 ? `w:firstLine="${tw(b.indFirst)}"` : `w:hanging="${tw(-b.indFirst)}"`);
    if (ind.length) p.push(`<w:ind ${ind.join(" ")}/>`);
    if (b.align && b.align !== "left") p.push(`<w:jc w:val="${b.align}"/>`);
    return `<w:pPr>${p.join("")}${sect}</w:pPr>`;
  };

  const brk = '<w:r><w:br w:type="column"/></w:r>';
  /** A paragraph holding only small things (a column break, a picture placed on the page, space). */
  const tiny = (inner: string, sect = "", before = 0, height = 1) =>
    `<w:p>${pPr({ kind: "p", before, lineExact: height }, sect)}${inner}</w:p>`;

  const border = (side: string, b: DocxBorder | null | undefined) =>
    b ? `<w:${side} w:val="single" w:sz="${Math.max(2, Math.min(96, Math.round(b.width * 8)))}" w:space="0" w:color="${b.color}"/>` : `<w:${side} w:val="nil"/>`;

  const tableXml = (t: DocxTable): string => {
    const pad = tw(t.pad ?? 2);
    const grid = t.cols.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join("");
    const rows = t.rows
      .map((row) => {
        let col = 0;
        const cells = row.cells
          .map((c) => {
            const span = Math.max(1, c.span ?? 1);
            const w = t.cols.slice(col, col + span).reduce((a, b) => a + b, 0);
            col += span;
            const pr: string[] = [`<w:tcW w:w="${tw(w)}" w:type="dxa"/>`];
            if (span > 1) pr.push(`<w:gridSpan w:val="${span}"/>`);
            if (c.vmerge) pr.push(c.vmerge === "restart" ? '<w:vMerge w:val="restart"/>' : "<w:vMerge/>");
            const b = c.borders ?? {};
            pr.push(`<w:tcBorders>${border("top", b.top)}${border("left", b.left)}${border("bottom", b.bottom)}${border("right", b.right)}</w:tcBorders>`);
            if (c.fill) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${c.fill}"/>`);
            if (c.valign && c.valign !== "top") pr.push(`<w:vAlign w:val="${c.valign}"/>`);
            const inner = c.blocks.length && c.vmerge !== "continue" ? c.blocks.map((x) => blockXml(x)).join("") : tiny("");
            // (a cell must end with a paragraph)
            const end = c.blocks[c.blocks.length - 1]?.kind === "table" ? tiny("") : "";
            return `<w:tc><w:tcPr>${pr.join("")}</w:tcPr>${inner}${end}</w:tc>`;
          })
          .join("");
        const h = row.height ? `<w:trPr><w:cantSplit/><w:trHeight w:val="${tw(row.height)}" w:hRule="atLeast"/></w:trPr>` : "";
        return `<w:tr>${h}${cells}</w:tr>`;
      })
      .join("");
    const width = t.cols.reduce((a, b) => a + b, 0);
    const ind = `<w:tblInd w:w="${tw((t.indLeft ?? t.pad ?? 2) - (t.pad ?? 2))}" w:type="dxa"/>`;
    return `<w:tbl><w:tblPr><w:tblW w:w="${tw(width)}" w:type="dxa"/>${ind}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${pad}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="${pad}" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
  };

  const blockXml = (b: DocxBlock, sect = ""): string => {
    const lead = b.colBreak ? brk : "";
    if (b.kind === "table") {
      // space before and column breaks go into a small paragraph above the table
      const pre = lead || (b.before ?? 0) > 0.5 ? tiny(lead, "", 0, Math.max(1, b.before ?? 0)) : "";
      return pre + tableXml(b) + (sect ? tiny("", sect) : "");
    }
    if (b.kind === "img") {
      if (b.anchor) return tiny(`${lead}<w:r><w:rPr><w:sz w:val="2"/></w:rPr>${imageXml(b)}</w:r>`, sect, b.before ?? 0);
      return `<w:p>${pPr(b, sect)}${lead}<w:r>${imageXml(b)}</w:r></w:p>`;
    }
    return `<w:p>${pPr(b, sect)}${lead}${b.runs.map(runXml).join("")}</w:p>`;
  };

  // header and footer parts
  const parts: { name: string; rel: string; kind: "header" | "footer"; xml: string }[] = [];
  const partOf = new Map<DocxBlock[], string>();
  const part = (blocks: DocxBlock[], kind: "header" | "footer"): string => {
    let rel = partOf.get(blocks);
    if (!rel) {
      const n = parts.length + 1;
      rel = `rIdHf${n}`;
      const tag = kind === "header" ? "w:hdr" : "w:ftr";
      const inner = blocks.length ? blocks.map((b) => blockXml(b)).join("") : tiny("");
      const last = blocks[blocks.length - 1];
      parts.push({ name: `${kind}${n}.xml`, rel, kind, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${tag} ${W_NS}>${inner}${last?.kind === "table" ? tiny("") : ""}</${tag}>` });
      partOf.set(blocks, rel);
    }
    return rel;
  };

  const sectPr = (s: DocxSection, first: boolean): string => {
    const m = s.margins;
    const refs = (s.header ? `<w:headerReference w:type="default" r:id="${part(s.header, "header")}"/>` : "") + (s.footer ? `<w:footerReference w:type="default" r:id="${part(s.footer, "footer")}"/>` : "");
    const cols =
      s.cols && s.cols.length > 1
        ? `<w:cols w:num="${s.cols.length}" w:equalWidth="0">${s.cols.map((c, i) => `<w:col w:w="${tw(c.w)}"${i < s.cols!.length - 1 ? ` w:space="${tw(c.space)}"` : ""}/>`).join("")}</w:cols>`
        : '<w:cols w:space="720"/>';
    const type = !first && s.start === "continuous" ? '<w:type w:val="continuous"/>' : "";
    return `<w:sectPr>${refs}${type}<w:pgSz w:w="${tw(s.width)}" w:h="${tw(s.height)}"${s.width > s.height ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.right)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.left)}" w:header="${tw(s.headerDist ?? 0)}" w:footer="${tw(s.footerDist ?? 0)}" w:gutter="0"/>${cols}</w:sectPr>`;
  };

  const body: string[] = [];
  sections.forEach((s, si) => {
    const last = si === sections.length - 1;
    const blocks: DocxBlock[] = s.blocks.length ? s.blocks : [{ kind: "p", runs: [] }];
    blocks.forEach((b, bi) => {
      // a section's settings go into its last paragraph (the last section's into the body)
      const sect = !last && bi === blocks.length - 1 ? sectPr(s, si === 0) : "";
      body.push(blockXml(b, sect));
    });
    if (last) body.push(sectPr(s, si === 0));
  });

  const font = xmlText(opts.font ?? "Calibri");
  const size = Math.round((opts.size ?? 11) * 2);
  const lang = xmlText(opts.lang ?? "en-US");
  const heading = (n: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="${lang}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>${heading(1)}${heading(2)}${heading(3)}</w:styles>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body.join("")}</w:body></w:document>`;

  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${parts.map((p) => `<Override PartName="/word/${p.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${p.kind}+xml"/>`).join("")}</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${media
    .map((m) => `<Relationship Id="${m.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`)
    .join("")}${parts.map((p) => `<Relationship Id="${p.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${p.kind}" Target="${p.name}"/>`).join("")}</Relationships>`;
  const hyph = opts.hyphenate ? '<w:autoHyphenation/><w:consecutiveHyphenLimit w:val="0"/><w:hyphenationZone w:val="284"/>' : "";
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/>${hyph}<w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
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
    ...parts.map((p) => ({ name: `word/${p.name}`, bytes: enc.encode(p.xml) })),
    ...media.map((m) => ({ name: `word/media/${m.name}`, bytes: m.data })),
  ];
  return zip(entries, new Date(), true);
}
