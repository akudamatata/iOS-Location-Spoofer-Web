'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

/* ── Config ─────────────────────────────────────────────── */
const PORT       = parseInt(process.env.PORT     || '8080', 10);
const TOKEN      = process.env.TOKEN             || '';
const AMAP_KEY   = process.env.AMAP_KEY          || '';
const DATA_DIR   = process.env.DATA_DIR          || '/data';
const LOC_FILE   = path.join(DATA_DIR, 'loc.json');
const FAV_FILE   = path.join(DATA_DIR, 'favorites.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_LOC = {
  latitude:           39.90872,
  longitude:          116.39748,
  altitude:           44,
  horizontalAccuracy: 39,
  verticalAccuracy:   1000
};

/* ── Bootstrap ───────────────────────────────────────────── */
function bootstrap() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOC_FILE)) writeJson(LOC_FILE, DEFAULT_LOC);
  if (!fs.existsSync(FAV_FILE)) writeJson(FAV_FILE, []);
}

/* ── Helpers ─────────────────────────────────────────────── */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function send(res, status, type, body) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'Content-Type':                type,
    'Content-Length':              buf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-store'
  });
  res.end(buf);
}

function authOk(query) {
  return !TOKEN || query.token === TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => s += d);
    req.on('end',  () => resolve(s));
    req.on('error', reject);
  });
}

/* ── Static file serving with token injection ───────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

function serveFile(res, filePath, inject) {
  const abs = path.resolve(filePath);
  if (!abs.startsWith(path.resolve(PUBLIC_DIR))) {
    return send(res, 403, 'text/plain', 'Forbidden');
  }
  let data;
  try { data = fs.readFileSync(abs); }
  catch { return send(res, 404, 'text/plain', 'Not found'); }

  const ext  = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  if (inject && ext === '.html') {
    // Inject runtime config so the page auto-authenticates
    const script = `<script>window.__CFG__=${JSON.stringify(inject)};</script>`;
    const html   = data.toString('utf8').replace('</head>', script + '</head>');
    return send(res, 200, type, html);
  }
  send(res, 200, type, data);
}

/* ── Request handler ─────────────────────────────────────── */
async function handler(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const query    = parsed.query;
  const method   = req.method.toUpperCase();

  /* CORS preflight */
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  /* ─ GET /loc.json  (Shadowrocket reads this) ─ */
  if (pathname === '/loc.json' && method === 'GET') {
    if (!authOk(query)) return send(res, 401, 'application/json', '{"error":"unauthorized"}');
    return send(res, 200, 'application/json', JSON.stringify(readJson(LOC_FILE, DEFAULT_LOC)));
  }

  /* ─ POST /set  (web UI saves coords) ─ */
  if (pathname === '/set' && method === 'POST') {
    if (!authOk(query)) return send(res, 401, 'application/json', '{"error":"unauthorized"}');
    try {
      const body    = await readBody(req);
      const data    = JSON.parse(body);
      const current = readJson(LOC_FILE, DEFAULT_LOC);
      const updated = { ...current };
      if (typeof data.latitude           === 'number') updated.latitude           = data.latitude;
      if (typeof data.longitude          === 'number') updated.longitude          = data.longitude;
      if (typeof data.altitude           === 'number') updated.altitude           = data.altitude;
      if (typeof data.horizontalAccuracy === 'number') updated.horizontalAccuracy = data.horizontalAccuracy;
      if (typeof data.verticalAccuracy   === 'number') updated.verticalAccuracy   = data.verticalAccuracy;
      writeJson(LOC_FILE, updated);
      return send(res, 200, 'application/json', JSON.stringify(updated));
    } catch {
      return send(res, 400, 'application/json', '{"error":"bad json"}');
    }
  }

  /* ─ GET /favorites ─ */
  if (pathname === '/favorites' && method === 'GET') {
    if (!authOk(query)) return send(res, 401, 'application/json', '{"error":"unauthorized"}');
    return send(res, 200, 'application/json', JSON.stringify(readJson(FAV_FILE, [])));
  }

  /* ─ POST /favorites ─ */
  if (pathname === '/favorites' && method === 'POST') {
    if (!authOk(query)) return send(res, 401, 'application/json', '{"error":"unauthorized"}');
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const favs = readJson(FAV_FILE, []);
      const fav  = {
        id:                 Date.now().toString(36),
        name:               (data.name || '未命名').slice(0, 30),
        latitude:           data.latitude,
        longitude:          data.longitude,
        altitude:           data.altitude           ?? null,
        horizontalAccuracy: data.horizontalAccuracy ?? null,
        verticalAccuracy:   data.verticalAccuracy   ?? null,
        createdAt:          new Date().toISOString()
      };
      favs.unshift(fav);              // newest first
      if (favs.length > 100) favs.pop();  // cap at 100
      writeJson(FAV_FILE, favs);
      return send(res, 200, 'application/json', JSON.stringify(fav));
    } catch {
      return send(res, 400, 'application/json', '{"error":"bad json"}');
    }
  }

  /* ─ DELETE /favorites/:id ─ */
  const favDelete = pathname.match(/^\/favorites\/([^/]+)$/);
  if (favDelete && method === 'DELETE') {
    if (!authOk(query)) return send(res, 401, 'application/json', '{"error":"unauthorized"}');
    const id   = favDelete[1];
    const favs = readJson(FAV_FILE, []).filter(f => f.id !== id);
    writeJson(FAV_FILE, favs);
    return send(res, 200, 'application/json', '{"ok":true}');
  }

  /* ─ GET / → index.html with injected config ─ */
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), { token: TOKEN, amapKey: AMAP_KEY });
  }

  /* ─ Static assets ─ */
  if (method === 'GET') {
    return serveFile(res, path.join(PUBLIC_DIR, pathname), null);
  }

  send(res, 405, 'text/plain', 'Method Not Allowed');
}

/* ── Start ───────────────────────────────────────────────── */
bootstrap();
http.createServer((req, res) => {
  handler(req, res).catch(err => {
    console.error(err);
    res.writeHead(500).end('Internal Server Error');
  });
}).listen(PORT, () => {
  console.log(`\n🛰  GPS Spoofer Web  →  http://localhost:${PORT}`);
  console.log(`   Token    : ${TOKEN ? TOKEN.slice(0, 4) + '****' : '(none – open access)'}`);
  console.log(`   AMap Key : ${AMAP_KEY ? 'Configured ✓' : '(none – search defaults to OSM)'}`);
  console.log(`   Data     : ${DATA_DIR}\n`);
});
