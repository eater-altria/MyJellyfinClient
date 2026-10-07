# Offline regression tests; only transport is mocked, extraction uses Windows tar.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = Split-Path -Parent $PSScriptRoot
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp'))
$testRoot = Join-Path $temporaryRoot ('mpv-setup-test-' + [Guid]::NewGuid().ToString('N'))
$escapedPath = $testRoot + '-escape.dll'
$originalLocation = (Get-Location).Path
if (-not $testRoot.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Invalid regression test path.'
}
[void](New-Item -ItemType Directory -Path $testRoot -Force)
$global:mjcMpvSetupapiCalls = 0
$global:mjcMpvSetupdownloadCalls = 0
$global:mjcMpvSetupfailApi = $false
$global:mjcMpvSetupfailDownload = $false
$global:mjcMpvSetupfailCopyTarget = $null
$global:mjcMpvSetuplaunches = @()

function Write-FixtureFile([string]$Path, [string]$Text) {
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force)
  [IO.File]::WriteAllText($Path, $Text)
}

function New-Archive([string]$Name, [switch]$MissingCom, [switch]$WrongArchitecture) {
  $source = Join-Path $testRoot $Name
  [void](New-Item -ItemType Directory -Path $source)
  $pe = New-Object byte[] 128
  $pe[0] = 0x4d; $pe[1] = 0x5a; $pe[0x3c] = 0x40
  $pe[0x40] = 0x50; $pe[0x41] = 0x45; $pe[0x44] = 0x64; $pe[0x45] = 0x86
  if ($WrongArchitecture) { $pe[0x44] = 0x4c; $pe[0x45] = 0x01 }
  [IO.File]::WriteAllBytes((Join-Path $source 'mpv.exe'), $pe)
  if (-not $MissingCom) { Write-FixtureFile (Join-Path $source 'mpv.com') 'new launcher' }
  Write-FixtureFile (Join-Path $source 'd3dcompiler_43.dll') 'new DLL'
  Write-FixtureFile (Join-Path $source 'portable_config/scripts/mjc-osc.lua') 'upstream script must not be installed'
  Write-FixtureFile (Join-Path $source 'portable_config/shaders/mjc-glass.glsl') 'upstream shader must not be installed'
  $archive = Join-Path $testRoot ($Name + '.zip')
  [IO.Compression.ZipFile]::CreateFromDirectory($source, $archive)
  # A traversal member must also remain unextracted.
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Update)
  try {
    $entry = $zip.CreateEntry('../../' + (Split-Path -Leaf $escapedPath))
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write('must not escape extraction') } finally { $writer.Dispose() }
  } finally { $zip.Dispose() }
  return $archive
}

