# Verification — Task Board (Docker Compose)

This file records exactly what was and was not run for this candidate, with
real captured output. No test output is invented.

## Status

- **Container runtime qualification: BLOCKED** — `docker compose build` cannot
  complete in this environment because the image build (BuildKit) cannot resolve
  `registry-1.docker.io`. See [Container build](#container-build-failed-infrastructure).
- Local static/config checks: **PASSED** (below).
- `smoke.sh`, `persistence.sh`, `outage.sh` against a live stack: **NOT RUN**
  (no images could be built, so no containers could start).
- Live xCloud provisioning: **NOT RUN** (explicitly — no external deployment or
  repository/visibility changes were made).

## Environment

| Item | Value |
|---|---|
| Host | Linux (amd64) |
| Docker Engine | 29.2.0 |
| Docker Compose | v5.0.2 |
| Host Node.js (local checks only) | v22.23.2 (npm 10.9.8) |
| Base images | `node:22-alpine`, `nginx:1.29-alpine`, `postgres:17-alpine` (pinned) |
| Verification date | 2026-09-20 |

## Scope of the change

Upgrade of `xCloudNobin/deploy-test-docker-compose` `feat/compatibility-app` from
a two-service static/hello API to a three-service task board:

- `frontend` (Nginx 1.29-alpine, static SPA, `/api` reverse proxy, release marker
  baked at build) — **only published service**, host port `18281` (default 8188).
- `api` (Node 22-alpine, Express 5 + `pg`, non-root user) — **not published**;
  liveness/readiness (`/api/health/live`, `/api/health/ready`), `GET /api/meta`,
  idempotent schema init + one-time seed, graceful SIGTERM shutdown.
- `db` (postgres 17-alpine) — **not published**; password required via
  `POSTGRES_PASSWORD`; named volume `db_data` (`compat-b2-verify_db_data`),
  `pg_isready` healthcheck.
- Ordering: `db → healthy → api → healthy → frontend`. Readiness returns 503 when
  the database is unavailable.
- CRUD endpoints for projects/tasks with search (`?search`, `?q`) and status
  filters, parameterized SQL, validation with 400, not-found with 404.
- UI renders all user data as text nodes (no `innerHTML` with user data).

## Local static/config checks (PASSED)

| Check | Command | Result |
|---|---|---|
| Compose spec validity | `docker compose config --quiet` | `config OK` |
| Rendered config labelled publish only frontend, volume named | `docker compose config` | only `frontend` published on `18281`; `db_data` → `/var/lib/postgresql/data` (DB/API unpublished) |
| API syntax | `node --check api/server.js` | `server.js syntax OK` |
| Frontend UI syntax | `node --check frontend/public/app.js` | `app.js syntax OK` |
| Reproducible install (clean checkout) | `npm ci --dry-run --ignore-scripts` | `up to date … npm-ci-exit=0` |
| Test scripts syntax | `sh -n test/smoke.sh test/persistence.sh test/outage.sh` | OK |
| Release marker build step | simulated apply of `sed "s|__APP_RELEASE__|…|"` to a copy of `index.html` | `data-release="bcfbf45"` |
| Secrets hygiene | `git ls-files | grep -Ei 'env|secret|password|key'`; `git check-ignore` | none tracked; `.env` and `api/node_modules/` ignored |

## Container build (FAILED — infrastructure)

Command, run twice with identical result:

```bash
POSTGRES_PASSWORD="$(openssl rand -hex 32)" FRONTEND_PORT=18281 APP_RELEASE=bcfbf45 \
  docker compose -p compat-b2-verify build        # → exit 1
```

Captured error (both attempts):

```
[frontend internal] load metadata for docker.io/library/nginx:1.29-alpine:
#4 ERROR: failed to do request: Head "https://registry-1.docker.io/v2/library/nginx/manifests/1.29-alpine":
   dial tcp: lookup registry-1.docker.io on 185.12.64.2:53:
   read udp 172.17.0.2:…->185.12.64.2:53: i/o timeout
target api: failed to solve: node:22-alpine: failed to resolve source metadata for
   docker.io/library/node:22-alpine: <same DNS timeout>
```

Root cause (this sandbox, unchanged infrastructure): the Docker BuildKit builder
cannot resolve the public image registry through the local resolver
(`lookup registry-1.docker.io … i/o timeout`). Note `docker pull node:22-alpine`,
`docker pull nginx:1.29-alpine` and `docker pull hello-world` succeed via the daemon,
so the images themselves exist; only the buildkit metadata resolution path is blocked.
Per instructions I did **not** modify host DNS, the Docker daemon, BuildKit builders,
or unrelated containers/resources, and did not run any global prune.

## Container runtime tests (NOT RUN)

No images could be built, therefore `docker compose up`, the frontend-to-API HTTP
CRUD smoke test, the persistence-across-recreate test, and the database
outage/recovery test were **not executed**. The scripts are ready and documented
in the README:

- `test/smoke.sh` — CRUD, search/status filters, invalid input (400), not-found
  (404), malformed JSON, static assets, nested SPA route, liveness/readiness.
- `test/persistence.sh` — leaves a record, `docker compose up -d --force-recreate`
  of the full stack, verifies the record survived via the named volume, cleans up.
- `test/outage.sh` — stops `db`, asserts readiness drops to 503 while liveness
  stays 200, starts `db`, asserts readiness returns to 200.

They will run when the registry/build issue is resolved. They are designed to
fail honestly (non-zero exit) rather than degrade if the stack is unavailable.

## Re-run instructions

```bash
cp .env.example .env                      # set a strong POSTGRES_PASSWORD
export FRONTEND_PORT=18281
export APP_RELEASE="$(git rev-parse --short HEAD)"
docker compose -p compose-verify up --build -d
FRONTEND_URL=http://127.0.0.1:18281                  test/smoke.sh
COMPOSE_PROJECT=compose-verify FRONTEND_URL=http://127.0.0.1:18281 test/persistence.sh
COMPOSE_PROJECT=compose-verify FRONTEND_URL=http://127.0.0.1:18281 test/outage.sh
docker compose -p compose-verify down -v
```

## Security / license notes

- `POSTGRES_PASSWORD` is required via `${POSTGRES_PASSWORD:?…}`; the compose
  config fails closed rather than defaulting to a credential. Only a throwaway,
  randomly-generated test value was used during verification and it is not
  committed (`.env` ignored). Rendered `docker compose config` (which interpolates
  the password) was redacted here.
- All SQL is parameterized. Input is validated (`400` with message); missing rows
  return `404`. The UI never uses `innerHTML` for user data.
- The demo board has no cookie authentication, so there is no cookie-CSRF surface;
  this is documented in the README with a warning for any future auth.
- Only the frontend host port is published. No `container_name`s, no fixed IPs.
- MIT license added; copyright retained by xCloudNobin.
- No `node_modules`, binaries, database dumps, private logs, `.env`, or credentials
  are committed.

## Explicit NOT RUN

- Live xCloud provisioning / external deployment: **NOT RUN**.
- Repository visibility, collaborators, credentials, transfers: **untouched**.
- Any live readiness of the composed stack: **NOT RUN** (build blocker above).