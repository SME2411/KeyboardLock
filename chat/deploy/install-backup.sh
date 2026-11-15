#!/usr/bin/env bash
# Включает ежедневный бэкап базы (04:00) и сразу делает первую копию. Безопасно запускать повторно.
#   bash /opt/duoverse/chat/deploy/install-backup.sh
set -euo pipefail
command -v cron >/dev/null || { apt-get update -qq && apt-get install -y cron; }
systemctl enable --now cron >/dev/null 2>&1 || true
mkdir -p /var/backups/duoverse && chown duoverse: /var/backups/duoverse
# Задача идёт от root (он открывает лог), а сам бэкап запускается от duoverse
cat > /etc/cron.d/duoverse-backup <<'EOT'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 4 * * * root runuser -u duoverse -- env DB_PATH=/var/lib/duoverse/chat.db BACKUP_DIR=/var/backups/duoverse /usr/bin/node --disable-warning=ExperimentalWarning /opt/duoverse/chat/deploy/backup.mjs >> /var/log/duoverse-backup.log 2>&1
EOT
chmod 644 /etc/cron.d/duoverse-backup
echo "Делаю первую копию…"
runuser -u duoverse -- env DB_PATH=/var/lib/duoverse/chat.db BACKUP_DIR=/var/backups/duoverse /usr/bin/node --disable-warning=ExperimentalWarning /opt/duoverse/chat/deploy/backup.mjs
ls -lh /var/backups/duoverse
echo "Готово: копии каждый день в 04:00 в /var/backups/duoverse (хранятся 14 последних)."
