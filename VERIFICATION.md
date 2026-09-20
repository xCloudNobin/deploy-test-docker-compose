# Verification — Task Board (Docker Compose)

This file records exactly what was and was not run for this candidate, with
real captured output. No test output is invented.

## Status

- **Container build: PASSED** — using the environment's **default builder**
  (docker driver) plus a **temporary build-only override** that sets
  `build.network: host` for the two built services. The global builder selection
  was **not** changed: `multiarch-builder` (docker-container driver) is still the
  selected builder after verification. See
  [Container build](#container-build-passed-build-workaround).
- **Container runtime tests — all PASSED** against a live private-network stack:
  `test/smoke.sh`, `test/persistence.sh` (full-stack `--force-recreate`),
  `test/outage.sh` (db stop → readiness 503 → recovery). Details below.
- Local static/config checks: **PASSED** (below).
- Live xCloud provisioning: **NOT RUN** (explicitly — no external deployment or
  repository/visibility changes were made).

## Environment

| Item | Value |
|---|---|
| Host | Linux (amd64) |
| Docker Engine | 29.2.0 |
| Docker Compose | v5.0.2 |
| Host Node.js (local checks only) | v22.23.2 (npm 10.9.8) |
| BuildKit builder (default) | `default` — driver `docker`, v0.27.0 |
| BuildKit builder (global, unchanged) | `multiarch-builder` — driver `docker-container`, v0.27.1 |
| Base images | `node:22-alpine`, `nginx:1.29-alpine`, `postgres:17-alpine` (pinned, present locally) |
| Verification date | 2026-09-20 |

## Scope of the change

Upgrade of `xCloudNobin/deploy-test-docker-compose` `feat/compatibility-app` from
a two-service static/hello API to a three-service task board:

- `frontend` (Nginx 1.29-alpine, static SPA, `/api` reverse proxy, release marker
  baked at build) — **only published service**, host port `18317` (ephemeral;
  default 8188).
- `api` (Node 22-alpine, Express 5 + `pg`, non-root user) — **not published**;
  liveness/readiness (`/api/health/live`, `/api/health/ready`), `GET /api/meta`,
  idempotent schema init + one-time seed, graceful SIGTERM shutdown.
- `db` (postgres 17-alpine) — **not published**; password required via
  `POSTGRES_PASSWORD`; named volume `db_data`, `pg_isready` healthcheck.
- Ordering: `db → healthy → api → healthy → frontend`. Readiness returns 503 when
  the database is unavailable.
- CRUD endpoints for projects/tasks with search (`?search`, `?q`) and status
  filters, parameterized SQL, validation with 400, not-found with 404.
- UI renders all user data as text nodes (no `innerHTML` with user data).

## Container build (PASSED — build workaround)

### Build workaround (does not change the host or global builder)

The image **build** used two scoped environment mechanisms that leave the host
and the daemon configuration untouched:

1. **Per-command `BUILDX_BUILDER=default`** — selects the environment's default
   builder (driver `docker`) for that one command only. The global selected
   builder `multiarch-builder` (driver `docker-container`) is unchanged before,
   during and after; `docker builder ls` still showed `multiarch-builder*` after
   the run.
2. **Temporary Compose override (outside the repository, deleted after use)** that
   sets `services.api.build.network: host` and `services.frontend.build.network: host`
   for the **build** stage only. Running containers never use host networking; the
   stack runs on its private Compose network with only the frontend port published.

Neither the daemon, DNS resolver, or any unrelated resource was modified. No
global prune was run.

Root cause it addresses (measured): the `docker-container`-driver builder and the
default bridge build network cannot resolve public registries/DNS
(`registry-1.docker.io`, `registry.npmjs.org`), while the **host** can. Concrete
evidence captured during verification:

```bash
$ docker run --rm alpine:3.22 sh -c 'getent hosts registry.npmjs.org || echo DNS_FAIL_npm; getent hosts registry-1.docker.io || echo DNS_FAIL_dockerhub'
DNS_FAIL_npm
DNS_FAIL_dockerhub

$ getent hosts registry.npmjs.org && echo HOST_NPM_OK
… (IPv6 records) …
HOST_NPM_OK
```

Host DNS works; container build-network DNS does not. The workaround gives the
build stage host networking (plus the docker-driver builder, which can use the
already-pulled local base images) so `RUN npm ci` can reach the npm registry.
The base images themselves were already present locally
(`docker images` shows `node:22-alpine`, `nginx:1.29-alpine`, `postgres:17-alpine`).

### Successful build command (captured)

```bash
# override file, written OUTSIDE the repository (deleted immediately after)
# services:
#   api:
#     build:
#       network: host
#   frontend:
#     build:
#       network: host

export POSTGRES_PASSWORD="$(openssl rand -hex 32)" FRONTEND_PORT=18317 \
  APP_RELEASE=c3963ba
BUILDX_BUILDER=default \
  docker compose -p compat-b2-vfy1 -f compose.yaml -f /tmp/…override.yaml build
```

Result (exit 0): both images built and tagged —

```
#18 [api 5/6] RUN npm ci --omit=dev
#18 2.177 added 81 packages…
#22 naming to docker.io/library/compat-b2-vfy1-api:latest done
#19 naming to docker.io/library/compat-b2-vfy1-frontend:latest done
 Image compat-b2-vfy1-api Built
 Image compat-b2-vfy1-frontend Built
```

### Remark: the host-network override is REQUIRED, not optional

An identical build **without** the override (only `BUILDX_BUILDER=default`) was
attempted and fails exactly at `RUN npm ci --omit=dev` (npm cannot reach its
registry through the bridge build network):

```
> [5/6] RUN npm ci --omit=dev:
141.0 npm error Exit handler never called!
… failed to solve: process "/bin/sh -c npm ci --omit=dev" did not complete successfully: exit code: 1
```

With the override, the same step completes in ~2.4s. So both halves of the
workaround matter: the docker-driver builder for local base images **and**
`build.network: host` for npm registry access during `npm ci`.

## Container runtime tests (all PASSED)

### Stack startup (private networking, unique project, ephemeral port)

```bash
export POSTGRES_PASSWORD=<from .env>   # one pinned test value for the whole session
docker compose -p compat-b2-vfy1 -f compose.yaml up -d
```

`docker compose ps`:

```
NAME                           STATUS                   PORTS
compat-b2-vfy1-api-1           Up 5 seconds (healthy)   3001/tcp          ← not published
compat-b2-vfy1-db-1            Up 11 seconds (healthy)  5432/tcp          ← not published
compat-b2-vfy1-frontend-1      Up … (health: starting)  0.0.0.0:18317->80/tcp  ← only published
```

Healthy ordering observed: `db → healthy → api → healthy → frontend` (exactly as
declared in `compose.yaml`).

Host reachability proof (API/DB are private; only the frontend is public):

```bash
$ curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health/live
conn-refused                      # API is NOT reachable from the host
$ curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:5432/
conn-refused                      # DB is NOT reachable from the host
$ curl -fsS --max-time 5 http://127.0.0.1:18317/api/health/live -o /dev/null && echo OK
OK                                # frontend proxy reaches the API path
```

Release marker baked at build and served:

```
data-release="c3963ba"
{"app":"compose-taskboard","release":"c3963ba","node":"v22.23.2","db":"postgres"}
```

### `test/smoke.sh` — PASSED

```bash
$ FRONTEND_URL=http://127.0.0.1:18317 test/smoke.sh
smoke.sh PASSED against http://127.0.0.1:18317   (exit 0)
```

Covers: frontend shell, `app.js`, nested SPA fallback, `health.html`,
liveness 200, readiness 200 (`"db":"up"`), `/api/meta`, project CRUD + search
hit/miss, single read, PATCH status, 404 for missing id, 400s for empty name /
invalid status / malformed JSON / non-numeric id, task CRUD + status/q filters,
404 for orphan task, 400 empty title, PATCH status, DELETE 204 → 404, and
project-delete cascade → task 404.

### `test/persistence.sh` — PASSED

```bash
$ COMPOSE_PROJECT=compat-b2-vfy1 FRONTEND_URL=http://127.0.0.1:18317 test/persistence.sh
Left marker: project_id=3 task_id=6
Container compat-b2-vfy1-db-1 Recreate … (full stack --force-recreate)
persistence.sh PASSED (records survived --force-recreate of the full stack)   (exit 0)
```

A project+task were created, the **entire** stack was `--force-recreate`d
(new containers), and both records were verified present afterwards — carried only
by the named volume `compat-b2-vfy1_db_data`. Cleanup performed by the script.

Note on procedure: a single `POSTGRES_PASSWORD` value must be pinned for the whole
session (via `.env`, which is git-ignored). An earlier run rotated the password
between commands against a persistent volume; PostgreSQL keeps the password set at
volume init, so the API then saw `password authentication failed for user
"taskboard"` and the stack correctly reported unhealthy and refused to start the
frontend. Pinning one `.env` value made `--force-recreate` pass — this is expected
PostgreSQL behavior, not a compose defect; the failing-closed behavior is
intentional and documented.

### `test/outage.sh` — PASSED

```bash
$ COMPOSE_PROJECT=compat-b2-vfy1 FRONTEND_URL=http://127.0.0.1:18317 test/outage.sh
Container compat-b2-vfy1-db-1 Stopping …
readiness correctly reports 503 while database is down (liveness stays 200)
Container compat-b2-vfy1-db-1 Starting …
outage.sh PASSED (dependency outage detected and recovered on readiness)   (exit 0)
```

Stopping `db` drove `/api/health/ready` to 503 while `/api/health/live` stayed 200;
restarting `db` restored readiness to 200. Final state healthy.

## Local static/config checks (PASSED)

| Check | Command | Result |
|---|---|---|
| Compose spec validity (with build override) | `docker compose config --quiet` | `CONFIG OK` |
| Rendered config labelled publish only frontend, volume named | `docker compose config` | only `frontend` published on `18317`; `db_data` → `/var/lib/postgresql/data` (DB/API unpublished, `build.network: host` present for build only) |
| API syntax | `node --check api/server.js` | `server.js syntax OK` |
| Frontend UI syntax | `node --check frontend/public/app.js` | `app.js syntax OK` |
| Test scripts syntax | `sh -n test/smoke.sh test/persistence.sh test/outage.sh` | OK |
| Secrets hygiene | `git ls-files \| grep -Ei 'env|secret|password|key'`; `git check-ignore .env` | none tracked; `.env` ignored |

## Re-run instructions (with the workaround)

```bash
# 1. Throwaway test password, pinned in the ignored .env for the whole session.
cp .env.example .env
# edit .env: FRONTEND_PORT=18317, POSTGRES_PASSWORD=<openssl rand -hex 32>, APP_RELEASE=<sha>

# 2. Build with the scoped workaround (global builder + daemon untouched).
cat > /tmp/compat-b2-build-override.yaml <<'EOF'
services:
  api:
    build:
      network: host
  frontend:
    build:
      network: host
EOF
BUILDX_BUILDER=default docker compose -p compat-b2-vfy1 \
  -f compose.yaml -f /tmp/compat-b2-build-override.yaml build

# 3. Run the stack on PRIVATE networking (override is build-only, not used here).
docker compose -p compat-b2-vfy1 up -d

# 4. Tests (through the published frontend only).
FRONTEND_URL=http://127.0.0.1:18317                                test/smoke.sh
COMPOSE_PROJECT=compat-b2-vfy1 FRONTEND_URL=http://127.0.0.1:18317 test/persistence.sh
COMPOSE_PROJECT=compat-b2-vfy1 FRONTEND_URL=http://127.0.0.1:18317 test/outage.sh

# 5. Clean up only this project's own resources.
docker compose -p compat-b2-vfy1 down -v
rm -f /tmp/compat-b2-build-override.yaml .env
```

## Security / license notes

- `POSTGRES_PASSWORD` is required via `${POSTGRES_PASSWORD:?…}`; the compose
  config fails closed rather than defaulting to a credential. Only a throwaway,
  randomly-generated test value was used during verification and it is not
  committed (`.env` ignored). Rendered `docker compose config` (which interpolates
  the password) was redacted in this document.
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
- Modification of the global BuildKit builder, Docker daemon, or host DNS settings:
  **NOT done** — only the per-command `BUILDX_BUILDER=default` and a deleted
  build-only override were used.