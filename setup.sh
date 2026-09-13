#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi
.venv/bin/python -m pip install -r requirements.txt
if ! command -v stockfish >/dev/null && [ ! -x /opt/homebrew/bin/stockfish ]; then
  if command -v brew >/dev/null; then
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install stockfish
  else
    echo 'Установите Stockfish: https://stockfishchess.org/download/'
    exit 1
  fi
fi
echo 'Готово. Запуск: ./run.sh'
