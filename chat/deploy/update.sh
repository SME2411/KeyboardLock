#!/usr/bin/env bash
# Обновление: bash /opt/duoverse/chat/deploy/update.sh
set -euo pipefail
git -C /opt/duoverse pull
(cd /opt/duoverse/chat && npm ci --omit=dev)
systemctl restart duoverse
systemctl --no-pager status duoverse | head -5
