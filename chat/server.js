import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import * as webpush from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';  // за Caddy слушаем только localhost
const INVITE = process.env.INVITE_CODE || '';           // без кода регистрация закрыта
const SECURE = process.env.COOKIE_SECURE === '1';       // включить за HTTPS
const MAX_USERS = Number(process.env.MAX_USERS || 5);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'chat.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL,
    text TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id, to_id, id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
`);

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  addUser: db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)'),
  allUsers: db.prepare('SELECT id, username FROM users ORDER BY username'),
  addSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  addMsg: db.prepare('INSERT INTO messages (from_id, to_id, text, created_at) VALUES (?, ?, ?, ?)'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  addSub: db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
  subsOf: db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'),
  delSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
  history: db.prepare(`SELECT id, from_id, to_id, text, created_at FROM messages
    WHERE ((from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)) AND (?3 = 0 OR id < ?3)
    ORDER BY id DESC LIMIT 50`),
};

// ---------- web push ----------
// VAPID-ключи создаются один раз и хранятся в базе (они входят в бэкап).
let vapidPublic = q.getSetting.get('vapid_public')?.value;
let vapidPrivate = q.getSetting.get('vapid_private')?.value;
if (!vapidPublic || !vapidPrivate) {
  const k = webpush.generateVAPIDKeys();
  vapidPublic = k.publicKey; vapidPrivate = k.privateKey;
  q.setSetting.run('vapid_public', vapidPublic);
  q.setSetting.run('vapid_private', vapidPrivate);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://duoverse-app.org', vapidPublic, vapidPrivate);

async function pushTo(userId, payload) {
  for (const sub of q.subsOf.all(userId)) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'high' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) q.delSub.run(sub.endpoint); // подписка устарела
      else console.error('push error', e.statusCode || e.message);
    }
  }
}

// ---------- auth ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const userFromReq = (req) => {
  const t = parseCookies(req.headers.cookie).sid;
  return t ? q.sessionUser.get(t) : undefined;
};
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.addSession.run(token, userId, Date.now());
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 365}${SECURE ? '; Secure' : ''}`);
}

// простое ограничение попыток входа по IP
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 10;
}
const noteAttempt = (ip) => attempts.get(ip)?.push(Date.now()) ?? attempts.set(ip, [Date.now()]);
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10_000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // статика
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 400, { error: 'bad request' });
  }
});

async function api(req, res, url) {
  const ip = clientIp(req);
  if (req.method === 'POST' && (url.pathname === '/api/login' || url.pathname === '/api/register')) {
    if (tooMany(ip)) return json(res, 429, { error: 'Слишком много попыток, подожди 10 минут' });
    const b = await readJson(req);
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');

    if (url.pathname === '/api/register') {
      if (!INVITE || !safeEq(String(b.invite || ''), INVITE)) { noteAttempt(ip); return json(res, 403, { error: 'Неверный код приглашения' }); }
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return json(res, 400, { error: 'Имя: 3-20 символов, a-z, 0-9, _' });
      if (password.length < 8) return json(res, 400, { error: 'Пароль минимум 8 символов' });
      if (q.userCount.get().n >= MAX_USERS) return json(res, 403, { error: 'Лимит пользователей' });
      if (q.userByName.get(username)) return json(res, 409, { error: 'Имя занято' });
      const salt = crypto.randomBytes(16).toString('hex');
      const r = q.addUser.run(username, salt, hashPw(password, salt), Date.now());
      startSession(res, Number(r.lastInsertRowid));
      return json(res, 200, { ok: true });
    }
    const u = q.userByName.get(username);
    if (!u || !safeEq(hashPw(password, u.salt), u.hash)) { noteAttempt(ip); return json(res, 401, { error: 'Неверное имя или пароль' }); }
    startSession(res, u.id);
    return json(res, 200, { ok: true });
  }

  const me = userFromReq(req);
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const t = parseCookies(req.headers.cookie).sid;
    if (t) q.delSession.run(t);
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (!me) return json(res, 401, { error: 'auth' });
  if (url.pathname === '/api/me') return json(res, 200, me);
  if (url.pathname === '/api/users') return json(res, 200, q.allUsers.all().filter((u) => u.id !== me.id));
  if (url.pathname === '/api/messages') {
    const other = Number(url.searchParams.get('with')), before = Number(url.searchParams.get('before') || 0);
    if (!q.userById.get(other)) return json(res, 404, { error: 'no user' });
    return json(res, 200, q.history.all(me.id, other, before).reverse());
  }
  if (url.pathname === '/api/push/key') return json(res, 200, { key: vapidPublic });
  if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
    const b = await readJson(req);
    const ep = String(b.endpoint || ''), p = String(b.keys?.p256dh || ''), a = String(b.keys?.auth || '');
    if (!ep.startsWith('https://') || !p || !a || ep.length > 1000) return json(res, 400, { error: 'bad subscription' });
    q.addSub.run(me.id, ep, p, a, Date.now());
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    q.delSub.run(String((await readJson(req)).endpoint || ''));
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'not found' });
}

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const online = new Map(); // userId -> Set<ws>

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  const me = userFromReq(req);
  // защита от чужих сайтов: Origin должен совпадать с Host
  const sameOrigin = !origin || new URL(origin).host === req.headers.host;
  if (url.pathname !== '/ws' || !me || !sameOrigin) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.user = me; wss.emit('connection', ws); });
});

const send = (userId, obj) => online.get(userId)?.forEach((ws) => ws.readyState === 1 && ws.send(JSON.stringify(obj)));
const presence = () => [...online.keys()];
const broadcastPresence = () => { for (const id of online.keys()) send(id, { type: 'presence', online: presence() }); };

wss.on('connection', (ws) => {
  const me = ws.user;
  if (!online.has(me.id)) online.set(me.id, new Set());
  online.get(me.id).add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  broadcastPresence();

  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'vis') { ws.visible = m.visible === true; return; }
    if (m.type !== 'msg') return;
    const to = Number(m.to), text = String(m.text || '').trim().slice(0, 4000);
    if (!text || to === me.id || !q.userById.get(to)) return;
    const created = Date.now();
    const r = q.addMsg.run(me.id, to, text, created);
    const msg = { id: Number(r.lastInsertRowid), from_id: me.id, to_id: to, text, created_at: created };
    send(to, { type: 'msg', msg });
    send(me.id, { type: 'msg', msg, cid: m.cid });
    // push, если получатель сейчас не смотрит в приложение (iOS требует показывать каждое push-уведомление)
    const watching = [...(online.get(to) || [])].some((w) => w.visible === true);
    if (!watching) pushTo(to, { title: me.username, body: text.slice(0, 200), from: me.id });
  });
  ws.on('close', () => {
    online.get(me.id)?.delete(ws);
    if (!online.get(me.id)?.size) online.delete(me.id);
    broadcastPresence();
  });
});

// пинг, чтобы убирать "мёртвые" соединения (мобильные сети часто рвутся молча)
setInterval(() => {
  for (const set of online.values()) for (const ws of set) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25_000);

server.listen(PORT, HOST, () => console.log(`Chat on http://${HOST}:${PORT} (регистрация ${INVITE ? 'по коду' : 'ЗАКРЫТА — задай INVITE_CODE'})`));
