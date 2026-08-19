#!/bin/sh
set -eu

# Render attaches the persistent disk at runtime. Make sure the
# non-root application user can create/update the SQLite DB and its
# WAL/SHM sidecar files on that mounted volume.
mkdir -p /var/data
chown -R node:node /var/data

exec su node -s /bin/sh -c 'exec node /app/server.js'
