#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ "${1:-}" = --help ]; then
  echo 'Usage: prototype-macos-mpv.sh [--build-only | --demo | --self-test | --self-test-hevc | local-video-file]'
  echo 'Requires macOS, Xcode Command Line Tools, Homebrew libmpv (brew install mpv).'
  exit 0
fi
[ "$(uname -s)" = Darwin ] || { echo 'This prototype requires macOS.' >&2; exit 1; }
command -v pkg-config >/dev/null || { echo 'pkg-config is required.' >&2; exit 1; }
pkg-config --exists mpv || { echo 'libmpv is missing. Install with: brew install mpv' >&2; exit 1; }
mkdir -p "$root/.tmp/macos-libmpv"
# pkg-config output consists of compiler flags; array splitting is intentional.
read -r -a mpv_cflags <<< "$(pkg-config --cflags mpv)"
read -r -a mpv_ldflags <<< "$(pkg-config --libs mpv)"
xcrun clang -fobjc-arc -Wall -Wextra -Werror -Wno-deprecated-declarations \
  "${mpv_cflags[@]}" "$root/prototypes/macos-libmpv/main.m" \
  -framework Cocoa -framework OpenGL "${mpv_ldflags[@]}" \
  -Wl,-rpath,"$(pkg-config --variable=libdir mpv)" -o "$root/.tmp/macos-libmpv/prototype.build"
mv -f "$root/.tmp/macos-libmpv/prototype.build" "$root/.tmp/macos-libmpv/prototype"
app="$root/.tmp/macos-libmpv/MyJellyfinClient-GPU-Prototype.app"
mkdir -p "$app/Contents/MacOS"
cp "$root/.tmp/macos-libmpv/prototype" "$app/Contents/MacOS/Prototype.build"
mv -f "$app/Contents/MacOS/Prototype.build" "$app/Contents/MacOS/Prototype"
# Generate plist with proper XML escaping even when the project path contains &.
/usr/bin/python3 - "$app/Contents/Info.plist" "$root" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as stream:
    plistlib.dump({'CFBundleExecutable': 'Prototype', 'CFBundleIdentifier': 'com.myjellyfinclient.gpu-prototype',
                  'CFBundleName': 'MyJellyfinClient GPU Prototype', 'CFBundlePackageType': 'APPL',
                  'CFBundleVersion': '1', 'NSHighResolutionCapable': True,
                  'MJCProjectRoot': sys.argv[2]}, stream)
PY
case "${1:-}" in
  --build-only) echo "Built: $app" ;;
  --demo)
    command -v ffmpeg >/dev/null || { echo 'ffmpeg is required for the demo.' >&2; exit 1; }
    out="$root/.tmp/macos-libmpv/demo"
    mkdir -p "$out"
    ffmpeg -hide_banner -loglevel error -y -f lavfi \
      -i 'testsrc2=size=1280x720:rate=30:duration=30' -c:v libx264 -pix_fmt yuv420p "$out/demo.mp4"
    exec "$app/Contents/MacOS/Prototype" "$root" "$out/demo.mp4"
    ;;
  --self-test|--self-test-hevc)
    command -v ffmpeg >/dev/null || { echo 'ffmpeg is required for synthetic verification.' >&2; exit 1; }
    out="$root/.tmp/macos-libmpv/test"
    if [ "$1" = --self-test-hevc ]; then out="$root/.tmp/macos-libmpv/test-hevc"; fi
    mkdir -p "$out"
    # Only synthetic content, no media server or user files.
    if [ "$1" = --self-test-hevc ]; then
      fixture="$out/fixture.mkv"
      ffmpeg -hide_banner -loglevel error -y -f lavfi \
        -i 'testsrc2=size=3840x2160:rate=24:duration=2' -c:v libx265 -preset ultrafast \
        -x265-params 'log-level=error:pools=2:frame-threads=2' -pix_fmt yuv420p10le "$fixture"
    else
      fixture="$out/fixture.mp4"
      ffmpeg -hide_banner -loglevel error -y -f lavfi \
        -i 'testsrc2=size=960x556:rate=30:duration=5' -c:v libx264 -pix_fmt yuv420p "$fixture"
    fi
    exec "$root/.tmp/macos-libmpv/prototype" "$root" "$fixture" --self-test "$out"
    ;;
  *)
    if [ "$#" -gt 1 ]; then echo 'Expected a single local video path.' >&2; exit 2; fi
    if [ "$#" -eq 1 ]; then
      [ -f "$1" ] || { echo 'Local video file not found.' >&2; exit 1; }
      media="$(cd -- "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1")"
      exec "$root/.tmp/macos-libmpv/prototype" "$root" "$media"
    else
      exec "$root/.tmp/macos-libmpv/prototype" "$root"
    fi
    ;;
esac
