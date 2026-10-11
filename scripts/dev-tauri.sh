#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/env.sh"

case "${1:-}" in
  -h|--help)
    echo 'Usage: dev-tauri.sh [--web|--desktop] [--] [arguments...]'
    echo 'Default: native desktop on macOS/Windows; Web on Linux.'
    exit 0 ;;
esac
mode=web
if mjc_is_windows || mjc_is_macos; then mode=desktop; fi
case "${1:-}" in
  --web) mode=web; shift ;;
  --desktop) mode=desktop; shift ;;
esac
if [ "${1:-}" = '--' ]; then shift; fi
if [ "$mode" = desktop ]; then
  if mjc_is_macos; then
    mjc_prepare_macos
    mjc_install_dependencies
    exec npx --no-install tauri dev --config "$MJC_PROJECT_ROOT/.tmp/macos-build-config.json" "$@"
  fi
  if ! mjc_is_windows; then mjc_run_powershell dev-tauri.ps1 "$@"; exit 1; fi
  mjc_install_dependencies
  mjc_run_powershell dev-tauri.ps1 "$@"
else
  mjc_install_dependencies
  echo 'Starting browser development (HTML5/HLS playback; no native mpv).'
  exec npm run dev:web -- --host 127.0.0.1 "$@"
fi
