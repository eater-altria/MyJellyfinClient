# Dev launcher using the globally installed Rust toolchain.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
npx tauri dev @args
