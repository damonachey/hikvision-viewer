#!/bin/sh
# Updates an Alpine install to the latest code. Run as root: sh deploy/update.sh
set -eu

cd "$(dirname "$0")/.."

git pull --ff-only
npm ci --omit=dev

# The service file may have changed, and it creates the cache folder when the service starts.
install -m 755 deploy/hikvision-viewer.openrc /etc/init.d/hikvision-viewer

# The service user can't write to the install folder, so an older .env needs this added.
if ! grep -q '^CACHE_DIR=' .env; then
  printf '\nCACHE_DIR=/var/lib/hikvision-viewer\n' >> .env
fi

rc-service hikvision-viewer restart
