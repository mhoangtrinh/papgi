// Pick a replacement font for edited text when the PDF's own font can't be used
// (usually because it is a subset that only contains the letters already on the page).

export interface FontTraits {
  name: string; // as stored in the PDF, e.g. "ABCDEF+LMRoman10-Regular"
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

export interface Substitute {
  /** Font file in public/fonts (loaded on demand). */
  file: string;
  /** CSS font stack for the in-page editor. */
  css: string;
  /** Family used for the editor's @font-face. */
  family: string;
  bold: boolean;
  italic: boolean;
  /** A look-alike with the same letter widths (Latin Modern for TeX, Carlito for Calibri, Liberation for Arial...). */
  exact: boolean;
}

/** Drop the 6-letter subset tag: "ABCDEF+Calibri-Bold" -> "Calibri-Bold". */
export function cleanFontName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "");
}

export function isBoldName(n: string): boolean {
  return /bold|black|heavy|semibold|demi|cmbx|sfbx|-bx|bx\d|[-,]b$/i.test(n);
}

export function isItalicName(n: string): boolean {
  return /italic|oblique|slant|cmti|cmsl|cmmi|sfti|sfsl|-it\b|mathitalic|[-,]i$|bi$/i.test(n);
}

const MATH = /math|cmmi|cmsy|cmex/i;
const TEX = /^(lm|cm|sf|ec|tc|eu|texgyre|latinmodern)|lmroman|lmsans|lmmono|lmmath|cmr\d|cmbx|cmti|cmsl|cmmi|cmsy|cmss|cmtt|sfrm|sfss|sftt/i;

function pick(base: string, bold: boolean, italic: boolean, names: [string, string, string, string]): string {
  return `${base}${names[bold ? (italic ? 3 : 1) : italic ? 2 : 0]}`;
}

/** Choose the bundled font closest to the original. */
export function substituteFor(t: FontTraits): Substitute {
  const n = cleanFontName(t.name);
  const bold = t.bold || isBoldName(n);
  const italic = t.italic || isItalicName(n);

  if (TEX.test(n)) {
    if (/tt|mono|typewriter/i.test(n)) {
      return { file: italic ? "lmmono10-italic.otf" : "lmmono10-regular.otf", family: "papgi LM Mono", css: "'papgi LM Mono', 'Courier New', monospace", bold: false, italic, exact: true };
    }
    if (/ss|sans/i.test(n)) {
      return { file: pick("lmsans10-", bold, italic, ["regular.otf", "bold.otf", "oblique.otf", "boldoblique.otf"]), family: "papgi LM Sans", css: "'papgi LM Sans', Arial, sans-serif", bold, italic, exact: true };
    }
    return { file: pick("lmroman10-", bold, italic, ["regular.otf", "bold.otf", "italic.otf", "bolditalic.otf"]), family: "papgi LM Roman", css: "'papgi LM Roman', 'Times New Roman', serif", bold, italic, exact: !MATH.test(n) };
  }
  if (/calibri|carlito/i.test(n)) {
    return { file: pick("Carlito-", bold, italic, ["Regular.ttf", "Bold.ttf", "Italic.ttf", "BoldItalic.ttf"]), family: "papgi Carlito", css: "'papgi Carlito', Calibri, sans-serif", bold, italic, exact: true };
  }
  if (/cambria|caladea/i.test(n)) {
    return { file: pick("Caladea-", bold, italic, ["Regular.ttf", "Bold.ttf", "Italic.ttf", "BoldItalic.ttf"]), family: "papgi Caladea", css: "'papgi Caladea', Cambria, serif", bold, italic, exact: true };
  }
  const names: [string, string, string, string] = ["Regular.ttf", "Bold.ttf", "Italic.ttf", "BoldItalic.ttf"];
  if (t.mono || /courier|mono|consol|menlo|typewriter|code/i.test(n)) {
    return { file: pick("LiberationMono-", bold, italic, names), family: "papgi Mono", css: "'papgi Mono', 'Courier New', monospace", bold, italic, exact: /courier|liberation ?mono|nimbus ?mono/i.test(n) };
  }
  const sans = /arial|helvetica|sans|verdana|tahoma|segoe|roboto|inter\b|calibri|gill|futura|frutiger|myriad|lato|source ?sans|nunito|montserrat|poppins|ubuntu/i.test(n);
  const serif = /times|serif|roman|georgia|garamond|minion|palatino|book|century|cambria|charter|baskerville|caslon|utopia|bodoni/i.test(n);
  if (sans || (!serif && !t.serif)) {
    return { file: pick("LiberationSans-", bold, italic, names), family: "papgi Sans", css: "'papgi Sans', Arial, Helvetica, sans-serif", bold, italic, exact: /arial|helvetica|liberation ?sans|nimbus ?sans|arimo/i.test(n) };
  }
  return { file: pick("LiberationSerif-", bold, italic, names), family: "papgi Serif", css: "'papgi Serif', 'Times New Roman', serif", bold, italic, exact: /times|liberation ?serif|nimbus ?rom|tinos/i.test(n) };
}
