#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/env.sh"
if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
  echo 'Usage: build-portable.sh [PowerShell arguments...] (Windows Git Bash only)'
  echo 'Run build-tauri.sh --desktop first. Use Windows paths for path parameters.'
  exit 0
fi
mjc_run_powershell build-portable.ps1 "$@"
