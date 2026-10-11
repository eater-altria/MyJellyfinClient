#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/env.sh"
mjc_is_macos || { echo 'Native regression requires macOS.' >&2; exit 1; }
mjc_prepare_macos
out="$MJC_PROJECT_ROOT/.tmp/macos-native-test"
mkdir -p "$out"
command -v ffmpeg >/dev/null || { echo 'FFmpeg is required for synthetic media.' >&2; exit 1; }
ffmpeg -hide_banner -loglevel error -y -f lavfi \
  -i 'testsrc2=size=3840x2160:rate=24:duration=2' -c:v libx265 -preset ultrafast \
  -x265-params 'log-level=error:pools=2:frame-threads=2' -pix_fmt yuv420p10le "$out/fixture.mkv"
read -r -a flags <<< "$(pkg-config --cflags mpv)"
read -r -a libs <<< "$(pkg-config --libs mpv)"
xcrun clang -fobjc-arc -Wall -Wextra -Werror -Wno-deprecated-declarations \
  "${flags[@]}" "$MJC_PROJECT_ROOT/scripts/test-macos-native.m" "$MJC_PROJECT_ROOT/src-tauri/src/player_macos.m" \
  -framework Cocoa -framework WebKit -framework OpenGL -framework Security "${libs[@]}" -o "$out/native-regression"
exec "$out/native-regression" "$MJC_PROJECT_ROOT" "$out/fixture.mkv" "$out"
