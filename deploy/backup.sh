#!/usr/bin/env bash
# Gunluk veritabani yedegi (cron). Son KEEP yedek tutulur. Yedek kisisel veri ve para kaydi icerir.
# Geri yukleme: docs/DEPLOYMENT.md "Yedekleme ve Geri Yukleme".
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${BACKUP_DIR:-/var/backups/qwash}"
KEEP="${BACKUP_KEEP:-14}"
mkdir -p "$DIR"
FILE="$DIR/qwash-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production \
  exec -T postgres pg_dump -U qwash -d qwash -Fc > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
chmod 600 "$FILE"
ls -1t "$DIR"/qwash-*.dump | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "Yedek: $FILE ($(du -h "$FILE" | cut -f1))"
