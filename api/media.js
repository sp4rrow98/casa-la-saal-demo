export const config = { runtime: 'edge' };

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const KEY_SLOTS    = 'csal_media_slots';
const KEY_GALLERIES = 'csal_media_galleries';

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return j.result;
}

async function loadSlots() {
  const raw = await redis(['GET', KEY_SLOTS]);
  return raw ? JSON.parse(raw) : {};
}
async function saveSlots(data) {
  await redis(['SET', KEY_SLOTS, JSON.stringify(data)]);
}
async function loadGalleries() {
  const raw = await redis(['GET', KEY_GALLERIES]);
  return raw ? JSON.parse(raw) : {};
}
async function saveGalleries(data) {
  await redis(['SET', KEY_GALLERIES, JSON.stringify(data)]);
}

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}
function json(data, status) {
  return cors(new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  }

  if (req.method === 'GET') {
    const [slots, galleries] = await Promise.all([loadSlots(), loadGalleries()]);
    return cors(new Response(JSON.stringify({ slots, galleries }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30, s-maxage=300, stale-while-revalidate=86400' } }));
  }

  const pass = req.headers.get('Authorization') || '';
  if (!ADMIN_PASS || pass !== ADMIN_PASS) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const { actiune } = body;

  if (actiune === '_init' || actiune === 'lista') {
    const [slots, galleries] = await Promise.all([loadSlots(), loadGalleries()]);
    return json({ slots, galleries });
  }

  // ---------- SLOTS (poze fixe, o singură poziție) ----------

  // Seed inițial dintr-o poză deja existentă în images/ — fără duplicare dacă slotul există deja.
  if (actiune === 'seed_slot') {
    const slots = await loadSlots();
    if (slots[body.key]) return json({ slots, galleries: await loadGalleries() });
    slots[body.key] = { src: body.src || '', alt: body.alt || '', stored: false };
    await saveSlots(slots);
    return json({ slots, galleries: await loadGalleries() });
  }

  // Înlocuiește poza dintr-un slot cu bytes redimensionați din browser.
  if (actiune === 'upload_slot') {
    const fullB64  = (body.full_b64  || '').replace(/^data:[^,]+,/, '');
    const thumbB64 = (body.thumb_b64 || '').replace(/^data:[^,]+,/, '');
    if (!body.key || !fullB64 || !thumbB64) {
      return json({ error: 'missing key or image data' }, 400);
    }
    const slots = await loadSlots();
    const old = slots[body.key];
    const id = newId();
    await redis(['SET', `csal_img:${id}:full`, fullB64]);
    await redis(['SET', `csal_img:${id}:thumb`, thumbB64]);
    slots[body.key] = { id, src: `/api/img?id=${id}&size=full`, alt: body.alt || (old && old.alt) || '', stored: true };
    await saveSlots(slots);
    if (old && old.stored && old.id) {
      await redis(['DEL', `csal_img:${old.id}:full`]);
      await redis(['DEL', `csal_img:${old.id}:thumb`]);
    }
    return json({ slots, galleries: await loadGalleries() });
  }

  // Revine la poza implicită din HTML (șterge suprascrierea din Redis).
  if (actiune === 'sterge_slot') {
    const slots = await loadSlots();
    const old = slots[body.key];
    delete slots[body.key];
    await saveSlots(slots);
    if (old && old.stored && old.id) {
      await redis(['DEL', `csal_img:${old.id}:full`]);
      await redis(['DEL', `csal_img:${old.id}:thumb`]);
    }
    return json({ slots, galleries: await loadGalleries() });
  }

  // ---------- GALLERIES (mini-galerii reordonabile) ----------

  // Seed inițial dintr-o colecție de poze deja existente în images/ — fără duplicare dacă colecția are deja poze.
  if (actiune === 'seed_galerie') {
    const galleries = await loadGalleries();
    if (galleries[body.colectie] && galleries[body.colectie].length) {
      return json({ slots: await loadSlots(), galleries });
    }
    galleries[body.colectie] = Array.isArray(body.items) ? body.items : [];
    await saveGalleries(galleries);
    return json({ slots: await loadSlots(), galleries });
  }

  // Înlocuiește tot manifestul unei colecții — folosit după reordonare sau editare text alternativ.
  if (actiune === 'salveaza_galerie') {
    const galleries = await loadGalleries();
    galleries[body.colectie] = Array.isArray(body.items) ? body.items : [];
    await saveGalleries(galleries);
    return json({ slots: await loadSlots(), galleries });
  }

  // Adaugă o poză nouă într-o colecție.
  if (actiune === 'upload_galerie') {
    const fullB64  = (body.full_b64  || '').replace(/^data:[^,]+,/, '');
    const thumbB64 = (body.thumb_b64 || '').replace(/^data:[^,]+,/, '');
    if (!body.colectie || !fullB64 || !thumbB64) {
      return json({ error: 'missing colectie or image data' }, 400);
    }
    const id = newId();
    await redis(['SET', `csal_img:${id}:full`, fullB64]);
    await redis(['SET', `csal_img:${id}:thumb`, thumbB64]);
    const galleries = await loadGalleries();
    const items = galleries[body.colectie] || [];
    const maxOrdine = items.reduce((m, it) => Math.max(m, it.ordine || 0), 0);
    items.push({ id, src: `/api/img?id=${id}&size=thumb`, full: `/api/img?id=${id}&size=full`, alt: body.alt || '', ordine: maxOrdine + 1, stored: true });
    galleries[body.colectie] = items;
    await saveGalleries(galleries);
    return json({ slots: await loadSlots(), galleries });
  }

  // Șterge o poză dintr-o colecție.
  if (actiune === 'sterge_din_galerie') {
    const galleries = await loadGalleries();
    let items = galleries[body.colectie] || [];
    const it = items.find(x => x.id === body.id);
    items = items.filter(x => x.id !== body.id);
    galleries[body.colectie] = items;
    await saveGalleries(galleries);
    if (it && it.stored) {
      await redis(['DEL', `csal_img:${it.id}:full`]);
      await redis(['DEL', `csal_img:${it.id}:thumb`]);
    }
    return json({ slots: await loadSlots(), galleries });
  }

  return json({ error: 'unknown action' }, 400);
}
