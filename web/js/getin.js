// Getting recipes into the app from elsewhere: a link or text shared to it (Share > Jones Ridge Recipes), a link
// copied to the clipboard, or a photo of a printed recipe (read on the device).
import { fromPlainText } from './transfer.js';

/** The first web address in some text, without trailing punctuation. */
export function firstLink(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'`]+/i);
  return m ? m[0].replace(/[).,;:!?\]]+$/, '') : '';
}

/** What was shared ({ title, text, url }) as { link } (a page to import), { recipe } (text that reads like a
 *  recipe), or null when it's neither. */
export function fromShared({ title = '', text = '', url = '' } = {}) {
  const link = firstLink(url) || firstLink(text);
  if (link) return { link };
  return fromText([title, text].filter(Boolean).join('\n'));
}

/** Text that reads like a recipe (a title, then ingredients and/or method) as { recipe }, or null. */
export function fromText(body) {
  const clean = String(body || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (clean.split('\n').filter((l) => l.trim()).length < 3) return null;
  const r = fromPlainText(clean);
  if (!r || (!r.ings.length && !r.dir)) return null;
  r.imported = true;
  return { recipe: r };
}

// ------------------------------------------------------------------ reading a photo of a recipe
// Tesseract.js (open source) reads the text on the device: the photo never leaves it. The reader itself
// (about 3 MB) is fetched from jsDelivr the first time someone scans, then the browser keeps it.
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';

/** The text in a photo. onProgress gets 0..1 while it reads. */
export async function readPhoto(file, onProgress) {
  const mod = await import(TESSERACT);
  const createWorker = mod.createWorker || mod.default?.createWorker;     // the ES build exports one default object
  const worker = await createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress); },
  });
  try {
    const { data } = await worker.recognize(file);
    return tidyScan(data.text || '');
  } finally {
    await worker.terminate();
  }
}

/** Joins lines a printed page wrapped mid-sentence, and drops scanning noise ("|", stray symbols). */
export function tidyScan(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/[|¦_~]+/g, ' ').replace(/\s{2,}/g, ' ').trim());
  const out = [];
  for (const line of lines) {
    if (!line) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    const prev = out[out.length - 1];
    // a method sentence that runs on: the previous line doesn't end a sentence and this one starts lower-case
    if (prev && /[a-z,]$/.test(prev) && /^[a-z0-9(]/.test(line) && prev.length > 30) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out.join('\n').trim();
}
