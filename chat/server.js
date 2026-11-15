import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
const MAX_FILE = Number(process.env.MAX_FILE_MB || 100) * 1024 * 1024;        // максимум на один файл
const MAX_STORAGE = Number(process.env.MAX_STORAGE_GB || 15) * 1024 ** 3;       // максимум на все файлы вместе

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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
  CREATE TABLE IF NOT EXISTS reads (user_id INTEGER NOT NULL, peer_id INTEGER NOT NULL, last_id INTEGER NOT NULL, PRIMARY KEY (user_id, peer_id));
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, to_id INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, w INTEGER, h INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
`);

try { db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER'); } catch { /* колонка уже есть */ }
try { db.exec('ALTER TABLE messages ADD COLUMN file_id TEXT'); } catch { /* колонка уже есть */ }

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  addUser: db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)'),
  allUsers: db.prepare('SELECT id, username, last_seen FROM users ORDER BY username'),
  touchSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
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
  history: db.prepare(`SELECT m.id, m.from_id, m.to_id, m.text, m.created_at,
      f.id AS fid, f.name AS fname, f.mime AS fmime, f.size AS fsize, f.w AS fw, f.h AS fh
    FROM messages m LEFT JOIN files f ON f.id = m.file_id
    WHERE ((m.from_id = ?1 AND m.to_id = ?2) OR (m.from_id = ?2 AND m.to_id = ?1)) AND (?3 = 0 OR m.id < ?3)
    ORDER BY m.id DESC LIMIT 50`),
  lastMsg: db.prepare(`SELECT m.id, m.from_id, m.text, m.created_at, f.mime AS fmime, f.name AS fname
    FROM messages m LEFT JOIN files f ON f.id = m.file_id
    WHERE (m.from_id = ?1 AND m.to_id = ?2) OR (m.from_id = ?2 AND m.to_id = ?1) ORDER BY m.id DESC LIMIT 1`),
  unreadCount: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE from_id = ?1 AND to_id = ?2
    AND id > COALESCE((SELECT last_id FROM reads WHERE user_id = ?2 AND peer_id = ?1), 0)`),
  setRead: db.prepare(`INSERT INTO reads (user_id, peer_id, last_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, peer_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`),
  addFile: db.prepare('INSERT INTO files (id, owner_id, to_id, name, mime, size, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  addFileMsg: db.prepare('INSERT INTO messages (from_id, to_id, text, created_at, file_id) VALUES (?, ?, ?, ?, ?)'),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  usage: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files'),
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


// ---------- файлы ----------
const INLINE_MIME = /^(image\/(jpeg|png|gif|webp|avif|heic|heif)|video\/(mp4|quicktime|webm|x-m4v)|audio\/(mpeg|mp4|x-m4a|aac|webm|ogg|wav|x-wav))$/;
const rowToMsg = (r) => ({
  id: r.id, from_id: r.from_id, to_id: r.to_id, text: r.text, created_at: r.created_at,
  ...(r.fid ? { file: { id: r.fid, name: r.fname, mime: r.fmime, size: r.fsize, w: r.fw, h: r.fh } } : {}),
});
const cleanName = (n) => String(n || 'file').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim().slice(0, 150) || 'file';
const cleanMime = (m) => (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(m || '').split(';')[0].trim()) ? String(m).split(';')[0].trim().toLowerCase() : 'application/octet-stream');
const dim = (v) => { const n = Math.round(Number(v)); return n > 0 && n <= 20000 ? n : null; };
const previewText = (mime, name, caption) => caption || (mime.startsWith('image/') ? '📷 Фото' : mime.startsWith('video/') ? '🎬 Видео' : mime.startsWith('audio/') ? '🎵 Аудио' : '📎 ' + name);

async function handleUpload(req, res, me, url) {
  const to = Number(url.searchParams.get('to'));
  if (!q.userById.get(to)) return json(res, 400, { error: 'Неверный получатель' });
  const len = Number(req.headers['content-length'] || 0);
  if (!len) return json(res, 411, { error: 'Пустой файл' });
  if (len > MAX_FILE) return json(res, 413, { error: `Файл больше ${Math.round(MAX_FILE / 1048576)} МБ` });
  if (q.usage.get().n + len > MAX_STORAGE) return json(res, 507, { error: 'На сервере закончилось место для файлов' });

  const name = cleanName(decodeURIComponent(String(req.headers['x-filename'] || 'file')));
  const mime = cleanMime(req.headers['content-type']);
  const caption = String(url.searchParams.get('caption') || '').trim().slice(0, 1000);
  const id = crypto.randomBytes(16).toString('hex');
  const tmp = path.join(UPLOAD_DIR, id + '.part'), final = path.join(UPLOAD_DIR, id);

  let bytes = 0;
  const limiter = new Transform({ transform(chunk, _e, cb) { bytes += chunk.length; cb(bytes > MAX_FILE ? new Error('too big') : null, chunk); } });
  try { await pipeline(req, limiter, fs.createWriteStream(tmp)); }
  catch { fs.rmSync(tmp, { force: true }); if (!res.writableEnded && !res.destroyed) json(res, 413, { error: 'Загрузка прервана' }); return; }
  if (bytes === 0) { fs.rmSync(tmp, { force: true }); return json(res, 400, { error: 'Пустой файл' }); }
  fs.renameSync(tmp, final);

  const created = Date.now(), w = dim(url.searchParams.get('w')), h = dim(url.searchParams.get('h'));
  q.addFile.run(id, me.id, to, name, mime, bytes, w, h, created);
  const r = q.addFileMsg.run(me.id, to, caption, created, id);
  const msg = { id: Number(r.lastInsertRowid), from_id: me.id, to_id: to, text: caption, created_at: created, file: { id, name, mime, size: bytes, w, h } };
  if (to !== me.id) send(to, { type: 'msg', msg });
  send(me.id, { type: 'msg', msg });
  if (to !== me.id && ![...(online.get(to) || [])].some((x) => x.visible === true)) pushTo(to, { title: me.username, body: previewText(mime, name, caption), from: me.id });
  json(res, 200, { ok: true, id: msg.id });
}

