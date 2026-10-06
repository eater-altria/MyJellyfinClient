# Use the globally installed Rust toolchain. A newly installed rustup may not
# appear in an already-open terminal's PATH yet.
$projectRoot = Split-Path -Parent $PSScriptRoot
# Clear only overrides left by the removed workspace toolchain.
foreach ($entry in @(@('CARGO_HOME', '.toolchain\cargo'), @('RUSTUP_HOME', '.toolchain\rustup'))) {
  $previous = [Environment]::GetEnvironmentVariable($entry[0], 'Process')
  if ($previous -and $previous.TrimEnd('\') -eq (Join-Path $projectRoot $entry[1])) {
    Remove-Item -LiteralPath ("Env:\" + $entry[0]) -ErrorAction SilentlyContinue
  }
}
# rustup environment overrides take priority over rust-toolchain.toml.
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
if ($env:CARGO_BUILD_TARGET -match 'windows-(gnu|gnullvm)$') {
  Remove-Item Env:\CARGO_BUILD_TARGET
}
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
  $env:PATH = "$cargoBin;$env:PATH"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw 'Global Cargo was not found. Install Rust and reopen your terminal.'
}
# Persistent development data is separate from disposable build files.
if (-not $env:MJC_WEBVIEW_DATA) {
  $env:MJC_WEBVIEW_DATA = Join-Path $projectRoot '.local\webview2'
}
Set-Location $projectRoot
