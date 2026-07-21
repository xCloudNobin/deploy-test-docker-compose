# deploy-test-docker-compose

Two-service Docker Compose application for testing multi-container, multi-port deployments.

| Service | Purpose | Container port | Default host port |
|---|---|---:|---:|
| `frontend` | Nginx static site and API proxy | 80 | 8088 |
| `api` | Node.js Express API | 3001 | 3002 |

## Run

```bash
docker compose up --build
```

Open `http://localhost:8088` for the frontend and `http://localhost:3002/health` for the directly exposed API.

Ports can be changed with `FRONTEND_PORT` and `API_PORT`.
