# Sign release binaries with the local dev code-signing certificate
# (created by scripts/make-dev-cert.ps1). Silently skips if no cert exists.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -like 'CN=MyJellyfinClient Dev*' } |
  Select-Object -First 1
if (-not $cert) {
  Write-Host "no dev cert found, skipping signing"
  exit 0
}

$targets = @(
  "$root\src-tauri\target\release\my-jellyfin-client.exe",
  "$root\src-tauri\resources\mpv\mpv.exe",
  "$root\src-tauri\resources\mpv\mpv.com"
)
$targets += Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue |
  ForEach-Object FullName

foreach ($f in $targets) {
  if (Test-Path $f) {
    $r = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -TimestampServer 'http://timestamp.digicert.com'
    Write-Host "$f -> $($r.Status)"
  }
}
