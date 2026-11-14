// Консистентная копия базы (VACUUM INTO) + хранение последних 14 копий.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const src = process.env.DB_PATH, dir = process.env.BACKUP_DIR;
if (!src || !dir) { console.error('нужны DB_PATH и BACKUP_DIR'); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `chat-${new Date().toISOString().slice(0, 10)}.db`);
fs.rmSync(out, { force: true });
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
const files = fs.readdirSync(dir).filter((f) => /^chat-.*\.db$/.test(f)).sort();
for (const f of files.slice(0, -14)) fs.rmSync(path.join(dir, f));
console.log('backup ok:', out);
