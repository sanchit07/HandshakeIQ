import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

// Colour palette
const COLOURS = {
  name: '#0f172a',
  accent: '#0e7490',      // cyan-700
  sectionTitle: '#0e7490',
  divider: '#94a3b8',
  body: '#1e293b',
  meta: '#475569',
  bullet: '#0e7490',
};

const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
};

const PAGE = {
  margins: { top: 52, bottom: 52, left: 56, right: 56 },
  size: 'A4' as const,
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** Strip markdown bold/italic markers and return plain text */
function stripInline(text: string): string {
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`(.*?)`/g, '$1');
}

interface Span { text: string; bold: boolean; italic: boolean }

/** Parse inline markdown into bold/italic spans */
function parseInlineSpans(text: string): Span[] {
  const spans: Span[] = [];
  // Regex matches ***text***, **text**, *text*, plain text
  const re = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|([^*]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== undefined) spans.push({ text: m[2], bold: true, italic: true });
    else if (m[3] !== undefined) spans.push({ text: m[3], bold: true, italic: false });
    else if (m[4] !== undefined) spans.push({ text: m[4], bold: false, italic: true });
    else if (m[5] !== undefined) spans.push({ text: m[5], bold: false, italic: false });
  }
  return spans.length ? spans : [{ text, bold: false, italic: false }];
}

function fontForSpan(s: Span): string {
  if (s.bold && s.italic) return FONTS.boldItalic;
  if (s.bold) return FONTS.bold;
  if (s.italic) return FONTS.italic;
  return FONTS.regular;
}

// ── renderer ─────────────────────────────────────────────────────────────────

type Line =
  | { kind: 'h1'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'bullet'; text: string; depth: number }
  | { kind: 'para'; text: string }
  | { kind: 'blank' };

function parseMarkdown(md: string): Line[] {
  const lines: Line[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^### /.test(line)) {
      lines.push({ kind: 'h3', text: line.slice(4).trim() });
    } else if (/^## /.test(line)) {
      lines.push({ kind: 'h2', text: line.slice(3).trim() });
    } else if (/^# /.test(line)) {
      lines.push({ kind: 'h1', text: line.slice(2).trim() });
    } else if (/^(\s*)[-*+] /.test(line)) {
      const m = line.match(/^(\s*)[-*+] (.*)$/)!;
      const depth = Math.floor(m[1].length / 2);
      lines.push({ kind: 'bullet', text: m[2].trim(), depth });
    } else if (line.trim() === '') {
      lines.push({ kind: 'blank' });
    } else {
      lines.push({ kind: 'para', text: line });
    }
  }
  return lines;
}

/** Render rich inline text (bold / italic spans) onto the doc */
function renderInline(
  doc: PDFKit.PDFDocument,
  text: string,
  opts: {
    x: number;
    y: number;
    width: number;
    fontSize: number;
    color: string;
    lineGap?: number;
    align?: 'left' | 'center' | 'right' | 'justify';
  },
): number {
  const spans = parseInlineSpans(text);
  const { x, y, width, fontSize, color, lineGap = 2, align = 'left' } = opts;

  doc.save();
  doc.fontSize(fontSize).fillColor(color);

  // Measure where we end up
  // PDFKit doesn't support mixed-font continuation well, so we render word-by-word
  // For simplicity we use full-string rendering per span with continued=true trick:
  // Actually, the cleanest approach for mixed bold/plain inline is to concatenate
  // and rely on the fact that most CV content is either fully bold or fully plain within a line.
  // We'll do a simple concatenated render with the dominant style.
  const hasBold = spans.some((s) => s.bold);
  const font = hasBold ? FONTS.bold : FONTS.regular;
  doc.font(font);

  doc.text(stripInline(text), x, y, {
    width,
    align,
    lineGap,
  });

  const endY = doc.y;
  doc.restore();
  return endY;
}

