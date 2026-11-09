# Single-web-service release fixture

Use `compose.release.yaml` for the first compose-file release-engine stage. It reuses the canonical Express taskboard API and PostgreSQL schema. The web service is named `website`; PostgreSQL is `database`. Only the web service publishes a loopback host port. The database has a named volume with seeded projects/tasks and customer-created rows.

Set `POSTGRES_PASSWORD` to a disposable test value outside git. Optional `FRONTEND_PORT` defaults to 8188 and `APP_RELEASE` defaults to `stage1-v1`.

The original `compose.yaml` remains the frontend/API/database fixture for later multi-service release work. This file deliberately serves the taskboard API directly: `/api/projects`, `/api/tasks`, `/api/meta`, `/api/health/live` and `/api/health/ready`. It does not include the separate browser frontend.

Create a project through POST `/api/projects` with JSON `{"name":"release persistence"}`. Save its ID and verify it through GET `/api/projects` after conversion, two code deployments, rollback, turn-off and a normal deployment. Change the fallback marker in `api/server.js` for visibly different code builds; GET `/api/meta` reports it. Send continuous traffic to `/api/health/ready` at five requests per second or more throughout, and record non-2xx counts and maximum latency. Verify database DNS from both web containers during overlap and ensure the release has no `website` alias on the live network.

No live-platform claim is made by this fixture addition. Qualification belongs to the engine test report.
