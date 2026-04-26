#!/usr/bin/env bash
# Starts the full Motor Lolo CD stack for the Replit preview pane:
#   - Python TTS engine (edge_tts + Piper + WORLD)  on TTS_SERVICE_PORT (default 5001)
#   - Express API server (serves /api/* AND the built React UI at /)  on PORT (default 5000)
#
# Logs from both processes are interleaved on stdout so the workflow console shows everything.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export TTS_SERVICE_PORT="${TTS_SERVICE_PORT:-5001}"
export PORT="${PORT:-5000}"
export BASE_PATH="${BASE_PATH:-/}"
export NODE_ENV="${NODE_ENV:-production}"
export TTS_SERVICE_URL="${TTS_SERVICE_URL:-http://127.0.0.1:${TTS_SERVICE_PORT}}"
export TTS_API_URL="${TTS_API_URL:-http://127.0.0.1:${PORT}/api/tts/generate}"
export FRONTEND_DIST="${FRONTEND_DIST:-$ROOT_DIR/artifacts/lolo-cd/dist/public}"

# 0) Auto-instalar dependencias si faltan (al recargar el repositorio).
#    Idempotente: si ya están instaladas, pnpm/uv salen casi de inmediato.
if [ ! -d "$ROOT_DIR/node_modules" ] || [ ! -d "$ROOT_DIR/artifacts/lolo-cd/node_modules" ]; then
  echo "[bootstrap] node_modules ausente — corriendo 'pnpm install' (solo la primera vez)…"
  pnpm install --prefer-offline
fi

if [ ! -d "$ROOT_DIR/.pythonlibs" ] && command -v uv >/dev/null 2>&1; then
  echo "[bootstrap] .pythonlibs ausente — corriendo 'uv sync' (solo la primera vez)…"
  UV_PROJECT_ENVIRONMENT="$ROOT_DIR/.pythonlibs" uv sync --frozen || \
    UV_PROJECT_ENVIRONMENT="$ROOT_DIR/.pythonlibs" uv sync
fi

# 1) Build artifacts on first run (idempotent and cheap thanks to vite/esbuild caches)
if [ ! -f "$FRONTEND_DIST/index.html" ]; then
  echo "[bootstrap] Building React frontend (lolo-cd)…"
  pnpm --filter @workspace/lolo-cd run build
fi

if [ ! -f "$ROOT_DIR/artifacts/api-server/dist/index.mjs" ]; then
  echo "[bootstrap] Building API server…"
  pnpm --filter @workspace/api-server run build
fi

cleanup() {
  echo "[bootstrap] Shutting down child processes…"
  if [ -n "${TTS_PID:-}" ] && kill -0 "$TTS_PID" 2>/dev/null; then
    kill "$TTS_PID" 2>/dev/null || true
    wait "$TTS_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 2) Start the Python TTS engine in the background
echo "[bootstrap] Starting Python TTS engine on port $TTS_SERVICE_PORT…"
python3 tts_service.py 2>&1 | sed -u 's/^/[tts] /' &
TTS_PID=$!

# 3) Wait briefly for the TTS engine to become healthy (non-fatal if slow)
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${TTS_SERVICE_PORT}/health" >/dev/null 2>&1; then
    echo "[bootstrap] TTS engine ready ✓"
    break
  fi
  sleep 0.5
done

# 4) Start the API server in the foreground (port 5000 → preview pane)
echo "[bootstrap] Starting API server + UI on port $PORT…"
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
