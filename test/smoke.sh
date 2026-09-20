#!/bin/sh
# Smoke test against a running task board stack (through the frontend proxy).
# Exercises CRUD, search/status filters, invalid input (400), not-found (404)
# and malformed JSON. Exits non-zero on the first failed assertion.
set -eu

base_url="${FRONTEND_URL:-http://127.0.0.1:8188}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

base_url="${base_url%/}"

# --- Frontend shell, assets and nested client route -------------------------
curl -fsS "$base_url/" -o "$tmp/index.html"
grep -q 'Task Board' "$tmp/index.html" || fail 'frontend did not serve task board shell'

curl -fsS "$base_url/app.js" -o "$tmp/app.js"
grep -q 'fetch' "$tmp/app.js" || fail 'app.js static asset not served'

curl -fsS "$base_url/nested/client/route" -o "$tmp/nested.html"
grep -q 'Task Board' "$tmp/nested.html" || fail 'nested route did not fall back to SPA shell'

curl -fsS "$base_url/health.html" -o "$tmp/health.html"
grep -q 'ok' "$tmp/health.html" || fail 'static health page missing'

# --- Liveness / readiness / metadata ---------------------------------------
live_code="$(curl -sS -o "$tmp/live.json" -w '%{http_code}' "$base_url/api/health/live")"
[ "$live_code" = "200" ] || fail "liveness expected 200, got $live_code"
grep -q '"status":"ok"' "$tmp/live.json" || fail 'liveness payload wrong'

ready_code="$(curl -sS -o "$tmp/ready.json" -w '%{http_code}' "$base_url/api/health/ready")"
[ "$ready_code" = "200" ] || fail "readiness expected 200, got $ready_code"
grep -q '"db":"up"' "$tmp/ready.json" || fail 'readiness payload wrong'

curl -fsS "$base_url/api/meta" -o "$tmp/meta.json"
grep -q '"postgres"' "$tmp/meta.json" || fail 'meta payload wrong'

# --- Project CRUD ------------------------------------------------------------
curl -fsS -X POST "$base_url/api/projects" \
  -H 'Content-Type: application/json' -d '{"name":"Smoke Project"}' -o "$tmp/project.json"
proj_id="$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$tmp/project.json")"
[ -n "$proj_id" ] || fail 'project create returned no id'

# list + search filter (hit: should contain it)
curl -fsS "$base_url/api/projects?search=Smoke" -o "$tmp/list.json"
grep -q "\"id\":${proj_id}[,\}]" "$tmp/list.json" || fail 'created project missing from search results'

# search filter (miss: must exclude it)
curl -fsS "$base_url/api/projects?search=zzz-no-such-project" -o "$tmp/list-miss.json"
if grep -q "\"id\":${proj_id}[,\}]" "$tmp/list-miss.json"; then
  fail 'search filter did not exclude non-matching project'
fi

# read single
code="$(curl -sS -o "$tmp/one.json" -w '%{http_code}' "$base_url/api/projects/$proj_id")"
[ "$code" = "200" ] || fail "read project expected 200, got $code"

# update
curl -fsS -X PATCH "$base_url/api/projects/$proj_id" \
  -H 'Content-Type: application/json' -d '{"status":"archived"}' -o "$tmp/project-updated.json"
grep -q '"status":"archived"' "$tmp/project-updated.json" || fail 'project status not updated'

# not found
code="$(curl -sS -o "$tmp/nf.json" -w '%{http_code}' "$base_url/api/projects/999999999")"
[ "$code" = "404" ] || fail "missing project expected 404, got $code"
grep -q '"error"' "$tmp/nf.json" || fail 'missing project had no error message'

# --- Invalid input ------------------------------------------------------------
code="$(curl -sS -o "$tmp/bad-empty.json" -w '%{http_code}' -X POST "$base_url/api/projects" \
  -H 'Content-Type: application/json' -d '{"name":"   "}')"
[ "$code" = "400" ] || fail "empty project name expected 400, got $code"
grep -q '"error"' "$tmp/bad-empty.json" || fail 'empty project name had no error message'

