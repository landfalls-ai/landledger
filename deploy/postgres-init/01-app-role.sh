#!/bin/sh
# First start of a fresh volume only (docker-entrypoint-initdb.d): the role the API connects as, with LOGIN and the
# development password. Its grants come with migration 0008, which also creates the role on a database made before
# this script existed; `pnpm db:migrate` sets the password there. Development credentials only.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$LANDLEDGER_APP_PG_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE landledger_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'landledger_app') \gexec
SQL
