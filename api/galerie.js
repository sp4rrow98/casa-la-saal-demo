export const config = { runtime: 'edge' };

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const KEY         = 'csal_galerie';

// Formă POST-cu-body — manifestul galeriei poate deveni suficient de mare
// încât un URL path-based ar depăși limita de lungime a URL-ului.
async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return j.result;
}

async function load() {
  const raw = await redis(['GET', KEY]);
  return raw ? JSON.parse(raw) : [];
}

async function save(items) {
  await redis(['SET', KEY, JSON.stringify(items)]);
}

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  }

  if (req.method === 'GET') {
    const items = await load();
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30, s-maxage=300, stale-while-revalidate=86400' } }));
  }

  const pass = req.headers.get('Authorization') || '';
  if (!ADMIN_PASS || pass !== ADMIN_PASS) {
    return cors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  }

  const body = await req.json().catch(() => ({}));
  const { actiune } = body;

  if (actiune === '_init' || actiune === 'lista') {
    return cors(new Response(JSON.stringify(await load()), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  // Înlocuiește tot manifestul — folosit după reordonare sau editare text alternativ.
  if (actiune === 'salveaza') {
    const items = Array.isArray(body.items) ? body.items : [];
    await save(items);
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  // Import inițial — seed din galeria hardcodată din index.html (fără duplicare dacă rulează de 2 ori).
  if (actiune === 'seed') {
    const existing = await load();
    if (existing.length) {
      return cors(new Response(JSON.stringify(existing), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    const items = Array.isArray(body.items) ? body.items : [];
    await save(items);
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  // Upload poză nouă: primește bytes redimensionați (base64, webp) din browser,
  // le stochează în Redis (fără stocare de fișiere) și adaugă o intrare în manifest.
  if (actiune === 'upload') {
    const id = newId();
    const fullB64  = (body.full_b64  || '').replace(/^data:[^,]+,/, '');
    const thumbB64 = (body.thumb_b64 || '').replace(/^data:[^,]+,/, '');
    if (!fullB64 || !thumbB64) {
      return cors(new Response(JSON.stringify({ error: 'missing image data' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }
    await redis(['SET', `csal_img:${id}:full`, fullB64]);
    await redis(['SET', `csal_img:${id}:thumb`, thumbB64]);

    const items = await load();
    const maxOrdine = items.reduce((m, it) => Math.max(m, it.ordine || 0), 0);
    const item = {
      id,
      src:  `/api/img?id=${id}&size=thumb`,
      full: `/api/img?id=${id}&size=full`,
      alt: body.alt || '',
      ordine: maxOrdine + 1,
      stored: true
    };
    items.push(item);
    await save(items);
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  if (actiune === 'sterge') {
    let items = await load();
    const it = items.find(x => x.id === body.id);
    items = items.filter(x => x.id !== body.id);
    await save(items);
    if (it && it.stored) {
      await redis(['DEL', `csal_img:${body.id}:full`]);
      await redis(['DEL', `csal_img:${body.id}:thumb`]);
    }
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  return cors(new Response(JSON.stringify({ error: 'unknown action' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
}
