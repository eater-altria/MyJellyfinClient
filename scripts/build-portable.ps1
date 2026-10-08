# Package an already-built x64 application and explicit runtime resources.
# No accounts, development profiles, caches or registry entries are packaged.
param(
  [string]$ApplicationPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release\my-jellyfin-client.exe'),
  [string]$ResourceRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\resources'),
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release\bundle\portable'),
  [string]$MakensisPath = (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
  [switch]$SkipSign
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Portable builds require a numeric release version.' }
if (-not (Test-Path -LiteralPath $MakensisPath -PathType Leaf)) {
  throw 'NSIS was not found. Run ./scripts/build-tauri.ps1 first, or pass -MakensisPath.'
}
& "$PSScriptRoot\check-runtime.ps1" -ResourceRoot $ResourceRoot

function Assert-X64Executable([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $reader = New-Object IO.BinaryReader($stream)
  try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Invalid executable: $Path" }
    $stream.Position = 0x3c
    $stream.Position = $reader.ReadInt32()
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
      throw "Not a Windows x64 executable: $Path"
    }
  } finally { $reader.Dispose(); $stream.Dispose() }
}

function Quote-NsisPath([string]$Path) {
  if ($Path.IndexOfAny([char[]]'$"' + [char[]]"`r`n") -ge 0) { throw "Unsupported NSIS path: $Path" }
  return '"' + $Path + '"'
}

Assert-X64Executable $ApplicationPath
Assert-X64Executable (Join-Path $ResourceRoot 'mpv\mpv.exe')
$fileVersion = (Get-Item -LiteralPath $ApplicationPath).VersionInfo.FileVersion
if ($fileVersion -ne $version -and $fileVersion -ne "$version.0") {
  throw "Application version ($fileVersion) differs from package version ($version). Rebuild the release application."
}
if (-not $SkipSign) {
  & "$PSScriptRoot\sign.ps1" -Paths @($ApplicationPath, (Join-Path $ResourceRoot 'mpv\mpv.exe'), (Join-Path $ResourceRoot 'mpv\mpv.com'))
}

$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp'))
$staging = Join-Path $temporaryRoot ('portable-build-' + [Guid]::NewGuid().ToString('N'))
if (-not $staging.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Invalid portable staging path.'
}
[void](New-Item -ItemType Directory -Path $staging -Force)
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
$output = [IO.Path]::GetFullPath((Join-Path $OutputDirectory "MyJellyfinClient_${version}_x64-portable.exe"))
try {
  $files = @(
    @{ Source = [IO.Path]::GetFullPath($ApplicationPath); Destination = 'my-jellyfin-client.exe' },
    @{ Source = [IO.Path]::GetFullPath((Join-Path $ResourceRoot 'WebView2Loader.dll')); Destination = 'WebView2Loader.dll' },
    @{ Source = [IO.Path]::GetFullPath((Join-Path $ResourceRoot 'mpv\portable_config\scripts\mjc-osc.lua')); Destination = 'mpv\portable_config\scripts\mjc-osc.lua' },
    @{ Source = [IO.Path]::GetFullPath((Join-Path $ResourceRoot 'mpv\portable_config\shaders\mjc-glass.glsl')); Destination = 'mpv\portable_config\shaders\mjc-glass.glsl' }
  )
  foreach ($file in Get-ChildItem -LiteralPath (Join-Path $ResourceRoot 'mpv') -File) {
    if ($file.Extension -in @('.exe', '.com', '.dll')) {
      $files += @{ Source = $file.FullName; Destination = 'mpv\' + $file.Name }
    }
  }
  $manifest = Join-Path $staging 'payload.nsh'
  $lines = foreach ($file in $files) {
    $relativeDirectory = [IO.Path]::GetDirectoryName($file.Destination)
    $target = '$PLUGINSDIR\app' + $(if ($relativeDirectory) { '\' + $relativeDirectory })
    if ($file.Destination -match '[\r\n$"]' -or $file.Destination.Contains('..')) { throw 'Unsafe resource name.' }
    'SetOutPath "' + $target + '"'
    'File "/oname=' + [IO.Path]::GetFileName($file.Destination) + '" ' + (Quote-NsisPath $file.Source)
  }
  [IO.File]::WriteAllLines($manifest, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
  # Compile to staging so a failed compilation/signing cannot replace an older package.
  $compiled = Join-Path $staging 'portable.exe'
  $definitions = @(
    "/DOUTPUT_FILE=$compiled", "/DAPP_VERSION=$version",
    "/DAPP_ICON=$(Join-Path $projectRoot 'src-tauri\icons\icon.ico')", "/DPAYLOAD_MANIFEST=$manifest"
  )
  & $MakensisPath /V2 @definitions (Join-Path $PSScriptRoot 'portable-launcher.nsi')
  if ($LASTEXITCODE -ne 0) { throw "Portable compilation failed (NSIS exit $LASTEXITCODE)." }
  if (-not $SkipSign) { & "$PSScriptRoot\sign.ps1" -Paths @($compiled) }
  Copy-Item -LiteralPath $compiled -Destination $output -Force
  Write-Output "Portable package: $output"
} finally {
  $resolved = [IO.Path]::GetFullPath($staging)
  if (-not $resolved.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean staging outside the project temporary directory.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
