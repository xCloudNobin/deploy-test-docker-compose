#!/bin/sh
# Persistence check: leave a project+task, force-recreate the entire stack
# (containers rebuilt from scratch) and verify the record survived via the
# persisted named volume. Cleans its own record up before exiting.
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
project="${COMPOSE_PROJECT:-compose-verify}"
base_url="${FRONTEND_URL:-http://127.0.0.1:8188}"
base_url="${base_url%/}"
marker="persist-check-$$"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_ready_ok() {
  retries=0
  until [ "$retries" -ge 30 ] || curl -fsS "$base_url/api/health/ready" -o /dev/null; do
    retries=$((retries + 1))
    sleep 2
  done
  [ "$retries" -lt 30 ] || fail 'stack did not become ready'
}

# --- Leave a record ---------------------------------------------------------
curl -fsS -X POST "$base_url/api/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$marker\"}" -o "$tmp/project.json"
proj_id="$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$tmp/project.json")"
[ -n "$proj_id" ] || fail 'marker project not created'
curl -fsS -X POST "$base_url/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":$proj_id,\"title\":\"$marker task\"}" -o "$tmp/task.json"
task_id="$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$tmp/task.json")"
[ -n "$task_id" ] || fail 'marker task not created'
echo "Left marker: project_id=$proj_id task_id=$task_id"

# --- Recreate the whole stack (keeps the named volume) ----------------------
docker compose -p "$project" -f "$project_root/compose.yaml" up -d --force-recreate
wait_ready_ok

# --- Verify the record survived ---------------------------------------------
curl -fsS "$base_url/api/projects/$proj_id" -o "$tmp/after-project.json"
grep -q "$marker" "$tmp/after-project.json" || fail 'project did not survive container recreate'

curl -fsS "$base_url/api/tasks/$task_id" -o "$tmp/after-task.json"
grep -q "$marker" "$tmp/after-task.json" || fail 'task did not survive container recreate'

# --- Cleanup -----------------------------------------------------------------
code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$base_url/api/projects/$proj_id")"
[ "$code" = "204" ] || fail "cleanup: project delete expected 204, got $code"
echo "persistence.sh PASSED (records survived --force-recreate of the full stack)"