function serveFile(req, res, me, url, id) {
  const f = /^[a-f0-9]{32}$/.test(id) ? q.fileById.get(id) : undefined;
  if (!f || (f.owner_id !== me.id && f.to_id !== me.id)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(UPLOAD_DIR, f.id);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const inline = INLINE_MIME.test(f.mime) && url.searchParams.get('dl') !== '1';
  const headers = {
    'Content-Type': inline ? f.mime : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=31536000, immutable', 'Accept-Ranges': 'bytes',   // Range нужен для видео на iPhone
  };
  let start = 0, end = f.size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); } else { start = Math.max(0, f.size - Number(m[2])); }
    if (start > end || start >= f.size) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
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
  if (url.pathname === '/api/chats') {   // все чаты, включая «Избранное» (чат с самим собой)
    return json(res, 200, q.allUsers.all().map((u) => {
      const l = q.lastMsg.get(me.id, u.id);
      return { id: u.id, username: u.username, last_seen: u.last_seen, self: u.id === me.id,
        unread: u.id === me.id ? 0 : q.unreadCount.get(u.id, me.id).n,
        last: l ? { id: l.id, from_id: l.from_id, text: l.text, created_at: l.created_at, file: l.fmime ? { mime: l.fmime, name: l.fname } : null } : null };
    }));
  }
  if (url.pathname === '/api/read' && req.method === 'POST') {
    const b = await readJson(req), peer = Number(b.with), upto = Number(b.upto);
    if (q.userById.get(peer) && Number.isInteger(upto) && upto > 0) q.setRead.run(me.id, peer, upto);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') return await handleUpload(req, res, me, url);
  if (url.pathname.startsWith('/api/file/') && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, me, url, url.pathname.slice(10));
  if (url.pathname === '/api/me') return json(res, 200, me);
  if (url.pathname === '/api/users') return json(res, 200, q.allUsers.all().filter((u) => u.id !== me.id));
  if (url.pathname === '/api/messages') {
    const other = Number(url.searchParams.get('with')), before = Number(url.searchParams.get('before') || 0);
    if (!q.userById.get(other)) return json(res, 404, { error: 'no user' });
    return json(res, 200, q.history.all(me.id, other, before).reverse().map(rowToMsg));
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

const ACTIONS = new Set(['typing', 'voice', 'video', 'photo', 'file']);
const send = (userId, obj) => online.get(userId)?.forEach((ws) => ws.readyState === 1 && ws.send(JSON.stringify(obj)));
const presence = () => [...online.keys()];
const broadcastPresence = (extra = {}) => { for (const id of online.keys()) send(id, { type: 'presence', online: presence(), ...extra }); };

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
    if (m.type === 'act') {   // действие («печатает», «записывает голосовое»…): пересылаем собеседнику, в базу не пишем
      const t = Number(m.to);
      if (ACTIONS.has(m.kind) && t !== me.id && q.userById.get(t)) send(t, { type: 'act', from: me.id, kind: m.kind });
      return;
    }
    if (m.type !== 'msg') return;
    const to = Number(m.to), text = String(m.text || '').trim().slice(0, 4000);
    if (!text || !q.userById.get(to)) return;
    const created = Date.now();
    const r = q.addMsg.run(me.id, to, text, created);
    const msg = { id: Number(r.lastInsertRowid), from_id: me.id, to_id: to, text, created_at: created };
    if (to !== me.id) send(to, { type: 'msg', msg });
    send(me.id, { type: 'msg', msg, cid: m.cid });
    // push, если получатель сейчас не смотрит в приложение (iOS требует показывать каждое push-уведомление)
    const watching = [...(online.get(to) || [])].some((w) => w.visible === true);
    if (to !== me.id && !watching) pushTo(to, { title: me.username, body: text.slice(0, 200), from: me.id });
  });
  ws.on('close', () => {
    online.get(me.id)?.delete(ws);
    if (!online.get(me.id)?.size) {
      online.delete(me.id);
      const at = Date.now();
      q.touchSeen.run(at, me.id);
      broadcastPresence({ left: { id: me.id, at } });
    } else broadcastPresence();
  });
});

// пинг, чтобы убирать "мёртвые" соединения (мобильные сети часто рвутся молча)
setInterval(() => {
  for (const set of online.values()) for (const ws of set) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25_000);

server.requestTimeout = 30 * 60 * 1000;   // большие файлы по мобильной сети могут грузиться долго
server.listen(PORT, HOST, () => console.log(`Chat on http://${HOST}:${PORT} (регистрация ${INVITE ? 'по коду' : 'ЗАКРЫТА — задай INVITE_CODE'})`));
