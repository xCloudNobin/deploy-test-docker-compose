# Task Board (Docker Compose)

A three-service task board: **frontend** (Nginx static SPA), **API** (Node.js / Express), and **database** (PostgreSQL). Projects contain tasks; you can search, filter by status, and create/edit/delete both. Data is stored in a named Docker volume, so it survives restarts and redeploys.

Upgrade of the original two-service deployment test in
[xCloudNobin/deploy-test-docker-compose](https://github.com/xCloudNobin/deploy-test-docker-compose).

| Service  | Image / runtime        | Container port | Published host port |
|----------|------------------------|---------------:|--------------------:|
| frontend | `nginx:1.29-alpine`    | 80             | `${FRONTEND_PORT}` (default 8188) |
| api      | `node:22-alpine`       | 3001           | **not published**    |
| db       | `postgres:17-alpine`   | 5432           | **not published**    |

Only the frontend is exposed on the host. The API and database communicate over an
internal bridge network and are unreachable from outside the stack, so all HTTP
traffic goes through the Nginx `/api` reverse proxy.

## Requirements

- Docker Engine 24+ and Docker Compose v2 (`docker compose`).

## Install / build / run (production)

```bash
# 1. Create your environment file with a strong database password.
cp .env.example .env
openssl rand -hex 32            # paste the output as POSTGRES_PASSWORD in .env

# 2. Apply the release marker (optional, shown in the UI footer and /api/meta).
#    export APP_RELEASE="$(git rev-parse --short HEAD)"

# 3. Build and start the stack.
docker compose up --build -d

# 4. Open http://localhost:8188
```

`docker compose up --build -d` is the production start command. Logs follow with
`docker compose logs -f`. Everything logs to stdout/stderr; no credentials are logged.

To run multiple isolated stacks (also used by the automated tests), use a unique
project name and host port:

```bash
docker compose -p my-unique-name --env-file .env up --build -d
```

### Stop / clean shutdown / cleanup

```bash
docker compose stop                  # graceful: containers receive SIGTERM
docker compose down                  # stop and remove containers + network
docker compose down -v               # also delete the db_data volume (destructive)
```

The API shuts down cleanly on `SIGTERM`/`SIGINT`: it stops accepting connections,
drains the request pool, closes the database pool and exits.

## Environment variables

All are read from the environment or a `.env` file. Safe placeholder values live in
`.env.example`; **no real credentials are committed**.

| Variable            | Required | Default  | Description |
|---------------------|----------|----------|-------------|
| `POSTGRES_PASSWORD` | **yes**  | —        | Database password. Compose refuses to start without it. |
| `POSTGRES_USER`     | no       | `taskboard` | Database role. |
| `POSTGRES_DB`       | no       | `taskboard` | Database name. |
| `FRONTEND_PORT`     | no       | `8188`   | Host port bound to the frontend (only published service). |
| `APP_RELEASE`       | no       | `local`  | Non-sensitive build/release marker shown in the UI and `/api/meta`. |

## Health and startup ordering

- **db**: `pg_isready` against the configured user/database.
- **api**: `GET /api/health/ready` (below); Compose starts it only after the DB is healthy.
- **frontend**: `GET /health.html`; Compose starts it only after the API is healthy.

### Liveness vs readiness

- `GET /api/health/live` — process is up. Always 200 while the API runs.
- `GET /api/health/ready` — **200 only when the database answers `SELECT 1`**; otherwise
  **503**. This is a real dependency check, not a static marker.
- `GET /api/meta` — non-sensitive `{app, release, node, db}` build metadata.

The API retries the database connection and schema initialization at startup, then keeps
serving; readiness simply reports 503 until the dependency returns.

## Persistence

- PostgreSQL data lives in the named volume `db_data` (managed by Compose; on the host it
  is `<project>_db_data`). Recreating containers (`docker compose up -d --force-recreate`)
  or restarting the stack keeps all projects/tasks. Data is lost only on `docker compose down -v`.
- Backup from the host:
  ```bash
  docker compose exec db pg_dump -U taskboard taskboard > taskboard-$(date +%F).sql
  ```

## API

JSON in, JSON out. Invalid input returns `400 { "error": "..." }`, missing resources
return `404 { "error": "..." }`. All queries are parameterized (never string-built SQL),
and the UI renders every user-supplied value as text (no `innerHTML` with user data).

| Method & path                  | Description |
|--------------------------------|-------------|
| `GET /api/health/live`         | Liveness. |
| `GET /api/health/ready`        | Readiness (checks DB). 503 when DB is down. |
| `GET /api/meta`                | App/release metadata. |
| `GET /api/projects`            | List projects; `?search=<q>` filters by name (ILIKE). |
| `POST /api/projects`           | Create `{name, status?}` (`active`\|`archived`). |
| `GET /api/projects/:id`        | Single project. |
| `PATCH /api/projects/:id`      | Update `{name?, status?}`. |
| `DELETE /api/projects/:id`     | Delete project (cascades tasks). 204. |
| `GET /api/tasks`               | List tasks; filters `project_id`, `status`, `q` (title search). |
| `POST /api/tasks`              | Create `{project_id, title, status?}`. 404 if project is missing. |
| `GET /api/tasks/:id`           | Single task. |
| `PATCH /api/tasks/:id`         | Update `{title?, status?, project_id?}`. |
| `DELETE /api/tasks/:id`        | Delete task. 204. |

Schema is applied idempotently at API startup (`CREATE TABLE IF NOT EXISTS …`,
indexes included) and seeded once when the `projects` table is empty (see `api/schema.sql`).

## Schema

Defined in [`api/schema.sql`](api/schema.sql): `projects` and `tasks` with status
check constraints and a cascade delete from project → tasks.

## Security notes

- The database password is supplied via `POSTGRES_PASSWORD` environment only; it is
  never committed and never logged. A future public deployment needs a rotated value.
- SQL is fully parameterized; the API validates input and returns meaningful errors.
- The UI renders all user data as text nodes, so stored/queried text cannot inject markup.
- There is no cookie-based authentication on this public demo board, so there are no
  session cookies and no cookie CSRF surface; state-changing routes reject invalid bodies
  with 400. If you add login in the future, protect mutations with a per-session CSRF token.
- Only the frontend port is published; API and database are never directly reachable.

## Limitations

- Single-node stack intended for the demo/qualification target; no TLS, no user auth,
  no horizontal scaling, no scheduled/background jobs.
- Nginx public-demo deployment terminates plain HTTP on the frontend port. For a public
  deployment, keep HTTPS termination in front (e.g. reverse proxy / platform ingress).
- Task/project search is simple `ILIKE '%…%'`; adequate for small boards.

## Safe public-demo usage

If this stack is exposed publicly (e.g. on xCloud), at minimum: set a strong
`POSTGRES_PASSWORD`, publish only the frontend port, keep the API/database private,
and terminate TLS ahead of the frontend. Content is user-generated; anyone who reaches
the board can edit it, so treat it as a demo, not a system of record.

## Tests

Automated checks run against a live stack (unique project + unique host port):

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"  # test-only value
export FRONTEND_PORT=18281
docker compose -p compose-verify up --build -d

# CRUD, search/filter, invalid input, 404s — through the frontend proxy
FRONTEND_URL=http://127.0.0.1:18281 test/smoke.sh

# Leaves a record, force-recreates all containers, verifies it survived, cleans up
COMPOSE_PROJECT=compose-verify FRONTEND_URL=http://127.0.0.1:18281 test/persistence.sh

# Stops the database, asserts readiness drops to 503, recovers, asserts 200 again
COMPOSE_PROJECT=compose-verify FRONTEND_URL=http://127.0.0.1:18281 test/outage.sh

docker compose -p compose-verify down -v
```

The scripts never redeploy the database separately from the API; `persistence.sh`
recreates the whole stack so the volume is the only thing that could carry the record.

## Directory layout

```
compose.yaml            three services; health-aware ordering; named volume; one published port
.env.example            safe placeholder environment
api/                    Express API: server.js, idempotent schema.sql, Dockerfile (non-root)
frontend/               Nginx + static SPA: index.html, app.js, app.css, nginx.conf, Dockerfile
test/                   smoke.sh, persistence.sh, outage.sh
```

## License

[MIT](LICENSE), Copyright (c) 2026 xCloudNobin.