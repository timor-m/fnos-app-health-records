#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
BASE_PYTHON="${OCR_PYTHON_BIN:-${STORAGE_DIR:-.data}/ocr-venv/bin/python}"
# Do not reinstall or remove the ready marker of a working legacy environment.
if [ ! -f "$(dirname "$(dirname "${BASE_PYTHON}")")/.health-records-ocr-ready" ] || ! "${BASE_PYTHON}" "${SCRIPT_DIR}/worker.py" --check >/dev/null 2>&1; then
  sh "${SCRIPT_DIR}/setup-runtime.sh"
fi
"${BASE_PYTHON}" "${SCRIPT_DIR}/install_table_runtime.py"
