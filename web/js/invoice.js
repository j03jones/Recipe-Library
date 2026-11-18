// Distributor invoices as PDFs (Sysco, Ben E. Keith, SGC, US Foods...), for the supplier price import.
// Some distributors leave prices out of their website exports, but every invoice has them. pdfread.js turns the
// PDF into lines of text (columns kept apart); this reads the product lines out of those lines:
//
//   1  1 CS  6  5 LB   SYS CLS CHEESE AMERICAN YEL   1234567   87.27   87.27
//   QTY      PACK SIZE  DESCRIPTION                  ITEM #    PRICE   EXTENDED
//
// Invoices differ in column order, so a line is read by what each piece looks like, not where it is: money
// (two decimals) at the end is the unit price then the extended price; "6/5 LB", "6 5 LB", "4/10# AVG" or
// "6/#10" is the pack; a 5 to 8 digit number is the item number; a small number at the start is the quantity
// (the last of "ordered, shipped"); a weight before the prices ("41.20 LB") is a catch weight; the words left
// over are the description. Lines that are not products (totals, tax, addresses) are left out.
// The result is rows with a heading row, which supplier.js reads like any other file. Pure, tested in Node.
import { documentDate, guessSupplier } from './supplier.js';

const MONEY = /^\$?\d{1,3}(?:,\d{3})*\.\d{2,3}$|^\$?\d+\.\d{2,3}$/;
const UNITS = 'LB|LBS|OZ|FL ?OZ|GAL|GA|QT|PT|CT|DZ|DOZ|KG|G|GM|L|LT|LTR|ML|#|EA|PC|CN|CAN|BAG|BX|PK|BTL|JAR|TUB|ROLL|RL';
const PACK = [
  new RegExp(`\\b\\d+\\s*\\/\\s*(?:#\\s*\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?(?:-\\d+(?:\\.\\d+)?)?\\s*(?:${UNITS}))(?:\\s*(?:AVG|AVE|UP))?(?![\\w/])`, 'i'),   // 6/5 LB, 4/10# AVG, 6/#10
  new RegExp(`\\b\\d+\\s+\\d+(?:\\.\\d+)?(?:-\\d+(?:\\.\\d+)?)?\\s*(?:${UNITS})(?:\\s*(?:AVG|AVE|UP))?\\b`, 'i'),                                  // 6 5 LB (separate columns)
  new RegExp(`\\b\\d+(?:\\.\\d+)?(?:-\\d+(?:\\.\\d+)?)?\\s*(?:${UNITS})(?:\\s*(?:AVG|AVE|UP))?\\b`, 'i'),                                          // 50 LB, 15 DZ
];
const CASE_UNIT = /^(CS|CA|CASE|EA|EACH|BX|BOX|BG|BAG|PC|PK|PKG|DZ|LB|CT|CN|BU)$/i;
const NOT_A_PRODUCT = /\b(sub-?total|total|tax|invoice|page|balance|amount due|freight|fuel|surcharge|deposit|credit|payment|terms|remit|phone|fax|ship to|bill to|sold to|customer|account|signature|received|driver|route|thank you|p\.?o\.? box|www\.|\.com)\b/i;

const words = (s) => s.split(/\s+/).filter(Boolean);

/** One invoice line as [item, description, pack, shipped, price, total] or null when it is not a product. */
export function invoiceLine(line) {
  // "MILK WHOLE2299001": an item number run into the description
  let s = String(line || '').replace(/\t/g, '  ').replace(/([A-Za-z])(\d{5,8})\b/g, '$1 $2').replace(/\s+/g, ' ').trim();
  if (s.length < 8 || NOT_A_PRODUCT.test(s)) return null;
  // money at the end: unit price, then extended price
  const toks = words(s);
  const money = [];
  for (let i = toks.length - 1; i >= 0 && money.length < 3; i--) {
    if (MONEY.test(toks[i])) money.unshift(i);
    else if (money.length) break;
  }
  if (!money.length) return null;
  const amounts = money.map((i) => toks[i].replace(/[$,]/g, ''));
  let price = amounts.length >= 2 ? amounts[amounts.length - 2] : amounts[0];
  const total = amounts.length >= 2 ? amounts[amounts.length - 1] : '';
  let rest = toks.slice(0, money[0]);
  // a catch weight right before the prices: "41.20 LB" (the price is then per pound)
  let weight = '';
  const wm = rest.join(' ').match(/(\d+(?:\.\d+)?)\s*(LB|LBS|KG)\s*$/i);
  if (wm && /\./.test(wm[1])) { weight = `${wm[1]} ${wm[2]}`; rest = words(rest.join(' ').slice(0, wm.index)); }
  // quantity: up to two small numbers at the start (ordered, shipped), maybe with a unit (CS, EA)
  const qty = [];
  while (rest.length && /^\d{1,3}$/.test(rest[0]) && qty.length < 2 && !(rest[1] && /^\d/.test(rest[1]) && PACK[1].test(rest.slice(0, 3).join(' ')) && qty.length)) {
    if (rest[1] && new RegExp(`^(${UNITS})$`, 'i').test(rest[1]) && !CASE_UNIT.test(rest[1])) break;   // "50 LB": that is the pack
    qty.push(rest.shift());
  }
  if (rest.length && CASE_UNIT.test(rest[0]) && qty.length) rest.shift();
  let text = rest.join(' ');
  // the pack
  let pack = '';
  for (const re of PACK) {
    const m = text.match(re);
    if (m) {
      // "6 5 LB" (pack and size in separate columns) is six 5 lb packs
      pack = m[0].trim().replace(/^(\d+)\s+(?=\d)/, '$1/');
      text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
      break;
    }
  }
  // the item number: a 5 to 8 digit number (the last one, where most invoices put it, else the first)
  let item = '';
  const nums = words(text).filter((w) => /^\d{5,8}$/.test(w));
  if (nums.length) { item = nums[nums.length - 1]; text = words(text).filter((w) => w !== item).join(' '); }
  // what is left that reads as words is the description
  const desc = words(text).filter((w) => /[A-Za-z]/.test(w) || /^\d+(\/\d+)?%?$/.test(w)).join(' ').replace(/^[\W_]+|[\W_]+$/g, '').trim();
  if ((desc.match(/[A-Za-z]/g) || []).length < 3 || (!item && !pack)) return null;
  if (!pack && weight) pack = weight;
  // a catch weight with a per-pound price: extended = price x weight, so read it as the total for that weight
  if (weight && total && !pack.includes('/')) price = String(price);
  return [item, desc, pack, qty.length ? qty[qty.length - 1] : '', price, total];
}

/**
 * The product lines of an invoice's text, as rows with a heading row (for supplier.js), with the invoice's
 * date and supplier on the array (`rows.date`, `rows.supplier`).
 */
export function invoiceRows(text) {
  const rows = [['Item', 'Description', 'Pack/Size', 'Shipped', 'Price', 'Total']];
  for (const line of String(text || '').split(/\n/)) {
    const r = invoiceLine(line);
    if (r) rows.push(r);
  }
  rows.date = documentDate(text);
  rows.supplier = guessSupplier('', text);
  rows.invoice = true;
  return rows;
}
