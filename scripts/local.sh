#!/usr/bin/env bash
# Everything local: self-hosted DataHub + server + dashboard.
#
# Nothing installs into the OS — the DataHub CLI runs from a repo-local uv cache
# (.dev/uv-cache) and is only used to generate the quickstart compose file.
# `./scripts/local.sh nuke` removes the containers, volumes, that cache and the
# generated compose, so deleting the repo leaves nothing behind.
set -euo pipefail
cd "$(dirname "$0")/.."

export UV_CACHE_DIR="$PWD/.dev/uv-cache"
# Metadata-service auth stays ON: the frontend logs in by asking GMS to mint a
# session token, and GMS refuses to do that when auth is disabled (UI login then
# 500s). The server authenticates with a PAT — see DATAHUB_GMS_TOKEN in
# packages/server/.env, minted via `./scripts/local.sh token`.
export METADATA_SERVICE_AUTH_ENABLED=true
# 8080 is a popular port; keep DataHub off it so unrelated containers can keep it
export DATAHUB_MAPPED_GMS_PORT=8081
export DATAHUB_VERSION=v1.7.0
export UI_INGESTION_DEFAULT_CLI_VERSION=1.7.0
export DATAHUB_TOKEN_SERVICE_SALT=local-dev-salt
# HS256 requires a key of at least 256 bits — a short string makes every login
# fail with WeakKeyException inside GMS's token service.
export DATAHUB_TOKEN_SERVICE_SIGNING_KEY=local-dev-signing-key-at-least-32-bytes-long-0123456789

COMPOSE=~/.datahub/quickstart/docker-compose.yml
dh() { uvx --from acryl-datahub datahub "$@"; }
# the CLI's own `quickstart` shells out to compose without our port overrides, so
# we drive compose directly and only borrow the CLI's generated compose file
dc() { docker compose --profile quickstart -f "$COMPOSE" -f scripts/datahub-local.override.yml -p datahub "$@"; }

case "${1:-up}" in
  up)
    [ -f "$COMPOSE" ] || dh docker quickstart --stop  # generates the compose file
    dc up -d --remove-orphans
    echo "waiting for GMS…"
    until curl -sf http://localhost:8081/health >/dev/null; do sleep 5; done
    echo "DataHub UI  http://localhost:9002  (datahub / datahub)"
    echo "GMS         http://localhost:8081"
    echo "next: ./scripts/local.sh dev"
    ;;
  ingest)  # sample metadata so the catalog isn't empty
    dh docker ingest-sample-data --token "" ;;
  dev)     # server :4070 + dashboard :4071, both in the foreground
    bun run --cwd packages/server dev &
    bun run --cwd packages/dashboard dev &
    wait
    ;;
  token)   # mint a DataHub PAT and write it into packages/server/.env
    jar=$(mktemp)
    curl -sf -c "$jar" -X POST http://localhost:9002/logIn -H 'content-type: application/json' \
      -d '{"username":"datahub","password":"datahub"}' -o /dev/null
    tok=$(curl -sf -b "$jar" -X POST http://localhost:9002/api/v2/graphql -H 'content-type: application/json' \
      -d '{"query":"mutation{createAccessToken(input:{type:PERSONAL,actorUrn:\"urn:li:corpuser:datahub\",duration:ONE_YEAR,name:\"datacards-local\"}){accessToken}}"}' \
      | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
    rm -f "$jar"
    [ -n "$tok" ] || { echo "could not mint a token — is DataHub up?" >&2; exit 1; }
    sed -i -E "s|^DATAHUB_GMS_TOKEN=.*|DATAHUB_GMS_TOKEN=$tok|" packages/server/.env
    echo "wrote DATAHUB_GMS_TOKEN to packages/server/.env — restart the server"
    ;;
  stripe)  # real-time Issuing decisions: Stripe -> this server
    # `stripe listen` signs with the CLI's own secret, not the dashboard endpoint
    # secret — keep STRIPE_WEBHOOK_SECRET in packages/server/.env in sync with
    # `stripe listen --print-secret`. Port 4099 is what the live test suite uses.
    stripe listen --forward-to "http://localhost:${2:-4070}/stripe/webhook" ;;
  stop)  dc stop ;;
  logs)  dc logs -f --tail 100 ;;
  nuke)
    dc down -v --remove-orphans || true
    docker volume ls -q --filter name=datahub | xargs -r docker volume rm -f
    rm -rf .dev ~/.datahub
    echo "DataHub containers, volumes, the local uv cache and the generated compose are gone."
    echo "Images stay (they are shared): docker rmi \$(docker images -q 'acryldata/*')"
    ;;
  *) echo "usage: $0 {up|ingest|token|dev|stripe [port]|stop|logs|nuke}" >&2; exit 1 ;;
esac
