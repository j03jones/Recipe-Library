// Reading the text of a PDF (a cookbook, a recipe card exported from Word) so transfer.js can import it.
// pdf.js (Mozilla, open source) does the reading on the device: the file never leaves it. It is fetched from
// jsDelivr the first time someone imports a PDF (about 1.7 MB), then the browser keeps it. Scanned PDFs are
// pictures with no text in them; those go through "Scan a printed recipe" instead.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs';
const WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';
const MAX_PAGES = 400;

/**
 * One page's text items ({ str, transform: [a, b, c, d, x, y], width }) as lines of text. Items on the same
 * baseline join into one line; a wide gap between them (a table column) becomes a tab, so an ingredient table
 * reads as "Flour\t2 cups"; a tall gap between lines becomes a blank line. No DOM: tested in Node.
 */
export function linesFromItems(items) {
  const parts = items
    .filter((it) => it && typeof it.str === 'string' && it.str.trim() && Array.isArray(it.transform))
    .map((it) => {
      const [a, b, , d, x, y] = it.transform;
      const size = Math.max(1, Math.hypot(a, b) || Math.abs(d) || 10);
      return { str: it.str, x, y, w: it.width || it.str.length * size * 0.5, size };
    })
    .sort((p, q) => q.y - p.y || p.x - q.x);
  const rows = [];
  for (const p of parts) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - p.y) <= Math.min(row.size, p.size) * 0.45) row.items.push(p);
    else rows.push({ y: p.y, size: p.size, items: [p] });
  }
  const out = [];
  let lastY = null, lastSize = 0;
  for (const row of rows) {
    row.items.sort((p, q) => p.x - q.x);
    let line = '', end = null;
    for (const p of row.items) {
      if (end != null) {
        const gap = p.x - end;
        if (gap > p.size * 1.6) line = `${line.trimEnd()}\t`;                 // a column
        else if (gap > p.size * 0.12 && !/\s$/.test(line) && !/^\s/.test(p.str)) line += ' ';
      }
      line += p.str;
      end = p.x + p.w;
    }
    if (lastY != null && lastY - row.y > Math.max(lastSize, row.size) * 1.9) out.push('');
    out.push(line.replace(/[  ]{2,}/g, ' ').trim());
    lastY = row.y; lastSize = row.size;
  }
  return out.join('\n');
}

let lib = null;
async function pdfjs() {
  if (lib) return lib;
  const mod = await import(PDFJS);
  // a worker straight from another site is refused, so start it from a tiny local module that imports it
  try {
    const src = URL.createObjectURL(new Blob([`import ${JSON.stringify(WORKER)};`], { type: 'text/javascript' }));
    mod.GlobalWorkerOptions.workerPort = new Worker(src, { type: 'module' });
  } catch {
    mod.GlobalWorkerOptions.workerSrc = WORKER;          // pdf.js falls back to reading on the page itself
  }
  lib = mod;
  return mod;
}

/** The text of a PDF, page by page (pages separated by \f, which transfer.js can split recipes on). */
export async function pdfToText(bytes) {
  let mod;
  try { mod = await pdfjs(); } catch { throw new Error('The PDF reader could not be loaded. Check your connection and try again.'); }
  const task = mod.getDocument({ data: bytes.slice(), isEvalSupported: false });
  let doc;
  try { doc = await task.promise; } catch (err) {
    throw new Error(/password/i.test(err?.message || err?.name || '') ? 'That PDF is password-protected. Open it, save a copy without a password, and import that.' : 'That PDF could not be read.');
  }
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(linesFromItems(content.items));
    page.cleanup?.();
  }
  await (task.destroy?.() ?? doc.destroy?.());
  return pages.join('\n\f\n');
}
