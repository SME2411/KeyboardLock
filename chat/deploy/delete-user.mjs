// Удаление пользователя вместе со всеми его данными.
//   node deploy/delete-user.mjs                 — список пользователей
//   node deploy/delete-user.mjs <имя>           — показать, что будет удалено
//   node deploy/delete-user.mjs <имя> --yes     — удалить (НЕОБРАТИМО)
// Запускать от пользователя duoverse:  DB_PATH=/var/lib/duoverse/chat.db
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || 'data/chat.db';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
const [name, flag] = process.argv.slice(2);
const db = new DatabaseSync(DB_PATH);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const fmt = (t) => (t ? new Date(t).toLocaleString('ru') : '—');

if (!name) {
  console.log('Пользователи:');
  for (const u of db.prepare('SELECT id, username, display_name, created_at, last_seen FROM users ORDER BY id').all()) {
    const n = one('SELECT COUNT(*) AS n FROM messages WHERE from_id = ?1 OR to_id = ?1', u.id).n;
    console.log(`  #${u.id}  ${u.username.padEnd(16)} имя: ${(u.display_name || '—').padEnd(14)} сообщений: ${String(n).padEnd(5)} создан: ${fmt(u.created_at)}  заходил: ${fmt(u.last_seen)}`);
  }
  process.exit(0);
}

const u = one('SELECT id, username FROM users WHERE username = ?', name.toLowerCase());
if (u === undefined) { console.error(`Нет пользователя «${name}». Запустите без параметров, чтобы увидеть список.`); process.exit(1); }
const files = db.prepare('SELECT id FROM files WHERE owner_id = ?1 OR to_id = ?1').all(u.id);
const stats = {
  'сообщений (отправленных и полученных)': one('SELECT COUNT(*) AS n FROM messages WHERE from_id = ?1 OR to_id = ?1', u.id).n,
  'файлов': files.length,
  'входов (устройств)': one('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', u.id).n,
  'push-подписок': one('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', u.id).n,
};
console.log(`Пользователь #${u.id} «${u.username}». Будет удалено:`);
for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
if (flag !== '--yes') { console.log('\nНичего не удалено. Чтобы удалить НАВСЕГДА, добавьте --yes'); process.exit(0); }

db.exec('BEGIN');
try {
  db.prepare('DELETE FROM messages WHERE from_id = ?1 OR to_id = ?1').run(u.id);
  db.prepare('DELETE FROM files WHERE owner_id = ?1 OR to_id = ?1').run(u.id);
  db.prepare('DELETE FROM reads WHERE user_id = ?1 OR peer_id = ?1').run(u.id);
  db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('Ошибка, ничего не удалено:', e.message); process.exit(1); }
for (const f of files) fs.rmSync(path.join(UPLOAD_DIR, f.id), { force: true });
fs.rmSync(path.join(UPLOAD_DIR, 'avatars', String(u.id)), { force: true });
console.log(`\nГотово: «${u.username}» удалён со всеми данными. Перезапустите сервис: systemctl restart duoverse`);
