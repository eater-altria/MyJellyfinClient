# Dev launcher using the globally installed Rust toolchain.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
& "$PSScriptRoot\ensure-mpv.ps1"
& "$PSScriptRoot\check-runtime.ps1"
npx tauri dev @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
