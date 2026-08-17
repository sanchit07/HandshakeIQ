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
  /** Visual margins that define the readable area of the page. */
  margins: { top: 52, bottom: 52, left: 56, right: 56 },
  size: 'A4' as const,
};

/**
 * Points reserved at the bottom of each page for the page-number strip.
 * The PDFDocument is constructed with its bottom margin expanded by this
 * amount so PDFKit's own auto-page-break logic never lets content enter
 * the footer zone, regardless of block size.
 */
const FOOTER_HEIGHT = 16;

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

/**
 * Measure the rendered height of a content block using PDFKit's own
 * `heightOfString`.  The function temporarily sets the document font/size to
 * match the block's eventual render settings so the measurement is accurate
 * for proportional fonts, bold text, and wrapping.
 *
 * Callers must set the font/size they need for rendering *after* calling this
 * (the font state is left in the state of the last measured block).
 */
function measureBlock(
  doc: PDFKit.PDFDocument,
  line: Line,
  usableWidth: number,
): number {
  switch (line.kind) {
    case 'h2': {
      doc.font(FONTS.bold).fontSize(11);
      // height of string + gap below for the divider line + moveDown(0.25)
      return doc.heightOfString(line.text.toUpperCase(), { width: usableWidth }) + 8;
    }
    case 'h3': {
      doc.font(FONTS.bold).fontSize(10);
      return doc.heightOfString(stripInline(line.text), { width: usableWidth }) + 4;
    }
    case 'bullet': {
      const bulletWidth = usableWidth - 10 - line.depth * 14;
      const spans = parseInlineSpans(line.text);
      const hasBold = spans.some((s) => s.bold);
      doc.font(hasBold ? FONTS.bold : FONTS.regular).fontSize(9);
      return doc.heightOfString(stripInline(line.text), {
        width: bulletWidth,
        lineGap: 1.5,
      });
    }
    case 'para': {
      const isMeta = /[@|]/.test(line.text) && line.text.length < 120;
      const fontSize = isMeta ? 9 : 9.5;
      const spans = parseInlineSpans(line.text);
      const hasBold = spans.some((s) => s.bold);
      doc.font(hasBold ? FONTS.bold : FONTS.regular).fontSize(fontSize);
      return doc.heightOfString(stripInline(line.text), {
        width: usableWidth,
        lineGap: 2,
      });
    }
    default:
      return 0;
  }
}

/**
 * Sum the measured heights of the next `count` non-blank content lines
 * starting from index `from` in the `lines` array.  Used by h2/h3 look-ahead
 * to ensure a header always has meaningful content following it on the same page.
 */
function measureFollowingContent(
  doc: PDFKit.PDFDocument,
  lines: Line[],
  from: number,
  count: number,
  usableWidth: number,
): number {
  let total = 0;
  let found = 0;
  for (let j = from; j < lines.length && found < count; j++) {
    const l = lines[j];
    if (l.kind === 'blank') continue;
    total += measureBlock(doc, l, usableWidth);
    found++;
  }
  return total;
}

/**
 * How many points remain on the current page before PDFKit's auto-break
 * boundary (which already accounts for FOOTER_HEIGHT via the expanded margin).
 */
function remainingSpace(doc: PDFKit.PDFDocument): number {
  const maxY = (doc.page.height as number) - (doc.page.margins.bottom as number);
  return Math.max(0, maxY - doc.y);
}

/**
 * If fewer than `needed` points remain on the current page, add a new page
 * so the content block starts fresh.
 */
function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  if (remainingSpace(doc) < needed) {
    doc.addPage();
  }
}

