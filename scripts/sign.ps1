# Sign selected release files with an existing local dev certificate.
# This script never creates certificates or changes certificate stores.
param([string[]]$Paths)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -like 'CN=MyJellyfinClient Dev*' } |
  Select-Object -First 1
if (-not $cert) {
  Write-Host "no dev cert found, skipping signing"
  return
}

$targets = $Paths
if (-not $targets) {
  $targets = @(
    "$root\src-tauri\target\release\my-jellyfin-client.exe",
    "$root\src-tauri\resources\mpv\mpv.exe",
    "$root\src-tauri\resources\mpv\mpv.com"
  )
  $targets += Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue |
    ForEach-Object FullName
}

foreach ($f in $targets) {
  if (Test-Path -LiteralPath $f) {
    if ((Get-AuthenticodeSignature -FilePath $f).Status -eq 'Valid') {
      Write-Host "$f -> already signed"
      continue
    }
    $r = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -TimestampServer 'http://timestamp.digicert.com'
    Write-Host "$f -> $($r.Status)"
    if ($r.Status -ne 'Valid') { throw "Signing failed: $f ($($r.Status))" }
  } else {
    throw "Signing target not found: $f"
  }
}