function Set-Release([string]$Archive) {
  $global:mjcMpvSetuparchive = $Archive
  $assetName = 'mpv-x86_64-20261007-git-abcdef.7z'
  $global:mjcMpvSetupasset = [pscustomobject]@{
    name = $assetName
    size = (Get-Item -LiteralPath $Archive).Length
    digest = 'sha256:' + (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    browser_download_url = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/fixture/' + $assetName
  }
  $global:mjcMpvSetuprelease = [pscustomobject]@{
    tag_name = 'fixture'
    assets = @(
      [pscustomobject]@{ name = 'mpv-x86_64-v3-20261007-git-abcdef.7z' },
      [pscustomobject]@{ name = 'mpv-dev-x86_64-20261007-git-abcdef.7z' },
      [pscustomobject]@{ name = 'mpv-i686-20261007-git-abcdef.7z' },
      $global:mjcMpvSetupasset
    )
  }
}

function Invoke-RestMethod {
  param($Uri, $Headers, $TimeoutSec)
  $global:mjcMpvSetupapiCalls++
  if ($global:mjcMpvSetupfailApi) { throw 'Network must not be used for a complete runtime.' }
  if ($Uri -ne 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest') { throw 'Unexpected release API.' }
  return $global:mjcMpvSetuprelease
}

function curl.exe {
  $global:mjcMpvSetupdownloadCalls++
  if ($global:mjcMpvSetupfailDownload) { $global:LASTEXITCODE = 22; return }
  $outputIndex = [Array]::IndexOf($args, '--output')
  if ($outputIndex -lt 0 -or $args[-1] -ne $global:mjcMpvSetupasset.browser_download_url) { throw 'Unexpected download arguments.' }
  Copy-Item -LiteralPath $global:mjcMpvSetuparchive -Destination $args[$outputIndex + 1]
  $global:LASTEXITCODE = 0
}

function Copy-Item {
  param([string]$LiteralPath, [string]$Destination, [switch]$Force)
  if ($global:mjcMpvSetupfailCopyTarget -eq $Destination) {
    $global:mjcMpvSetupfailCopyTarget = $null
    throw 'Fixture installation failure.'
  }
  Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}

function npx {
  & "$global:mjcMpvSetuplauncherRoot\scripts\check-runtime.ps1"
  $global:mjcMpvSetuplaunches += 'npx ' + ($args -join ' ')
  $global:LASTEXITCODE = 0
}

function npm {
  $global:mjcMpvSetuplaunches += 'npm ' + ($args -join ' ')
  $global:LASTEXITCODE = 0
}

function Get-Snapshot([string]$Root) {
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName | ForEach-Object {
    $_.FullName + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }) -join '|'
}

function Assert-Failure([string]$Root, [string]$Pattern) {
  $before = Get-Snapshot $Root
  $failed = $false
  try { & "$PSScriptRoot\ensure-mpv.ps1" -ResourceRoot $Root } catch {
    if ($_.Exception.Message -notmatch $Pattern) { throw }
    $failed = $true
  }
  if (-not $failed) { throw "Expected setup failure: $Pattern" }
  if ((Get-Snapshot $Root) -ne $before) { throw 'Failed setup changed existing resources.' }
}

try {
  $validArchive = New-Archive 'valid'
  Set-Release $validArchive
  $root = Join-Path $testRoot 'resources'
  $oscPath = Join-Path $root 'mpv/portable_config/scripts/mjc-osc.lua'
  $glassPath = Join-Path $root 'mpv/portable_config/shaders/mjc-glass.glsl'
  Write-FixtureFile $oscPath 'repository OSC'
  Write-FixtureFile $glassPath 'repository shader'
  Write-FixtureFile (Join-Path $root 'WebView2Loader.dll') 'repository loader'
  & "$PSScriptRoot\ensure-mpv.ps1" -ResourceRoot $root
  & "$PSScriptRoot\check-runtime.ps1" -ResourceRoot $root
  if (Test-Path -LiteralPath $escapedPath) { throw 'An archive member escaped the extraction directory.' }
  if ([IO.File]::ReadAllText($oscPath) -ne 'repository OSC' -or [IO.File]::ReadAllText($glassPath) -ne 'repository shader') {
    throw 'Setup overwrote repository controls.'
  }
  if ((Get-Item -LiteralPath (Join-Path $root 'mpv/mpv.exe')).Length -ne 128 -or $global:mjcMpvSetupdownloadCalls -ne 1) {
    throw 'Missing runtime was not installed.'
  }
  $snapshot = Get-Snapshot $root
  $global:mjcMpvSetupfailApi = $true
  & "$PSScriptRoot\ensure-mpv.ps1" -ResourceRoot $root
  if ($global:mjcMpvSetupapiCalls -ne 1 -or (Get-Snapshot $root) -ne $snapshot) { throw 'Complete runtime was not reused offline.' }
  $global:mjcMpvSetupfailApi = $false

  # A partial runtime must be replaced as one build, including its DLL set.
  [IO.File]::WriteAllText((Join-Path $root 'mpv/mpv.com'), '')
  Write-FixtureFile (Join-Path $root 'mpv/obsolete.dll') 'old DLL'
  & "$PSScriptRoot\ensure-mpv.ps1" -ResourceRoot $root
  if (Test-Path -LiteralPath (Join-Path $root 'mpv/obsolete.dll')) { throw 'Obsolete DLL was left in the repaired runtime.' }
  & "$PSScriptRoot\check-runtime.ps1" -ResourceRoot $root

  [IO.File]::WriteAllText((Join-Path $root 'mpv/mpv.com'), '')
  $global:mjcMpvSetupfailDownload = $true
  Assert-Failure $root 'curl exit 22'
  $global:mjcMpvSetupfailDownload = $false
  $global:mjcMpvSetupasset.digest = 'sha256:' + ('0' * 64)
  Assert-Failure $root 'SHA-256'
  Set-Release (New-Archive 'missing-com' -MissingCom)
  Assert-Failure $root 'mpv.com'
  Set-Release (New-Archive 'wrong-architecture' -WrongArchitecture)
  Assert-Failure $root 'not Windows x64'
  Set-Release $validArchive
  $global:mjcMpvSetuprelease.assets = @($global:mjcMpvSetuprelease.assets | Where-Object { $_.name -ne $global:mjcMpvSetupasset.name })
  Assert-Failure $root 'standard x86_64'
  Set-Release $validArchive
  $global:mjcMpvSetupasset.digest = $null
  Assert-Failure $root 'missing its SHA-256'
  Set-Release $validArchive
  $global:mjcMpvSetupfailCopyTarget = Join-Path $root 'mpv/d3dcompiler_43.dll'
  Assert-Failure $root 'Fixture installation failure'

  # Exercise both real launchers with an empty runtime, without starting services or signing.
  $global:mjcMpvSetuplauncherRoot = Join-Path $testRoot 'launcher'
  $fixtureScripts = Join-Path $global:mjcMpvSetuplauncherRoot 'scripts'
  [void](New-Item -ItemType Directory -Path $fixtureScripts)
  foreach ($file in @('dev-tauri.ps1', 'build-tauri.ps1', 'ensure-mpv.ps1', 'check-runtime.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $fixtureScripts $file)
  }
  Write-FixtureFile (Join-Path $fixtureScripts 'env.ps1') '$projectRoot = Split-Path -Parent $PSScriptRoot; Set-Location $projectRoot'
  Write-FixtureFile (Join-Path $fixtureScripts 'sign.ps1') 'param([string[]]$Paths); & "$PSScriptRoot\check-runtime.ps1"; $global:mjcMpvSetuplaunches += "sign"'
  $fixtureResources = Join-Path $global:mjcMpvSetuplauncherRoot 'src-tauri/resources'
  Write-FixtureFile (Join-Path $fixtureResources 'mpv/portable_config/scripts/mjc-osc.lua') 'repository OSC'
  Write-FixtureFile (Join-Path $fixtureResources 'mpv/portable_config/shaders/mjc-glass.glsl') 'repository shader'
  Write-FixtureFile (Join-Path $fixtureResources 'WebView2Loader.dll') 'repository loader'
  & (Join-Path $fixtureScripts 'dev-tauri.ps1') --no-watch
  & (Join-Path $fixtureScripts 'build-tauri.ps1') --debug
  if (($global:mjcMpvSetuplaunches -join '|') -ne 'npx tauri dev --no-watch|sign|npm run build|npx tauri build --debug') {
    throw 'Launchers did not prepare mpv before development/signing/building or forward arguments.'
  }
  [IO.File]::WriteAllText((Join-Path $fixtureResources 'mpv/mpv.com'), '')
  $global:mjcMpvSetupfailDownload = $true
  $failed = $false
  try { & (Join-Path $fixtureScripts 'dev-tauri.ps1') } catch {
    if ($_.Exception.Message -notmatch 'curl exit 22') { throw }
    $failed = $true
  }
  if (-not $failed -or $global:mjcMpvSetuplaunches.Count -ne 4) { throw 'Development started after a failed download.' }
  if (@(Get-ChildItem -LiteralPath $temporaryRoot -Filter 'mpv-download-*' -Directory).Count -ne 0) {
    throw 'Setup left a staging directory after completion or failure.'
  }
  Write-Output 'PASS: download, x64 selection, offline reuse, partial repair, controls preservation, checksum, archive validation, install rollback, staging cleanup and both launchers.'
} finally {
  Set-Location $originalLocation
  Remove-Item -LiteralPath $testRoot -Recurse -Force
  if (Test-Path -LiteralPath $escapedPath) { Remove-Item -LiteralPath $escapedPath -Force }
}