code="$(curl -sS -o "$tmp/bad-status.json" -w '%{http_code}' -X POST "$base_url/api/projects" \
  -H 'Content-Type: application/json' -d '{"name":"Ok","status":"bogus"}')"
[ "$code" = "400" ] || fail "invalid project status expected 400, got $code"

printf '{oops' > "$tmp/malformed.json"
code="$(curl -sS -o "$tmp/bad-json.json" -w '%{http_code}' -X POST "$base_url/api/projects" \
  -H 'Content-Type: application/json' -d "@$tmp/malformed.json")"
[ "$code" = "400" ] || fail "malformed JSON expected 400, got $code"

code="$(curl -sS -o "$tmp/bad-id.json" -w '%{http_code}' "$base_url/api/projects/not-a-number")"
[ "$code" = "400" ] || fail "non-numeric project id expected 400, got $code"

# --- Task CRUD ----------------------------------------------------------------
curl -fsS -X POST "$base_url/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":$proj_id,\"title\":\"Smoke Task\"}" -o "$tmp/task.json"
task_id="$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$tmp/task.json")"
[ -n "$task_id" ] || fail 'task create returned no id'

# status filter hit
curl -fsS "$base_url/api/tasks?project_id=$proj_id&status=todo" -o "$tmp/status-hit.json"
grep -q "\"id\":${task_id}[,\}]" "$tmp/status-hit.json" || fail 'status filter missed todo task'

# status filter miss
curl -fsS "$base_url/api/tasks?project_id=$proj_id&status=done" -o "$tmp/status-miss.json"
if grep -q "\"id\":${task_id}[,\}]" "$tmp/status-miss.json"; then
  fail 'status filter returned non-matching task'
fi

# title search hit
curl -fsS "$base_url/api/tasks?q=Smoke" -o "$tmp/q-hit.json"
grep -q "\"id\":${task_id}[,\}]" "$tmp/q-hit.json" || fail 'task title search missed task'

# task for missing project -> 404
code="$(curl -sS -o "$tmp/task-orphan.json" -w '%{http_code}' -X POST "$base_url/api/tasks" \
  -H 'Content-Type: application/json' -d '{"project_id":999999999,"title":"Orphan"}')"
[ "$code" = "404" ] || fail "task with missing project expected 404, got $code"

# empty task title -> 400
code="$(curl -sS -o "$tmp/task-bad.json" -w '%{http_code}' -X POST "$base_url/api/tasks" \
  -H 'Content-Type: application/json' -d "{\"project_id\":$proj_id,\"title\":\"  \"}")"
[ "$code" = "400" ] || fail "empty task title expected 400, got $code"

# update task status
curl -fsS -X PATCH "$base_url/api/tasks/$task_id" \
  -H 'Content-Type: application/json' -d '{"status":"in_progress"}' -o "$tmp/task-updated.json"
grep -q '"status":"in_progress"' "$tmp/task-updated.json" || fail 'task status not updated'

# delete task -> 204 then gone -> 404
code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$base_url/api/tasks/$task_id")"
[ "$code" = "204" ] || fail "task delete expected 204, got $code"
code="$(curl -sS -o "$tmp/task-gone.json" -w '%{http_code}' "$base_url/api/tasks/$task_id")"
[ "$code" = "404" ] || fail "deleted task expected 404, got $code"

# cascade: project delete removes its remaining tasks
curl -fsS -X POST "$base_url/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":$proj_id,\"title\":\"To be cascaded\"}" -o "$tmp/cascade-task.json"
cascade_id="$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$tmp/cascade-task.json")"
[ -n "$cascade_id" ] || fail 'cascade setup task not created'
code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$base_url/api/projects/$proj_id")"
[ "$code" = "204" ] || fail "project delete expected 204, got $code"
code="$(curl -sS -o "$tmp/cascade-gone.json" -w '%{http_code}' "$base_url/api/tasks/$cascade_id")"
[ "$code" = "404" ] || fail "cascaded task expected 404 after project delete, got $code"

echo "smoke.sh PASSED against $base_url"