export const config = { runtime: 'edge' };

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const KEY         = 'csal_camere';

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

  // Import inițial — seed din cele 7 camere hardcodate din index.html (fără duplicare dacă rulează de 2 ori).
  if (actiune === 'seed') {
    const existing = await load();
    if (existing.length) {
      return cors(new Response(JSON.stringify(existing), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    const items = Array.isArray(body.items) ? body.items : [];
    await save(items);
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  // Înlocuiește tot manifestul — folosit după reordonare sau editare nume/tip/descriere/preț.
  if (actiune === 'salveaza') {
    const items = Array.isArray(body.items) ? body.items : [];
    await save(items);
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  if (actiune === 'adauga') {
    const items = await load();
    const maxOrdine = items.reduce((m, it) => Math.max(m, it.ordine || 0), 0);
    const item = {
      id: newId(),
      nume: body.nume || 'Cameră nouă',
      tip: body.tip || 'Cameră',
      descriere: body.descriere || '',
      pret: body.pret || '',
      imgId: null,
      ordine: maxOrdine + 1
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
    if (it && it.imgId) {
      await redis(['DEL', `csal_img:${it.imgId}:full`]);
      await redis(['DEL', `csal_img:${it.imgId}:thumb`]);
    }
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  // Poză nouă/înlocuită pentru o cameră: primește bytes redimensionați (base64, webp),
  // le stochează sub același namespace csal_img: ca galeria, și actualizează imgId-ul camerei.
  if (actiune === 'upload_poza') {
    const items = await load();
    const room = items.find(x => x.id === body.id);
    if (!room) {
      return cors(new Response(JSON.stringify({ error: 'room not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    }
    const fullB64  = (body.full_b64  || '').replace(/^data:[^,]+,/, '');
    const thumbB64 = (body.thumb_b64 || '').replace(/^data:[^,]+,/, '');
    if (!fullB64 || !thumbB64) {
      return cors(new Response(JSON.stringify({ error: 'missing image data' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }
    const oldImgId = room.imgId;
    const newImgId = newId();
    await redis(['SET', `csal_img:${newImgId}:full`, fullB64]);
    await redis(['SET', `csal_img:${newImgId}:thumb`, thumbB64]);
    room.imgId = newImgId;
    await save(items);
    if (oldImgId) {
      await redis(['DEL', `csal_img:${oldImgId}:full`]);
      await redis(['DEL', `csal_img:${oldImgId}:thumb`]);
    }
    return cors(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  return cors(new Response(JSON.stringify({ error: 'unknown action' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
}
