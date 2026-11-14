// Тестовое push-уведомление пользователю: node deploy/test-push.mjs <имя> [текст]
// Запускать от пользователя duoverse:  DB_PATH=/var/lib/duoverse/chat.db
import { DatabaseSync } from 'node:sqlite';
import * as webpush from 'web-push';

const [name, ...rest] = process.argv.slice(2);
if (!name) { console.error('Использование: node deploy/test-push.mjs <имя> [текст]'); process.exit(1); }
const db = new DatabaseSync(process.env.DB_PATH || 'data/chat.db');
const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(name.toLowerCase());
if (user === undefined) { console.error('Нет такого пользователя'); process.exit(1); }
const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(user.id);
console.log('Подписок у пользователя:', subs.length);
if (subs.length === 0) { console.log('Нет подписок: сначала включи уведомления в приложении.'); process.exit(0); }

webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://duoverse-app.org', get('vapid_public'), get('vapid_private'));
for (const s of subs) {
  const host = new URL(s.endpoint).host;
  try {
    const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify({ title: 'DuoVerse', body: rest.join(' ') || 'Тестовое уведомление ✅', from: 0 }), { TTL: 60 });
    console.log(host, '-> принято, статус', r.statusCode);
  } catch (e) {
    console.log(host, '-> ОШИБКА', e.statusCode || '', e.body || e.message);
  }
}