export function generateCvPdf(markdownCv: string, jobTitle: string, company: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    /**
     * Bottom margin is expanded by FOOTER_HEIGHT so PDFKit's own auto-flow
     * never lets any content block enter the footer strip, regardless of
     * block size.
     */
    const expandedBottomMargin = PAGE.margins.bottom + FOOTER_HEIGHT;

    const doc = new PDFDocument({
      size: PAGE.size,
      margins: { ...PAGE.margins, bottom: expandedBottomMargin },
      /**
       * bufferPages MUST be true so switchToPage() works when stamping footers.
       * Without it PDFKit flushes past pages and switchToPage throws.
       */
      bufferPages: true,
      info: {
        // Some parsers read PDF metadata: put the candidate name (first h1
        // line of the CV) in Title/Author rather than tool branding.
        // NOTE: an explicitly-undefined key (e.g. Author: undefined) corrupts
        // pdfkit's info merge and crashes document creation — omit instead.
        Title: (markdownCv.match(/^#\s+(.+)$/m)?.[1] ?? `CV - ${jobTitle}`).trim(),
        ...((markdownCv.match(/^#\s+(.+)$/m)?.[1] ?? '').trim()
          ? { Author: (markdownCv.match(/^#\s+(.+)$/m)![1]).trim() }
          : {}),
        Subject: `CV - ${jobTitle} at ${company}`,
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
    const lx = PAGE.margins.left;
    let prevKind: Line['kind'] | null = null;

    const lines = parseMarkdown(markdownCv);

    // Use an indexed loop so h2/h3 can look ahead at following content.
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      switch (line.kind) {
        case 'h1': {
          const gap = prevKind === null ? 0 : 4;
          if (gap) doc.moveDown(0.3);
          doc
            .font(FONTS.bold)
            .fontSize(22)
            .fillColor(COLOURS.name)
            // Left-aligned: ATS parsers read top-left first and some treat
            // centered text blocks as decoration rather than the candidate name.
            .text(line.text, lx, doc.y, { align: 'left', width: usableWidth });
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
          /**
           * Widow/orphan prevention — look ahead at the next 3 non-blank
           * content lines and measure their actual rendered heights using
           * PDFKit's heightOfString with the correct font for each block.
           * This ensures the break decision accounts for multi-line bullets
           * and bold paragraphs rather than relying on a fixed estimate.
           */
          const spaceAbove = prevKind === 'bullet' || prevKind === 'para' ? 0.7 : 0.4;

          // Measure the h2 header itself
          doc.font(FONTS.bold).fontSize(11);
          const h2Height = doc.heightOfString(line.text.toUpperCase(), { width: usableWidth })
            + 8; // divider line + moveDown(0.25) gap

          // Measure actual heights of next 3 content blocks (look-ahead)
          const followHeight = measureFollowingContent(doc, lines, lineIdx + 1, 3, usableWidth);

          // spaceAbove in points (use current line height as basis)
          doc.font(FONTS.regular).fontSize(9); // reset to body for currentLineHeight
          const spaceAbovePts = doc.currentLineHeight(true) * spaceAbove;

          ensureSpace(doc, spaceAbovePts + h2Height + followHeight);

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
          /**
           * Keep h3 with the next 2 non-blank content lines — same look-ahead
           * approach as h2 but with a smaller minimum.
           */
          doc.font(FONTS.bold).fontSize(10);
          const h3Height = doc.heightOfString(stripInline(line.text), { width: usableWidth }) + 4;
          const followHeight = measureFollowingContent(doc, lines, lineIdx + 1, 2, usableWidth);
          ensureSpace(doc, h3Height + followHeight);

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

          // Measure actual height using PDFKit's heightOfString with the correct font.
          const spans = parseInlineSpans(line.text);
          const hasBold = spans.some((s) => s.bold);
          doc.font(hasBold ? FONTS.bold : FONTS.regular).fontSize(9);
          const bulletHeight = doc.heightOfString(stripInline(line.text), {
            width: bulletWidth,
            lineGap: 1.5,
          });

          /**
           * Render the bullet atomically: if it fits on the current page,
           * render it there; if it is taller than an entire page, allow it to
           * flow naturally (PDFKit handles pagination) but start it at the top
           * of a new page so we never start mid-page with too little space.
           */
          const pageUsable = (doc.page.height as number)
            - PAGE.margins.top
            - expandedBottomMargin;

          if (bulletHeight <= pageUsable) {
            // Bullet fits on one page — break before it if it won't fit here
            ensureSpace(doc, bulletHeight);
          } else {
            // Bullet is taller than a full page — start on a fresh page so it
            // at least begins at the top and PDFKit flows the remainder
            if (remainingSpace(doc) < pageUsable * 0.25) {
              ensureSpace(doc, remainingSpace(doc) + 1); // force new page
            }
          }

          const bulletY = doc.y;
          doc
            .font(FONTS.regular)
            .fontSize(9)
            .fillColor(COLOURS.bullet)
            .text('•', indent - 10, bulletY, { width: 10 });

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
          const isMeta = /[@|]/.test(line.text) && line.text.length < 120;
          const paraFontSize = isMeta ? 9 : 9.5;

          // Measure actual height with the correct font before rendering
          doc.font(hasBold ? FONTS.bold : FONTS.regular).fontSize(paraFontSize);
          const paraHeight = doc.heightOfString(stripInline(line.text), {
            width: usableWidth,
            lineGap: 2,
          });
          ensureSpace(doc, paraHeight);

          doc
            .font(hasBold ? FONTS.bold : FONTS.regular)
            .fontSize(paraFontSize)
            .fillColor(isMeta ? COLOURS.meta : COLOURS.body)
            .text(stripInline(line.text), lx, doc.y, {
              width: usableWidth,
              align: 'left', // never center — centered contact lines break some ATS field mapping
              lineGap: 2,
            });
          break;
        }

        case 'blank': {
          if (prevKind !== 'blank') doc.moveDown(0.2);
          break;
        }
      }
      prevKind = line.kind;
    }

    // ── Page-number footers ───────────────────────────────────────────────────
    // With bufferPages:true, bufferedPageRange().count is the authoritative total.
    const { count: totalPages } = doc.bufferedPageRange();

    if (totalPages > 1) {
      /**
       * Footer Y sits inside the expanded bottom margin strip — below where
       * PDFKit stops content (maxY = height - expandedBottomMargin) but above
       * the physical page edge.
       *
       * To write there without triggering an auto-page-break we temporarily
       * zero the page's bottom margin.  This is the standard PDFKit pattern
       * for footer/header overlays.
       */
      const pageHeight = doc.page.height as number;
      const footerY = pageHeight - PAGE.margins.bottom - FOOTER_HEIGHT + 2;

      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        (doc.page.margins as { bottom: number }).bottom = 0;
        doc
          .font(FONTS.regular)
          .fontSize(7.5)
          .fillColor(COLOURS.meta)
          .text(`Page ${i + 1} of ${totalPages}`, lx, footerY, {
            width: usableWidth,
            align: 'center',
            lineBreak: false,
          });
        (doc.page.margins as { bottom: number }).bottom = expandedBottomMargin;
      }
    }

    doc.end();
  });
}
