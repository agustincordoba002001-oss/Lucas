#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push || true

# Reconstruye los artifacts solo si no estan presentes en el repo.
# (Se commitean en git para evitar rebuilds en cada reimport.)
if [ ! -f "artifacts/lolo-cd/dist/public/index.html" ]; then
  PORT=5000 BASE_PATH=/ pnpm --filter @workspace/lolo-cd run build
fi
if [ ! -f "artifacts/api-server/dist/index.mjs" ]; then
  pnpm --filter @workspace/api-server run build
fi
