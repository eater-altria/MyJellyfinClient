#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/env.sh"
if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
  echo 'Usage: ensure-mpv.sh [PowerShell arguments...]'
  echo 'Windows: verified mpv download. macOS: stage installed libmpv dependencies.'
  exit 0
fi
if mjc_is_macos; then
  [ "$#" -eq 0 ] || { echo 'macOS runtime preparation accepts no extra arguments.' >&2; exit 2; }
  mjc_prepare_macos
  exit 0
fi
mjc_run_powershell ensure-mpv.ps1 "$@"
