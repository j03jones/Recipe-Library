// Reading the first sheet of an Excel workbook (.xlsx), for supplier price lists and order exports that
// distributors hand out as spreadsheets (Ben E. Keith orders and history lists, for one).
// An .xlsx is a zip of XML files: the zip is read here and each part inflated with the browser's own
// DecompressionStream, so no library is needed. Works in Node 18+ too (tests).
// Returns rows of cell text, like parseCsv in supplier.js. The older .xls format is not supported.

const td = new TextDecoder();

/** True when the bytes are a zip (an .xlsx), whatever the file is called. */
export const isXlsx = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

async function inflate(data) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([data]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** { name: bytes } for the zip's files whose name passes `want`. */
async function unzip(bytes, want) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('This file is not a readable Excel workbook');
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const files = {};
  for (let n = 0; n < count && v.getUint32(at, true) === 0x02014b50; n++) {
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = td.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    files[name] = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
  }
  return files;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');
const colOf = (ref) => [...String(ref).replace(/\d+$/, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** The first sheet of an .xlsx as rows of cell text. Empty rows are left out. */
export async function readXlsx(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = await unzip(bytes, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels');
  const shared = files['xl/sharedStrings.xml'] ? [...td.decode(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  // the first sheet in the workbook's own order (sheet1.xml is not always it)
  let sheet = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))[0];
  try {
    const rid = td.decode(files['xl/workbook.xml']).match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
    const target = rid && td.decode(files['xl/_rels/workbook.xml.rels']).match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1]
      || (rid && td.decode(files['xl/_rels/workbook.xml.rels']).match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1]);
    const path = target && `xl/${target.replace(/^\/?xl\//, '').replace(/^\.\//, '')}`;
    if (path && files[path]) sheet = path;
  } catch { /* use the first by number */ }
  if (!sheet || !files[sheet]) throw new Error('No sheet found in this workbook');
  const rows = [];
  for (const rm of td.decode(files[sheet]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const body = cm[2] || '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = texts(body);
      else if (v != null) {
        val = unescape(v);
        // 63.270000000000003 -> 63.27
        if (type !== 'str' && /^-?\d+\.\d{6,}$/.test(val)) val = String(Math.round(Number(val) * 1e6) / 1e6);
      }
      row[ref ? colOf(ref) : row.length] = val;
    }
    const cells = Array.from(row, (c) => (c == null ? '' : String(c).trim()));
    if (cells.some((c) => c !== '')) rows.push(cells);
  }
  return rows;
}

/** A chosen file as what the supplier reader takes: rows for a workbook or an invoice PDF, text for anything else. */
export async function readTable(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isXlsx(bytes)) return readXlsx(bytes);
  // a PDF invoice: its text, read on the device, then its product lines
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    const [{ pdfToText }, { invoiceRows }] = await Promise.all([import('./pdfread.js'), import('./invoice.js')]);
    const text = await pdfToText(bytes);
    if (!text.replace(/\s/g, '')) throw new Error('This PDF has no text in it (a scan or photo). Download the invoice as a PDF from the supplier’s site instead.');
    return invoiceRows(text);
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new Error('This is an older Excel file (.xls). Open it in Excel and save it as .xlsx or CSV, then import that.');
  return td.decode(bytes);
}
