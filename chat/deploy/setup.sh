#!/usr/bin/env bash
# Первичная настройка чистого Ubuntu 24.04. Запускать от root:  bash setup.sh duoverse.net
set -euo pipefail
DOMAIN="${1:?Укажи домен: bash setup.sh duoverse.net}"
REPO="${REPO:-https://github.com/SME2411/KeyboardLock.git}"
BRANCH="${BRANCH:-claude/chat-app-lf4nji}"

export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y upgrade
apt-get install -y ufw git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg unattended-upgrades

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (официальный способ из документации Caddy)
rm -f /etc/apt/sources.list.d/caddy.list /usr/share/keyrings/caddy.gpg   # остатки прошлой неудачной попытки
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
test -d /etc/caddy || { echo "Caddy не установился"; exit 1; }

# пользователь и код
id duoverse &>/dev/null || useradd --system --home /opt/duoverse --shell /usr/sbin/nologin duoverse
if [ -d /opt/duoverse/.git ]; then git -C /opt/duoverse pull; else git clone --branch "$BRANCH" "$REPO" /opt/duoverse; fi
(cd /opt/duoverse/chat && npm ci --omit=dev)
mkdir -p /var/lib/duoverse /var/backups/duoverse
chown -R duoverse: /var/lib/duoverse /var/backups/duoverse

# конфиг (секреты)
if [ ! -f /etc/duoverse.env ]; then
  CODE=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  cat > /etc/duoverse.env <<EOT
PORT=3000
HOST=127.0.0.1
COOKIE_SECURE=1
MAX_USERS=2
INVITE_CODE=$CODE
DB_PATH=/var/lib/duoverse/chat.db
EOT
  chmod 600 /etc/duoverse.env
  echo ">>> Код приглашения: $CODE  (лежит в /etc/duoverse.env)"
fi

cp /opt/duoverse/chat/deploy/duoverse.service /etc/systemd/system/
sed "s/DOMAIN/$DOMAIN/" /opt/duoverse/chat/deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now duoverse
systemctl restart caddy

# ежедневный бэкап в 04:00
cat > /etc/cron.d/duoverse-backup <<EOT
0 4 * * * duoverse DB_PATH=/var/lib/duoverse/chat.db BACKUP_DIR=/var/backups/duoverse /usr/bin/node --disable-warning=ExperimentalWarning /opt/duoverse/chat/deploy/backup.mjs >> /var/log/duoverse-backup.log 2>&1
EOT

# файрвол: только SSH, HTTP, HTTPS
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
echo "Готово. Открой https://$DOMAIN"
