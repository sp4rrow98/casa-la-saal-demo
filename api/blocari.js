export const config = { runtime: 'edge' };

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const KEY         = 'csal_blocari';

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

function expandRange(start, end) {
  const dates = [];
  const cur = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
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
    const blocari = await load();
    const blocked = {};
    for (const roomId of Object.keys(blocari)) {
      const dates = new Set();
      for (const b of blocari[roomId]) {
        for (const d of expandRange(b.start, b.end)) dates.add(d);
      }
      blocked[roomId] = [...dates].sort();
    }
    return cors(new Response(JSON.stringify({ blocked }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    }));
  }

  const pass = req.headers.get('Authorization') || '';
  if (!ADMIN_PASS || pass !== ADMIN_PASS) {
    return cors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  }

  const body = await req.json().catch(() => ({}));
  const { actiune, roomId } = body;

  if (actiune === '_init' || actiune === 'lista') {
    return cors(new Response(JSON.stringify(await load()), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  if (actiune === 'adauga') {
    if (!roomId || !body.start || !body.end) {
      return cors(new Response(JSON.stringify({ error: 'roomId/start/end required' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }
    const blocari = await load();
    if (!blocari[roomId]) blocari[roomId] = [];
    blocari[roomId].push({
      id:    Date.now().toString(36),
      start: body.start,
      end:   body.end,
      motiv: body.motiv || ''
    });
    await save(blocari);
    return cors(new Response(JSON.stringify(blocari), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  if (actiune === 'sterge') {
    const blocari = await load();
    if (blocari[roomId]) {
      blocari[roomId] = blocari[roomId].filter(b => b.id !== body.id);
    }
    await save(blocari);
    return cors(new Response(JSON.stringify(blocari), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  return cors(new Response(JSON.stringify({ error: 'unknown action' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
}
