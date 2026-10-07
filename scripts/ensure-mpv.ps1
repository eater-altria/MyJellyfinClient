# Prepare missing mpv binaries without touching repository scripts or user data.
param(
  [string]$ResourceRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\resources')
)

$ErrorActionPreference = 'Stop'
$mpvRoot = [IO.Path]::GetFullPath((Join-Path $ResourceRoot 'mpv'))
$mpvDlls = @(Get-ChildItem -LiteralPath $mpvRoot -Filter '*.dll' -File -ErrorAction SilentlyContinue)
$binaryPaths = @((Join-Path $mpvRoot 'mpv.exe'), (Join-Path $mpvRoot 'mpv.com'))
$binaryPaths += $mpvDlls | ForEach-Object FullName
$missing = @($binaryPaths | Where-Object {
  -not (Test-Path -LiteralPath $_ -PathType Leaf) -or (Get-Item -LiteralPath $_).Length -eq 0
})
if ($missing.Count -eq 0 -and $mpvDlls.Count -gt 0) { return }

foreach ($tool in @('curl.exe', 'tar.exe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Automatic mpv setup needs Windows $tool. See README.md to prepare mpv manually."
  }
}

$temporaryRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp'))
$jobRoot = Join-Path $temporaryRoot ('mpv-download-' + [Guid]::NewGuid().ToString('N'))
# All recursive cleanup is confined to this newly created workspace directory.
if (-not $jobRoot.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Invalid mpv download staging path.'
}
[void](New-Item -ItemType Directory -Path $jobRoot -Force)
$previousTls = [Net.ServicePointManager]::SecurityProtocol
$downloadLock = $null
try {
  # Keep concurrent dev/build launches from installing different binary sets.
  $downloadLock = [IO.File]::Open((Join-Path $temporaryRoot 'mpv-download.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
  Write-Host 'mpv runtime is incomplete. Checking shinchiro releases...'
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest' -Headers @{
    'User-Agent' = 'MyJellyfinClient-runtime-setup'
    Accept = 'application/vnd.github+json'
  } -TimeoutSec 30
  # The ordinary x64 build also works on CPUs without the x86_64-v3 extensions.
  $assets = @($release.assets | Where-Object { $_.name -match '^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$' })
  if ($assets.Count -ne 1) { throw 'The latest release does not contain exactly one standard x86_64 mpv archive.' }
  $asset = $assets[0]
  if ($asset.digest -notmatch '^sha256:([0-9a-f]{64})$') { throw 'The mpv release is missing its SHA-256 digest.' }
  $expectedHash = $Matches[1]
  if ($asset.browser_download_url -cne "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$($release.tag_name)/$($asset.name)" -or $asset.size -le 0) {
    throw 'The mpv release contains invalid download metadata.'
  }

  $archivePath = Join-Path $jobRoot $asset.name
  Write-Host "Downloading $($asset.name)..."
  & curl.exe --fail --location --retry 2 --connect-timeout 20 --max-time 600 --proto '=https' --proto-redir '=https' --output $archivePath $asset.browser_download_url
  if ($LASTEXITCODE -ne 0) { throw "mpv download failed (curl exit $LASTEXITCODE)." }
  if ((Get-Item -LiteralPath $archivePath).Length -ne $asset.size -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ine $expectedHash) {
    throw 'mpv download failed size/SHA-256 verification. Existing runtime files were kept.'
  }

  $entries = @(& tar.exe -tf $archivePath)
  if ($LASTEXITCODE -ne 0) { throw 'Windows tar could not read the mpv archive.' }
  # Extract only top-level runtime binaries, never portable_config or paths outside staging.
  $binaryEntries = @($entries | Where-Object { $_ -match '^(?:\./)?(?:mpv\.(?:exe|com)|[^/\\]+\.dll)$' })
  $extractRoot = Join-Path $jobRoot 'extracted'
  [void](New-Item -ItemType Directory -Path $extractRoot)
  if ($binaryEntries.Count -eq 0) { throw 'The mpv archive contains no runtime binaries.' }
  & tar.exe -xf $archivePath -C $extractRoot -- @binaryEntries
  if ($LASTEXITCODE -ne 0) { throw 'Windows tar could not extract the mpv runtime.' }
  $newDlls = @(Get-ChildItem -LiteralPath $extractRoot -Filter '*.dll' -File)
  $newFiles = @((Get-Item -LiteralPath (Join-Path $extractRoot 'mpv.exe')), (Get-Item -LiteralPath (Join-Path $extractRoot 'mpv.com'))) + $newDlls
  if ($newDlls.Count -eq 0 -or @($newFiles | Where-Object { $_.Length -eq 0 }).Count -gt 0) {
    throw 'The mpv archive is missing a required non-empty EXE, COM or DLL.'
  }
  $reader = [IO.BinaryReader]::new([IO.File]::OpenRead((Join-Path $extractRoot 'mpv.exe')))
  try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Downloaded mpv.exe is not a Windows executable.' }
    $reader.BaseStream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt $reader.BaseStream.Length - 6) { throw 'Downloaded mpv.exe has an invalid PE header.' }
    $reader.BaseStream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Downloaded mpv.exe is not Windows x64.' }
  } finally { $reader.Dispose() }

  # Validate the whole download before replacing an incomplete existing installation.
  [void](New-Item -ItemType Directory -Path $mpvRoot -Force)
  $oldFiles = @(Get-ChildItem -LiteralPath $mpvRoot -File | Where-Object { $_.Name -in @('mpv.exe', 'mpv.com') -or $_.Extension -eq '.dll' })
  $backupRoot = Join-Path $jobRoot 'backup'
  [void](New-Item -ItemType Directory -Path $backupRoot)
  foreach ($file in $oldFiles) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backupRoot $file.Name) }
  try {
    foreach ($file in $newFiles) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $mpvRoot $file.Name) -Force }
    foreach ($file in $oldFiles | Where-Object { $_.Name -notin $newFiles.Name }) {
      Remove-Item -LiteralPath (Join-Path $mpvRoot $file.Name) -Force
    }
  } catch {
    $installError = $_
    foreach ($file in $newFiles | Where-Object { $_.Name -notin $oldFiles.Name }) {
      Remove-Item -LiteralPath (Join-Path $mpvRoot $file.Name) -Force -ErrorAction SilentlyContinue
    }
    foreach ($file in $oldFiles) { Copy-Item -LiteralPath (Join-Path $backupRoot $file.Name) -Destination $file.FullName -Force }
    throw $installError
  }
  Write-Host "mpv runtime is ready ($($release.tag_name), SHA-256 verified)."
} catch {
  throw "Automatic mpv setup failed: $($_.Exception.Message) Retry the command, or see README.md for manual setup."
} finally {
  [Net.ServicePointManager]::SecurityProtocol = $previousTls
  if ($downloadLock) { $downloadLock.Dispose() }
  Remove-Item -LiteralPath $jobRoot -Recurse -Force
}