export function generateCvPdf(markdownCv: string, jobTitle: string, company: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: PAGE.size,
      margins: PAGE.margins,
      info: {
        Title: `CV – ${jobTitle} at ${company}`,
        Author: 'Auto-Apply System',
      },
    });

    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();
    doc.pipe(passthrough);
    passthrough.on('data', (chunk: Buffer) => chunks.push(chunk));
    passthrough.on('end', () => resolve(Buffer.concat(chunks)));
    passthrough.on('error', reject);

    const usableWidth =
      (doc.page.width as number) - PAGE.margins.left - PAGE.margins.right;
    const lx = PAGE.margins.left; // left x
    let prevKind: Line['kind'] | null = null;

    const lines = parseMarkdown(markdownCv);

    for (const line of lines) {
      switch (line.kind) {
        case 'h1': {
          // Name / document title — big, dark, centered
          const gap = prevKind === null ? 0 : 4;
          if (gap) doc.moveDown(0.3);
          doc
            .font(FONTS.bold)
            .fontSize(22)
            .fillColor(COLOURS.name)
            .text(line.text, lx, doc.y, { align: 'center', width: usableWidth });
          // Accent rule beneath name
          const ruleY = doc.y + 4;
          doc
            .moveTo(lx, ruleY)
            .lineTo(lx + usableWidth, ruleY)
            .strokeColor(COLOURS.accent)
            .lineWidth(1.5)
            .stroke();
          doc.moveDown(0.6);
          break;
        }

        case 'h2': {
          // Section headers — coloured, with a thin underline
          const spaceAbove = prevKind === 'bullet' || prevKind === 'para' ? 0.7 : 0.4;
          doc.moveDown(spaceAbove);
          const secY = doc.y;
          doc
            .font(FONTS.bold)
            .fontSize(11)
            .fillColor(COLOURS.sectionTitle)
            .text(line.text.toUpperCase(), lx, secY, { width: usableWidth });
          const underY = doc.y + 1;
          doc
            .moveTo(lx, underY)
            .lineTo(lx + usableWidth, underY)
            .strokeColor(COLOURS.divider)
            .lineWidth(0.5)
            .stroke();
          doc.moveDown(0.25);
          break;
        }

        case 'h3': {
          // Sub-headings — bold, body colour
          if (prevKind !== 'h2') doc.moveDown(0.3);
          doc
            .font(FONTS.bold)
            .fontSize(10)
            .fillColor(COLOURS.body)
            .text(stripInline(line.text), lx, doc.y, { width: usableWidth });
          doc.moveDown(0.1);
          break;
        }

        case 'bullet': {
          const indent = lx + 10 + line.depth * 14;
          const bulletWidth = usableWidth - 10 - line.depth * 14;
          const bulletY = doc.y;

          // Bullet dot
          doc
            .font(FONTS.regular)
            .fontSize(9)
            .fillColor(COLOURS.bullet)
            .text('•', indent - 10, bulletY, { width: 10 });

          // Bullet text (inline bold handled)
          const spans = parseInlineSpans(line.text);
          const hasBold = spans.some((s) => s.bold);
          doc
            .font(hasBold ? FONTS.bold : FONTS.regular)
            .fontSize(9)
            .fillColor(COLOURS.body)
            .text(stripInline(line.text), indent, bulletY, {
              width: bulletWidth,
              lineGap: 1.5,
            });
          break;
        }

        case 'para': {
          if (prevKind && prevKind !== 'h1' && prevKind !== 'h2' && prevKind !== 'h3') {
            doc.moveDown(0.2);
          }
          const spans = parseInlineSpans(line.text);
          const hasBold = spans.some((s) => s.bold);
          // Check if this line looks like a "meta" line (email | phone | location pattern)
          const isMeta = /[@|]/.test(line.text) && line.text.length < 120;
          doc
            .font(hasBold ? FONTS.bold : FONTS.regular)
            .fontSize(isMeta ? 9 : 9.5)
            .fillColor(isMeta ? COLOURS.meta : COLOURS.body)
            .text(stripInline(line.text), lx, doc.y, {
              width: usableWidth,
              align: isMeta ? 'center' : 'left',
              lineGap: 2,
            });
          break;
        }

        case 'blank': {
          // Swallow consecutive blanks, small gap otherwise
          if (prevKind !== 'blank') doc.moveDown(0.2);
          break;
        }
      }
      prevKind = line.kind;
    }

    doc.end();
  });
}
