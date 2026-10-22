#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo 'Este entorno requiere Node 24.' >&2
  exit 1
fi
npm --prefix backend ci --ignore-scripts --no-fund
npm --prefix frontend ci --ignore-scripts --no-fund
echo 'Listo. Lee docs/CLOUD_DEVELOPMENT.md para iniciar el sandbox aislado.'
