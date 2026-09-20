#!/bin/sh
# Dependency outage/recovery: stop the database, assert readiness degrades to
# 503 while liveness stays 200, then recover the database and assert readiness
# returns to 200. Proxied through the published frontend only.
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
project="${COMPOSE_PROJECT:-compose-verify}"
base_url="${FRONTEND_URL:-http://127.0.0.1:8188}"
base_url="${base_url%/}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_for_ready_code() {
  want="$1"
  retries=0
  got=""
  until [ "$retries" -ge 45 ]; do
    got="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/health/ready")"
    if [ "$got" = "$want" ]; then return 0; fi
    retries=$((retries + 1))
    sleep 2
  done
  fail "ready endpoint stuck at $got, wanted $want"
}

# --- Precondition: healthy ------------------------------------------------
wait_for_ready_code 200

# --- Outage: stop the database ---------------------------------------------
docker compose -p "$project" -f "$project_root/compose.yaml" stop db
wait_for_ready_code 503

# liveness must stay up during the outage
live_code="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/health/live")"
[ "$live_code" = "200" ] || fail "liveness expected 200 during db outage, got $live_code"
echo "readiness correctly reports 503 while database is down (liveness stays 200)"

# --- Recovery: start the database again -------------------------------------
docker compose -p "$project" -f "$project_root/compose.yaml" start db
wait_for_ready_code 200
echo "outage.sh PASSED (dependency outage detected and recovered on readiness)"