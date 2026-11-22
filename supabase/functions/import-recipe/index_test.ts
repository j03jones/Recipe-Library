// Offline checks for import-recipe: fake websites and DNS, no network.  deno run supabase/functions/import-recipe/index_test.ts
let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; };
const dns: Record<string, string[]> = { 'ok.test.com': ['93.184.216.34'], 'evil.test.com': ['10.0.0.5'], 'v6evil.test.com': ['fd00::1'], 'big.test.com': ['93.184.216.35'] };
(Deno as any).resolveDns = async (h: string, t: string) => (dns[h] || []).filter((x) => (t === 'AAAA') === x.includes(':'));
const fetched: string[] = [];
const page = `<html><script type="application/ld+json">{"@type":"Recipe","name":"Pie","recipeIngredient":["1 crust"]}</script></html>`;
globalThis.fetch = (async (u: URL | string) => {
  const s = String(u); fetched.push(s);
  if (s.startsWith('https://ok.test.com/r1')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  if (s.startsWith('https://ok.test.com/r2')) return new Response(null, { status: 301, headers: { location: 'https://evil.test.com/' } });
  if (s.startsWith('https://ok.test.com/r3')) return new Response(null, { status: 302, headers: { location: '/recipe' } });
  if (s.startsWith('https://ok.test.com/loop')) return new Response(null, { status: 302, headers: { location: '/loop' } });
  if (s.startsWith('https://ok.test.com/recipe')) return new Response(page);
  if (s.startsWith('https://big.test.com/')) {
    let n = 0;
    return new Response(new ReadableStream({ pull(c) { if (n++ > 2000) c.close(); else c.enqueue(new Uint8Array(65536)); } }));
  }
  throw new Error('unexpected fetch ' + s);
}) as any;
await import('./index.ts');
const jwt = (sub: string) => 'x.' + btoa(JSON.stringify({ sub })).replace(/=/g, '') + '.y';
const call = async (url: string, sub = 'u1') => {
  const r = await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt(sub) }, body: JSON.stringify({ url }) }));
  return [r.status, await r.json()] as const;
};
let fails = 0;
const check = (name: string, ok: boolean, got: unknown) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(got))); if (!ok) fails++; };
let r;
r = await call('https://ok.test.com/r1'); check('redirect to 127.0.0.1 blocked', r[0] === 400 && !fetched.some((f) => f.includes('127.0.0.1')), r);
r = await call('https://ok.test.com/r2'); check('redirect to a name on a private address blocked', r[0] === 400 && !fetched.some((f) => f.includes('evil')), r);
r = await call('https://evil.test.com/'); check('name on a private address blocked', r[0] === 400, r);
r = await call('https://v6evil.test.com/'); check('private IPv6 blocked', r[0] === 400, r);
r = await call('https://ok.test.com/r3'); check('relative redirect to a recipe works', r[0] === 200 && r[1].recipe.name === 'Pie' && r[1].url === 'https://ok.test.com/recipe', r);
r = await call('https://ok.test.com/loop'); check('redirect loop stops', r[0] === 400, r);
r = await call('https://big.test.com/'); check('page over 5 MB stopped', r[0] === 413 && r[1].error.includes('too large'), r);
r = await call('http://localhost/'); check('localhost blocked', r[0] === 400, r);
for (let i = 0; i < 30; i++) r = await call('https://ok.test.com/recipe', 'u2');
check('30 imports in an hour allowed', r[0] === 200, r);
r = await call('https://ok.test.com/recipe', 'u2'); check('31st import in an hour refused', r[0] === 429, r);
r = await call('https://ok.test.com/recipe', 'u3'); check('someone else not affected', r[0] === 200, r);
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
Deno.exit(fails ? 1 : 0);
