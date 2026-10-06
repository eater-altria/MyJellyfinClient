# One-time: create a self-signed code-signing certificate and trust it
# (CurrentUser Root + TrustedPublisher) so unsigned-binary write blocks
# on this machine don't affect our app/installer.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$existing = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like 'CN=MyJellyfinClient Dev*' }
if ($existing) {
  Write-Host "cert already exists: $($existing[0].Thumbprint)"
  exit 0
}

$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=MyJellyfinClient Dev' `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
$cer = Join-Path ([IO.Path]::GetTempPath()) "mjc-dev-$([Guid]::NewGuid()).cer"
try {
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  certutil -user -addstore -f Root $cer | Out-Null
  certutil -user -addstore -f TrustedPublisher $cer | Out-Null
} finally { Remove-Item -LiteralPath $cer -ErrorAction SilentlyContinue }
Write-Host "cert created and trusted: $($cert.Thumbprint)"
