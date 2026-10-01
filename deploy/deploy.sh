#!/usr/bin/env bash
# Sunucuda guncelleme: son kodu ceker, imaji derler, migration'i uygular, servisleri yeniler.
# Kullanim (depo kokunden): deploy/deploy.sh   (ilk kurulum: docs/DEPLOYMENT.md)
set -euo pipefail
cd "$(dirname "$0")/.."

compose() { docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production "$@"; }

test -f deploy/.env.production || { echo "deploy/.env.production yok"; exit 1; }
test -f deploy/secrets/mqtt/passwd || { echo "deploy/secrets/mqtt/ eksik"; exit 1; }

if [ "${1:-}" != "--no-pull" ]; then git pull --ff-only; fi
echo "Surum: $(git log --oneline -1)"

compose build
compose up -d --wait --remove-orphans
compose ps
docker image prune -f >/dev/null
echo "Tamam."
