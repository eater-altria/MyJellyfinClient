# Validate bundled runtime files before starting Vite, Cargo or signing.
param(
  [string]$ResourceRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\resources')
)

$ErrorActionPreference = 'Stop'
$requiredFiles = @(
  'mpv\mpv.exe',
  'mpv\mpv.com',
  'mpv\portable_config\scripts\mjc-osc.lua',
  'mpv\portable_config\shaders\mjc-glass.glsl',
  'WebView2Loader.dll'
)
$mpvDlls = @(Get-ChildItem -LiteralPath (Join-Path $ResourceRoot 'mpv') -Filter '*.dll' -File -ErrorAction SilentlyContinue)
$requiredFiles += $mpvDlls | ForEach-Object { 'mpv\' + $_.Name }
$missing = @($requiredFiles | Where-Object {
  $path = Join-Path $ResourceRoot $_
  -not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0
})
if ($mpvDlls.Count -eq 0) { $missing += 'mpv\*.dll' }

if ($missing.Count -gt 0) {
  throw (@(
    'Required runtime files are missing or empty:',
    ($missing | ForEach-Object { '  ' + (Join-Path $ResourceRoot $_) }),
    'For missing mpv binaries, run ./scripts/ensure-mpv.ps1 to download them automatically.',
    'mpv binaries are not stored in Git. See README.md for the shinchiro x86_64 download.',
    'Copy mpv.exe, mpv.com and all DLLs from the same build into src-tauri/resources/mpv/.',
    'You can also copy these binaries from a trusted MyJellyfinClient installation.',
    'Keep the repository portable_config scripts and shaders; do not replace or delete them.',
    'Restore missing tracked files from the repository, then run the command again.'
  ) -join [Environment]::NewLine)
}
