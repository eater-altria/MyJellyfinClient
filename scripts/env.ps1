# Use the globally installed Rust toolchain. A newly installed rustup may not
# appear in an already-open terminal's PATH yet.
$projectRoot = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
  $env:PATH = "$cargoBin;$env:PATH"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw '未找到全局 Cargo，请先安装 Rust 并重新打开终端。'
}
# Persistent development data is separate from disposable build files.
if (-not $env:MJC_WEBVIEW_DATA) {
  $env:MJC_WEBVIEW_DATA = Join-Path $projectRoot '.local\webview2'
}
Set-Location $projectRoot
