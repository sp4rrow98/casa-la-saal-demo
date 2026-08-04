export const config = { runtime: 'edge' };

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const KEY         = 'csal_texte';

// Formă POST-cu-body (nu path-based) pentru că valorile text pot fi lungi.
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
  return raw ? JSON.parse(raw) : {};
}

async function save(data) {
  await redis(['SET', KEY, JSON.stringify(data)]);
}

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  }

  if (req.method === 'GET') {
    const texte = await load();
    return cors(new Response(JSON.stringify(texte), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400' }
    }));
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

  if (actiune === 'salveaza') {
    const texte = await load();
    const updates = body.updates && typeof body.updates === 'object' ? body.updates : {};
    for (const key of Object.keys(updates)) {
      texte[key] = updates[key] || '';
    }
    await save(texte);
    return cors(new Response(JSON.stringify(texte), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  if (actiune === 'sterge_cheie') {
    const texte = await load();
    delete texte[body.key];
    await save(texte);
    return cors(new Response(JSON.stringify(texte), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  return cors(new Response(JSON.stringify({ error: 'unknown action' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
}
