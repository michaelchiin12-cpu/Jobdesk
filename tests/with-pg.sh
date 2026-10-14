#!/usr/bin/env bash
# Jalankan perintah dengan Postgres 16 sungguhan aktif: tests/with-pg.sh node --import tsx --test tests/*.test.ts
set -u
cd "$(dirname "$0")/.."
node --import tsx tests/helpers/pgctl.ts start || exit 1
DB_ENGINE=pg "$@"
code=$?
if [ -z "${KEEP_PG:-}" ]; then
  node --import tsx tests/helpers/pgctl.ts stop
fi
exit $code
