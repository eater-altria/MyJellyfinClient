#!/usr/bin/env bash
# Shared Bash environment; also safe to source from Bash 3.2 (macOS).
# Rust/MSVC setup remains in env.ps1 and is only needed for Windows desktop.
MJC_PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)" || return 1
export MJC_PROJECT_ROOT

mjc_is_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

mjc_is_macos() { [ "$(uname -s)" = Darwin ]; }

mjc_prepare_macos() {
  command -v cargo >/dev/null 2>&1 || { echo 'Rust/Cargo is required.' >&2; return 1; }
  command -v pkg-config >/dev/null 2>&1 || { echo 'pkg-config is required: brew install pkg-config' >&2; return 1; }
  pkg-config --exists mpv || { echo 'libmpv development files are required: brew install mpv' >&2; return 1; }
  xcrun --find clang >/dev/null || return 1
  # Override the repository Windows toolchain only for this shell process.
  export RUSTUP_TOOLCHAIN=stable
  if [ -z "${MJC_WEBVIEW_DATA:-}" ]; then export MJC_WEBVIEW_DATA="$MJC_PROJECT_ROOT/.local/macos"; fi
  /usr/bin/python3 "$MJC_PROJECT_ROOT/scripts/prepare-macos-runtime.py" || return 1
  export MACOSX_DEPLOYMENT_TARGET="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bundle"]["macOS"]["minimumSystemVersion"])' "$MJC_PROJECT_ROOT/.tmp/macos-build-config.json")"
}

mjc_require_web_tools() {
  command -v node >/dev/null 2>&1 || { echo 'Node.js 20+ is required.' >&2; return 1; }
  command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; return 1; }
  node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20+ is required."); process.exit(1); }' || return 1
}

mjc_install_dependencies() {
  mjc_require_web_tools || return 1
  cd -- "$MJC_PROJECT_ROOT" || return 1
  if [ ! -x node_modules/.bin/vite ] || [ ! -x node_modules/.bin/tsc ]; then
    echo 'Installing locked npm dependencies...'
    npm ci --cache "$MJC_PROJECT_ROOT/.npm-cache" --no-audit --no-fund || return 1
  fi
}

mjc_run_powershell() {
  local script_name="$1"
  shift
  if ! mjc_is_windows; then
    echo "${script_name} requires Windows (Git Bash), MSVC and the Windows SDK." >&2
    echo 'This PowerShell operation packages Windows resources and requires a Windows host.' >&2
    echo 'Use the macOS desktop launch/build entry, or --web on Linux.' >&2
    return 1
  fi
  command -v powershell.exe >/dev/null 2>&1 || { echo 'Windows PowerShell was not found.' >&2; return 1; }
  command -v cygpath >/dev/null 2>&1 || { echo 'cygpath was not found; run from Git Bash.' >&2; return 1; }
  cd -- "$MJC_PROJECT_ROOT" || return 1
  # Disable MSYS rewriting: -File is explicitly converted, remaining arguments
  # are passed verbatim (use Windows paths for PowerShell path parameters).
  MSYS2_ARG_CONV_EXCL='*' powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$(cygpath -w "$MJC_PROJECT_ROOT/scripts/$script_name")" "$@"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  mjc_require_web_tools
  echo "Project: $MJC_PROJECT_ROOT"
  echo 'Web tools ready. See scripts/README-sh.md for development and packaging.'
fi
