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
const VIS_TTL = Number(process.env.VIS_TTL_MS || 30000);   // как долго «я на экране» считается свежим без сердцебиения

function computeVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(PUBLIC).sort()) { const fp = path.join(PUBLIC, f); if (fs.statSync(fp).isFile()) h.update(f).update(fs.readFileSync(fp)); }
  return h.digest('hex').slice(0, 8);
}
const APP_VERSION = computeVersion();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars'); fs.mkdirSync(AVATAR_DIR, { recursive: true });
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
  CREATE TABLE IF NOT EXISTS reactions (msg_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (msg_id, user_id));
  CREATE TABLE IF NOT EXISTS pins (a INTEGER NOT NULL, b INTEGER NOT NULL, msg_id INTEGER NOT NULL, PRIMARY KEY (a, b));
  CREATE TABLE IF NOT EXISTS hidden_msgs (user_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, PRIMARY KEY (user_id, msg_id));
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
for (const stmt of ['ALTER TABLE messages ADD COLUMN reply_to INTEGER', 'ALTER TABLE messages ADD COLUMN edited_at INTEGER', 'ALTER TABLE sessions ADD COLUMN ua TEXT', 'ALTER TABLE sessions ADD COLUMN last_active INTEGER', 'ALTER TABLE push_subs ADD COLUMN sid TEXT']) {
  try { db.exec(stmt); } catch { /* уже есть */ }
}
for (const col of ['display_name TEXT', 'bio TEXT', 'avatar_v INTEGER', 'cover TEXT']) {
  try { db.exec('ALTER TABLE users ADD COLUMN ' + col); } catch { /* колонка уже есть */ }
}

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  addUser: db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)'),
  allUsers: db.prepare('SELECT id, username, last_seen, display_name, bio, avatar_v, cover FROM users ORDER BY username'),
  userFull: db.prepare('SELECT id, username, display_name, bio, avatar_v, cover FROM users WHERE id = ?'),
  setProfile: db.prepare('UPDATE users SET display_name = ?, bio = ?, cover = ? WHERE id = ?'),
  setAvatarV: db.prepare('UPDATE users SET avatar_v = ? WHERE id = ?'),
  touchSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  addSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, ua, last_active) VALUES (?, ?, ?, ?, ?)'),
  touchSession: db.prepare('UPDATE sessions SET last_active = ? WHERE token = ? AND (last_active IS NULL OR last_active < ?)'),
  sessionsOf: db.prepare('SELECT token, ua, created_at, last_active FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_active, created_at) DESC'),
  delSessionByToken: db.prepare('DELETE FROM sessions WHERE token = ? AND user_id = ?'),
  delSubsBySid: db.prepare('DELETE FROM push_subs WHERE user_id = ? AND sid = ?'),
  allPeers: db.prepare('SELECT id FROM users WHERE id != ?'),
  peerRead: db.prepare('SELECT last_id FROM reads WHERE user_id = ? AND peer_id = ?'),
  sessionUser: db.prepare('SELECT u.id, u.username, u.display_name, u.bio, u.avatar_v, u.cover FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  addMsg: db.prepare('INSERT INTO messages (from_id, to_id, text, created_at, reply_to) VALUES (?, ?, ?, ?, ?)'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  addSub: db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at, sid) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, sid = excluded.sid`),
  subsOf: db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'),
  delSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
  history: db.prepare(`SELECT m.id, m.from_id, m.to_id, m.text, m.created_at, m.reply_to, m.edited_at,
      f.id AS fid, f.name AS fname, f.mime AS fmime, f.size AS fsize, f.w AS fw, f.h AS fh,
      r.id AS rid, r.from_id AS rfrom, r.text AS rtext, rf.mime AS rmime, rf.name AS rname
    FROM messages m LEFT JOIN files f ON f.id = m.file_id
    LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN files rf ON rf.id = r.file_id
    WHERE ((m.from_id = ?1 AND m.to_id = ?2) OR (m.from_id = ?2 AND m.to_id = ?1)) AND (?3 = 0 OR m.id < ?3)
      AND NOT EXISTS (SELECT 1 FROM hidden_msgs h WHERE h.user_id = ?1 AND h.msg_id = m.id)
    ORDER BY m.id DESC LIMIT 50`),
  getPin: db.prepare('SELECT msg_id FROM pins WHERE a = ? AND b = ?'),
  setPin: db.prepare('INSERT OR REPLACE INTO pins (a, b, msg_id) VALUES (?, ?, ?)'),
  delPin: db.prepare('DELETE FROM pins WHERE a = ? AND b = ?'),
  searchRows: db.prepare(`SELECT m.id, m.from_id, m.text, m.created_at, f.mime AS fmime, f.name AS fname
    FROM messages m LEFT JOIN files f ON f.id = m.file_id
    WHERE ((m.from_id = ?1 AND m.to_id = ?2) OR (m.from_id = ?2 AND m.to_id = ?1))
      AND NOT EXISTS (SELECT 1 FROM hidden_msgs h WHERE h.user_id = ?1 AND h.msg_id = m.id)
    ORDER BY m.id DESC LIMIT 20000`),
  oneMsg: db.prepare(`SELECT m.id, m.from_id, m.to_id, m.text, m.created_at, m.reply_to, m.edited_at,
      f.id AS fid, f.name AS fname, f.mime AS fmime, f.size AS fsize, f.w AS fw, f.h AS fh,
      r.id AS rid, r.from_id AS rfrom, r.text AS rtext, rf.mime AS rmime, rf.name AS rname
    FROM messages m LEFT JOIN files f ON f.id = m.file_id
    LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN files rf ON rf.id = r.file_id WHERE m.id = ?`),
  msgById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  updText: db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?'),
  delMsg: db.prepare('DELETE FROM messages WHERE id = ?'),
  delFile: db.prepare('DELETE FROM files WHERE id = ?'),
  getReact: db.prepare('SELECT user_id, emoji FROM reactions WHERE msg_id = ?'),
  setReact: db.prepare('INSERT INTO reactions (msg_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT(msg_id, user_id) DO UPDATE SET emoji = excluded.emoji'),
  delReact: db.prepare('DELETE FROM reactions WHERE msg_id = ? AND user_id = ?'),
  delReactsOf: db.prepare('DELETE FROM reactions WHERE msg_id = ?'),
  hideMsg: db.prepare('INSERT OR IGNORE INTO hidden_msgs (user_id, msg_id) VALUES (?, ?)'),
  delHiddenOf: db.prepare('DELETE FROM hidden_msgs WHERE msg_id = ?'),
  lastMsg: db.prepare(`SELECT m.id, m.from_id, m.text, m.created_at, f.mime AS fmime, f.name AS fname
    FROM messages m LEFT JOIN files f ON f.id = m.file_id
    WHERE ((m.from_id = ?1 AND m.to_id = ?2) OR (m.from_id = ?2 AND m.to_id = ?1))
      AND NOT EXISTS (SELECT 1 FROM hidden_msgs h WHERE h.user_id = ?1 AND h.msg_id = m.id) ORDER BY m.id DESC LIMIT 1`),
  unreadCount: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE from_id = ?1 AND to_id = ?2
    AND NOT EXISTS (SELECT 1 FROM hidden_msgs h WHERE h.user_id = ?2 AND h.msg_id = messages.id)
    AND id > COALESCE((SELECT last_id FROM reads WHERE user_id = ?2 AND peer_id = ?1), 0)`),
  setRead: db.prepare(`INSERT INTO reads (user_id, peer_id, last_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, peer_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`),
  addFile: db.prepare('INSERT INTO files (id, owner_id, to_id, name, mime, size, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  addFileMsg: db.prepare('INSERT INTO messages (from_id, to_id, text, created_at, file_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)'),
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
const snippet = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 120);
const rowToMsg = (r) => ({
  id: r.id, from_id: r.from_id, to_id: r.to_id, text: r.text, created_at: r.created_at,
  ...(r.edited_at ? { edited_at: r.edited_at } : {}),
  ...(r.fid ? { file: { id: r.fid, name: r.fname, mime: r.fmime, size: r.fsize, w: r.fw, h: r.fh } } : {}),
  ...(r.reply_to ? { reply_to: r.reply_to, reply: r.rid ? { id: r.rid, from_id: r.rfrom, text: snippet(r.rtext), file: r.rmime ? { mime: r.rmime, name: r.rname } : null } : { id: r.reply_to, deleted: true } } : {}),
  reactions: q.getReact.all(r.id),
});
const totalUnread = (uid) => q.allPeers.all(uid).reduce((n, u) => n + q.unreadCount.get(u.id, uid).n, 0);
const pairKey = (x, y) => [Math.min(x, y), Math.max(x, y)];
const pinInfo = (x, y) => {   // закреплённое сообщение переписки (одно на чат) в коротком виде
  const [a, b] = pairKey(x, y), pin = q.getPin.get(a, b); if (!pin) return null;
  const r = q.oneMsg.get(pin.msg_id); if (!r) return null;
  return { id: r.id, from_id: r.from_id, text: snippet(r.text), file: r.fmime ? { mime: r.fmime, name: r.fname } : null };
};
const fullMsg = (id) => rowToMsg(q.oneMsg.get(id));
const pairSend = (a, b, obj) => { send(a, obj); if (b !== a) send(b, obj); };   // обоим участникам (себе в «Избранном» — один раз)
// проверка: ответ можно давать только на сообщение из этой же переписки
const validReply = (id, a, b) => { const m = Number.isInteger(id) && id > 0 ? q.msgById.get(id) : null; return m && ((m.from_id === a && m.to_id === b) || (m.from_id === b && m.to_id === a)) ? id : null; };
const REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👎']);

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
  const replyTo = validReply(Number(url.searchParams.get('reply')), me.id, to);
  const r = q.addFileMsg.run(me.id, to, caption, created, id, replyTo);
  const msg = fullMsg(Number(r.lastInsertRowid));
  if (to !== me.id) send(to, { type: 'msg', msg });
  send(me.id, { type: 'msg', msg });
  if (to !== me.id && !isWatching(to)) pushTo(to, { title: me.display_name || me.username, body: previewText(mime, name, caption), from: me.id, badge: totalUnread(to) });
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


// ---------- профиль и аватарки ----------
const COVER_RE = /^c[1-9]$/;
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const cleanText = (v, max) => String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
const publicProfile = (id) => q.userFull.get(id);
const broadcastAll = (obj) => { for (const id of online.keys()) send(id, obj); };

function readBody(req, max) {   // читает тело; при превышении лимита дочитывает до конца (чтобы можно было ответить 413), но не копит
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', (c) => { n += c.length; if (n > max) over = true; else if (!over) chunks.push(c); });
    req.on('end', () => (over ? reject(new Error('too big')) : resolve(Buffer.concat(chunks)))); req.on('error', reject);
  });
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
  if (!t) return undefined;
  const u = q.sessionUser.get(t);
  if (u) { const now = Date.now(); q.touchSession.run(now, t, now - 5 * 60 * 1000); }   // «последняя активность» не чаще раза в 5 минут
  return u;
};
const sidOf = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);   // публичный id сеанса: токен наружу не отдаём
const reqSid = (req) => { const t = parseCookies(req.headers.cookie).sid; return t ? sidOf(t) : null; };
function deviceLabel(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  const br = /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /EdgA?\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : null;
  return os || br ? [os, br].filter(Boolean).join(' · ') : 'Неизвестное устройство';
}
function startSession(res, userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  q.addSession.run(token, userId, Date.now(), String(req?.headers['user-agent'] || '').slice(0, 300), Date.now());
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
  if (url.pathname === '/api/version') return json(res, 200, { v: APP_VERSION });
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
      startSession(res, Number(r.lastInsertRowid), req);
      return json(res, 200, { ok: true });
    }
    const u = q.userByName.get(username);
    if (!u || !safeEq(hashPw(password, u.salt), u.hash)) { noteAttempt(ip); return json(res, 401, { error: 'Неверное имя или пароль' }); }
    startSession(res, u.id, req);
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
        display_name: u.display_name, bio: u.bio, avatar_v: u.avatar_v, cover: u.cover,
        peer_read: u.id === me.id ? 0 : (q.peerRead.get(u.id, me.id)?.last_id || 0), pinned: pinInfo(me.id, u.id),
        unread: u.id === me.id ? 0 : q.unreadCount.get(u.id, me.id).n,
        last: l ? { id: l.id, from_id: l.from_id, text: l.text, created_at: l.created_at, file: l.fmime ? { mime: l.fmime, name: l.fname } : null } : null };
    }));
  }
  if (url.pathname === '/api/read' && req.method === 'POST') {
    const b = await readJson(req), peer = Number(b.with), upto = Number(b.upto);
    if (q.userById.get(peer) && Number.isInteger(upto) && upto > 0) {
      q.setRead.run(me.id, peer, upto);
      if (peer !== me.id) send(peer, { type: 'read', by: me.id, upto });   // у собеседника появятся ✓✓
    }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/edit' && req.method === 'POST') {
    const b = await readJson(req), m = q.msgById.get(Number(b.id)), text = String(b.text || '').trim().slice(0, 4000);
    if (!m || m.from_id !== me.id) return json(res, 403, { error: 'Изменить можно только своё сообщение' });
    if (!text && !m.file_id) return json(res, 400, { error: 'Пустой текст' });
    const at = Date.now(); q.updText.run(text, at, m.id);
    pairSend(m.from_id, m.to_id, { type: 'edit', id: m.id, text, edited_at: at });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/delete' && req.method === 'POST') {   // all:true — у обоих (только автор); иначе скрыть у себя
    const b = await readJson(req), m = q.msgById.get(Number(b.id));
    if (!m || (m.from_id !== me.id && m.to_id !== me.id)) return json(res, 404, { error: 'Нет такого сообщения' });
    if (b.all === true) {
      if (m.from_id !== me.id) return json(res, 403, { error: 'У обоих можно удалить только своё сообщение' });
      if (m.file_id) { q.delFile.run(m.file_id); fs.rmSync(path.join(UPLOAD_DIR, m.file_id), { force: true }); }
      const [pa, pb] = pairKey(m.from_id, m.to_id), wasPinned = q.getPin.get(pa, pb)?.msg_id === m.id;
      q.delReactsOf.run(m.id); q.delHiddenOf.run(m.id); q.delMsg.run(m.id);
      if (wasPinned) { q.delPin.run(pa, pb); pairSend(m.from_id, m.to_id, { type: 'pin', peers: [m.from_id, m.to_id], pinned: null }); }
      pairSend(m.from_id, m.to_id, { type: 'del', id: m.id });
    } else { q.hideMsg.run(me.id, m.id); send(me.id, { type: 'del', id: m.id }); }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/react' && req.method === 'POST') {
    const b = await readJson(req), m = q.msgById.get(Number(b.id));
    if (!m || (m.from_id !== me.id && m.to_id !== me.id)) return json(res, 404, { error: 'Нет такого сообщения' });
    const emoji = b.emoji == null ? null : String(b.emoji);
    if (emoji !== null && !REACTIONS.has(emoji)) return json(res, 400, { error: 'Такой реакции нет' });
    if (emoji === null) q.delReact.run(m.id, me.id); else q.setReact.run(m.id, me.id, emoji);
    pairSend(m.from_id, m.to_id, { type: 'react', id: m.id, user_id: me.id, emoji });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/pin' && req.method === 'POST') {
    const b = await readJson(req), m = q.msgById.get(Number(b.id));
    if (!m || (m.from_id !== me.id && m.to_id !== me.id)) return json(res, 404, { error: 'Нет такого сообщения' });
    const [a, c] = pairKey(m.from_id, m.to_id);
    if (b.pin === false) { if (q.getPin.get(a, c)?.msg_id === m.id) q.delPin.run(a, c); } else q.setPin.run(a, c, m.id);
    pairSend(m.from_id, m.to_id, { type: 'pin', peers: [m.from_id, m.to_id], pinned: pinInfo(m.from_id, m.to_id) });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/search' && req.method === 'GET') {   // поиск без учёта регистра (в SQLite LIKE не понимает кириллицу)
    const other = Number(url.searchParams.get('with')), term = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    if (!q.userById.get(other) || !term) return json(res, 200, []);
    const out = [];
    for (const r of q.searchRows.all(me.id, other)) {
      if (`${r.text || ''}\n${r.fname || ''}`.toLowerCase().includes(term)) {
        out.push({ id: r.id, from_id: r.from_id, text: String(r.text || '').slice(0, 300), created_at: r.created_at, file: r.fmime ? { mime: r.fmime, name: r.fname } : null });
        if (out.length >= 50) break;
      }
    }
    return json(res, 200, out);
  }
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const cur = reqSid(req);
    return json(res, 200, q.sessionsOf.all(me.id).map((x) => ({ id: sidOf(x.token), device: deviceLabel(x.ua), created_at: x.created_at, last_active: x.last_active || x.created_at, current: sidOf(x.token) === cur })));
  }
  if (url.pathname === '/api/sessions' && req.method === 'DELETE') {   // завершить сеанс (?id=…) или все, кроме текущего (?others=1)
    const cur = reqSid(req), target = url.searchParams.get('id'), others = url.searchParams.get('others') === '1';
    let n = 0;
    for (const x of q.sessionsOf.all(me.id)) {
      const sid = sidOf(x.token);
      if (sid === cur || !(others || sid === target)) continue;
      q.delSessionByToken.run(x.token, me.id); q.delSubsBySid.run(me.id, sid); n++;
      for (const w of online.get(me.id) || []) if (w.sid === sid) w.close(4001, 'revoked');   // открытое соединение того устройства закрываем
    }
    return json(res, 200, { ok: true, ended: n });
  }
  if (url.pathname === '/api/me' && req.method === 'PUT') {
    const b = await readJson(req);
    const name = cleanText(b.display_name, 30), bio = cleanText(b.bio, 140), cover = COVER_RE.test(String(b.cover || '')) ? b.cover : null;
    q.setProfile.run(name || null, bio || null, cover, me.id);
    broadcastAll({ type: 'profile', user: publicProfile(me.id) });
    return json(res, 200, publicProfile(me.id));
  }
  if (url.pathname === '/api/avatar' && req.method === 'POST') {
    if (Number(req.headers['content-length'] || 0) > 20 * 1024 * 1024) { req.destroy(); return; }   // явный мусор не дочитываем
    let buf; try { buf = await readBody(req, 1024 * 1024); } catch { return json(res, 413, { error: 'Фото больше 1 МБ' }); }
    if (!sniffImage(buf)) return json(res, 400, { error: 'Нужна картинка JPEG, PNG или WebP' });
    fs.writeFileSync(path.join(AVATAR_DIR, String(me.id)), buf);
    const v = Date.now(); q.setAvatarV.run(v, me.id);
    broadcastAll({ type: 'profile', user: publicProfile(me.id) });
    return json(res, 200, { ok: true, avatar_v: v });
  }
  if (url.pathname === '/api/avatar' && req.method === 'DELETE') {
    fs.rmSync(path.join(AVATAR_DIR, String(me.id)), { force: true }); q.setAvatarV.run(null, me.id);
    broadcastAll({ type: 'profile', user: publicProfile(me.id) });
    return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith('/api/avatar/') && req.method === 'GET') {
    const uid = Number(url.pathname.slice(12)), file = path.join(AVATAR_DIR, String(uid));
    if (!Number.isInteger(uid) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    const buf = fs.readFileSync(file), mime = sniffImage(buf);
    if (!mime) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(buf);
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') return await handleUpload(req, res, me, url);
  if (url.pathname.startsWith('/api/file/') && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, me, url, url.pathname.slice(10));
  if (url.pathname === '/api/me') return json(res, 200, publicProfile(me.id));
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
    q.addSub.run(me.id, ep, p, a, Date.now(), reqSid(req));
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
  wss.handleUpgrade(req, socket, head, (ws) => { ws.user = me; ws.sid = reqSid(req); wss.emit('connection', ws); });
});

const ACTIONS = new Set(['typing', 'voice', 'video', 'photo', 'file']);
const isWatching = (uid) => [...(online.get(uid) || [])].some((w) => w.visible === true && Date.now() - (w.visAt || 0) < VIS_TTL);
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
    if (m.type === 'vis') { ws.visible = m.visible === true; ws.visAt = Date.now(); return; }
    if (m.type === 'act') {   // действие («печатает», «записывает голосовое»…): пересылаем собеседнику, в базу не пишем
      const t = Number(m.to);
      if (ACTIONS.has(m.kind) && t !== me.id && q.userById.get(t)) send(t, { type: 'act', from: me.id, kind: m.kind });
      return;
    }
    if (m.type !== 'msg') return;
    const to = Number(m.to), text = String(m.text || '').trim().slice(0, 4000);
    if (!text || !q.userById.get(to)) return;
    const created = Date.now();
    const replyTo = validReply(Number(m.reply), me.id, to);
    const r = q.addMsg.run(me.id, to, text, created, replyTo);
    const msg = fullMsg(Number(r.lastInsertRowid));
    if (to !== me.id) send(to, { type: 'msg', msg });
    send(me.id, { type: 'msg', msg, cid: m.cid });
    // push, если получатель сейчас не смотрит в приложение (iOS требует показывать каждое push-уведомление)
    const watching = isWatching(to);
    if (to !== me.id && !watching) pushTo(to, { title: me.display_name || me.username, body: text.slice(0, 200), from: me.id, badge: totalUnread(to) });
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
