// import-recipe: reads ONE recipe page a signed-in person chose and returns only its schema.org Recipe
// block (title, ingredients, method, yield, author...). The phone app turns that into a private recipe
// with credit and a link back (web/js/webimport.js). Browsers can't read other sites directly, which is
// why this runs on the server. Nothing is stored here.
//
// Deploy:  supabase functions deploy import-recipe      (JWT verification stays ON: signed-in users only)
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 5;                       // redirects followed, each one checked
const PER_HOUR = 30;                      // imports per person per hour (per server instance; best effort)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function allowedUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  // public websites only: no IP literals, local names or internal hosts
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost') return null;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  return u;
}

// Private, loopback, link-local and other non-public addresses (IPv4 and IPv6).
function privateIp(ip: string): boolean {
  ip = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const m4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (m4) {
    const [a, b] = [Number(m4[1]), Number(m4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (ip.includes(':')) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || ip.startsWith('::ffff:');
  }
  return true;   // not an address we understand: treat as unsafe
}

// The host must resolve only to public addresses. If DNS lookups aren't available here, the name checks
// in allowedUrl still apply and fetch does its own lookup.
async function resolvesPublic(host: string): Promise<boolean> {
  if (typeof Deno?.resolveDns !== 'function') return true;
  const ips: string[] = [];
  for (const t of ['A', 'AAAA'] as const) {
    try { ips.push(...(await Deno.resolveDns(host, t)) as string[]); } catch { /* no records of this type */ }
  }
  return ips.every((ip) => !privateIp(ip));
}

// Reads the body but stops as soon as it passes the size limit (instead of downloading it all first).
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get('content-length') || 0) > max) { await res.body?.cancel(); return null; }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Per-person limit. Kept in memory, so it resets when the server instance restarts; enough to stop
// someone using the function as a free page fetcher.
const recent = new Map<string, number[]>();
function overLimit(user: string, now = Date.now()): boolean {
  const hits = (recent.get(user) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= PER_HOUR) { recent.set(user, hits); return true; }
  hits.push(now); recent.set(user, hits);
  if (recent.size > 5000) recent.clear();
  return false;
}
function userOf(req: Request): string {
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    return String(JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || 'anon');
  } catch { return 'anon'; }
}

function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    yield o;
    for (const k of ['@graph', 'mainEntity', 'itemListElement']) if (k in o) yield* walk(o[k]);
  }
}
const isRecipe = (o: Record<string, unknown>) => ([] as unknown[]).concat(o['@type'] ?? []).map(String).includes('Recipe');

function findRecipe(html: string) {
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const o of walk(data)) if (isRecipe(o)) return o;
  }
  return null;
}

// Keep only the fields the app uses; drop images, video, reviews, descriptions and the rest.
const KEEP = ['@type', 'name', 'author', 'publisher', 'url', 'recipeYield', 'recipeIngredient', 'ingredients',
  'recipeInstructions', 'recipeCategory', 'recipeCuisine', 'suitableForDiet'];
const pick = (o: Record<string, unknown>) => Object.fromEntries(KEEP.filter((k) => k in o).map((k) => [k, o[k]]));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (overLimit(userOf(req))) return json({ error: 'That’s a lot of imports in an hour. Please try again a little later.' }, 429);
  let url: URL | null = null;
  try { url = allowedUrl(String((await req.json()).url || '').trim()); } catch { /* bad body */ }
  if (!url) return json({ error: 'Please enter the address of a public recipe page (https://...).' }, 400);

  // Follow redirects one at a time so every address on the way is checked, not just the last one.
  let res: Response;
  for (let hop = 0; ; hop++) {
    if (!(await resolvesPublic(url.hostname))) return json({ error: 'That link points somewhere that can’t be read.' }, 400);
    try {
      res = await fetch(url, {
        redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeLibrary; personal recipe box)', Accept: 'text/html,*/*;q=0.5' },
      });
    } catch {
      return json({ error: 'Could not reach that website. Check the link.' }, 502);
    }
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status > 399 || !loc) break;
    await res.body?.cancel();
    let next: URL | null = null;
    try { next = allowedUrl(new URL(loc, url).href); } catch { /* bad address */ }
    if (!next) return json({ error: 'That link redirects somewhere that can’t be read.' }, 400);
    if (hop + 1 >= MAX_HOPS) return json({ error: 'That link redirects too many times.' }, 400);
    url = next;
  }
  const finalUrl = url;
  if (!res.ok) { await res.body?.cancel(); return json({ error: `The website answered with an error (${res.status}).` }, 502); }
  const buf = await readCapped(res, MAX_BYTES);
  if (!buf) return json({ error: 'That page is too large to read.' }, 413);
  const html = new TextDecoder().decode(buf);
  const recipe = findRecipe(html);
  if (!recipe) return json({ error: 'No recipe was found on that page. You can still add it by hand with the link as the source.' }, 404);
  const site = /<meta[^>]+property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] || '';
  return json({ recipe: pick(recipe), url: finalUrl.href, site });
});
