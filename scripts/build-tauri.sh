#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/env.sh"

case "${1:-}" in
  -h|--help)
    echo 'Usage: build-tauri.sh [--web|--desktop] [--] [Tauri arguments...]'
    echo 'Default: macOS app/DMG, Windows NSIS; Web archive on Linux.'
    echo 'Web output: dist/ and .tmp/web-packages/MyJellyfinClient_<version>_web.tar.gz'
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
    # CI mode skips cosmetic Finder AppleScript and its Automation permission;
    # the app and Applications shortcut are still included in the DMG.
    CI="${CI:-true}" exec npx --no-install tauri build --config "$MJC_PROJECT_ROOT/.tmp/macos-build-config.json" "$@"
  fi
  if ! mjc_is_windows; then mjc_run_powershell build-tauri.ps1 "$@"; exit 1; fi
  mjc_install_dependencies
  mjc_run_powershell build-tauri.ps1 "$@"
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo 'Web packaging accepts no extra arguments. Use --desktop for Tauri options.' >&2
  exit 2
fi
command -v tar >/dev/null 2>&1 || { echo 'tar is required for Web packaging.' >&2; exit 1; }
mjc_install_dependencies
# The existing build performs TypeScript checking and a production Vite build.
npm run build
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$ ]]; then
  echo 'Invalid package version for archive filename.' >&2
  exit 1
fi
mkdir -p -- "$MJC_PROJECT_ROOT/.tmp/web-packages"
staging="$(mktemp -d "$MJC_PROJECT_ROOT/.tmp/web-build.XXXXXX")"
cleanup() {
  case "$staging" in
    "$MJC_PROJECT_ROOT"/.tmp/web-build.*) rm -rf -- "$staging" ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
archive="MyJellyfinClient_${version}_web.tar.gz"
# Explicitly package only production assets, never profiles or server accounts.
tar -czf "$staging/$archive" -C "$MJC_PROJECT_ROOT/dist" .
node - "$staging/$archive" > "$staging/$archive.sha256" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const file = process.argv[2];
console.log(`${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`);
NODE
mv -f -- "$staging/$archive" "$MJC_PROJECT_ROOT/.tmp/web-packages/$archive"
mv -f -- "$staging/$archive.sha256" "$MJC_PROJECT_ROOT/.tmp/web-packages/$archive.sha256"
echo "Web package: $MJC_PROJECT_ROOT/.tmp/web-packages/$archive"
echo "SHA-256: $MJC_PROJECT_ROOT/.tmp/web-packages/$archive.sha256"
echo 'Serve the extracted assets over HTTP. This is a Web package, not a desktop installer.'
