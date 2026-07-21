#!/bin/sh
set -eu
frontend_url="${FRONTEND_URL:-http://127.0.0.1:8088}"
api_url="${API_URL:-http://127.0.0.1:3002}"
frontend=$(curl -fsS "$frontend_url/")
health=$(curl -fsS "$api_url/health")
printf '%s' "$frontend" | grep -q 'Hello from deploy-test-docker-compose'
printf '%s' "$health" | grep -q '"status":"ok"'
printf '%s' "$health" | grep -q '"app":"compose-api"'
echo 'Docker Compose smoke test passed on ports 8088 and 3002'
