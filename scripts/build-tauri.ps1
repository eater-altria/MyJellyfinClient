# Release build (NSIS installer) using the globally installed Rust toolchain,
# then sign all binaries with the local dev certificate.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npx tauri build @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$PSScriptRoot\sign.ps1"
