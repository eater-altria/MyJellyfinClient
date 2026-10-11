#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/env.sh"
if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
  echo 'Usage: check-runtime.sh [--web | PowerShell arguments...]'
  echo 'Default: native runtime check on macOS/Windows; Web tools on Linux.'
  exit 0
fi
if mjc_is_macos && [ "${1:-}" != '--web' ]; then
  [ "$#" -eq 0 ] || { echo 'macOS runtime check accepts no extra arguments.' >&2; exit 2; }
  mjc_require_web_tools
  mjc_prepare_macos
  echo 'macOS native runtime ready.'
  exit 0
fi
if [ "${1:-}" = '--web' ] || ! mjc_is_windows; then
  if [ "${1:-}" = '--web' ]; then shift; fi
  if [ "$#" -ne 0 ]; then echo 'Web tool check accepts no extra arguments.' >&2; exit 2; fi
  mjc_require_web_tools
  echo 'Web runtime ready: Node.js 20+ and npm. Dependencies install on first launch/build.'
else
  mjc_run_powershell check-runtime.ps1 "$@"
fi
