# Release build (NSIS installer) using the globally installed Rust toolchain,
# with payload resources signed before bundling. Tauri's signCommand signs the
# application after binary patching, then the uninstaller and installer.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
& "$PSScriptRoot\sign.ps1" -Paths @(
  (Join-Path $projectRoot 'src-tauri\resources\mpv\mpv.exe'),
  (Join-Path $projectRoot 'src-tauri\resources\mpv\mpv.com')
)
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npx tauri build @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
