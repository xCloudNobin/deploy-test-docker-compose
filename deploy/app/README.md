# Fixture: compose file in a subfolder

Tests a Docker Compose site with compose file path `deploy/app/docker-compose.yml`.
The service needs `APP_KEY` (`${APP_KEY:?}`), set only in the site-root `.env`.
Compose reads `.env` next to the compose file unless `--env-file .env` is passed,
so a deploy script that runs `pull`/`down` without it fails with "APP_KEY is required".
No secrets in this branch. Serves nginx on port 8188 (or FRONTEND_PORT).
