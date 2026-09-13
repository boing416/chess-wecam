#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
if [ ! -x .venv/bin/python ]; then ./setup.sh; fi
.venv/bin/python -c 'import chess, cv2, numpy' || { echo 'Запустите ./setup.sh'; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Порт $PORT уже занят. Если Chess Cam уже работает, откройте http://localhost:$PORT"
  echo 'Или выберите другой порт: PORT=8001 ./run.sh'
  exit 1
fi
if [ "${OPEN_BROWSER:-1}" = 1 ]; then
  (sleep 1; open "http://localhost:$PORT") &
fi
exec .venv/bin/python server.py --port "$PORT"
