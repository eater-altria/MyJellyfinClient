# Windows PowerShell 5.1 integration test with a synthetic x64 executable.
# No browser profiles or media-server credentials are read.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tmp'))
$testRoot = Join-Path $temporaryRoot ('portable-test-' + [Guid]::NewGuid().ToString('N'))
if (-not $testRoot.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Invalid portable test path.'
}
[void](New-Item -ItemType Directory -Path $testRoot -Force)
$previousData = $env:MJC_WEBVIEW_DATA
try {
  $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
  $application = Join-Path $testRoot 'my-jellyfin-client.exe'
  $source = @"
using System;
using System.IO;
using System.Reflection;
[assembly: AssemblyFileVersion("$version.0")]
public class PortableFixture {
    public static int Main() {
        string data = Environment.GetEnvironmentVariable("MJC_WEBVIEW_DATA");
        string app = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string[] required = {"mpv/mpv.exe", "mpv/mpv.com", "mpv/fixture.dll",
            "mpv/portable_config/scripts/mjc-osc.lua", "mpv/portable_config/shaders/mjc-glass.glsl", "WebView2Loader.dll"};
        foreach (string relative in required) {
            if (!File.Exists(Path.Combine(app, relative))) return 5;
        }
        if (Directory.Exists(Path.Combine(app, "mpv/portable_config/cache"))) return 6;
        File.WriteAllText(Path.Combine(data, "runtime-path.txt"), app);
        File.AppendAllText(Path.Combine(data, "launches.txt"), "launched\n");
        return 23;
    }
}
"@
  $sourcePath = Join-Path $testRoot 'fixture.cs'
  [IO.File]::WriteAllText($sourcePath, $source)
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  & $compiler /nologo /target:exe /platform:x64 "/out:$application" $sourcePath
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic x64 fixture compilation failed.' }
  $resources = Join-Path $testRoot 'resources'
  foreach ($relative in @('mpv/mpv.com', 'mpv/fixture.dll', 'mpv/portable_config/scripts/mjc-osc.lua',
    'mpv/portable_config/shaders/mjc-glass.glsl', 'mpv/portable_config/cache/private-cache', 'WebView2Loader.dll')) {
    $file = Join-Path $resources $relative
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force)
    [IO.File]::WriteAllText($file, 'synthetic fixture')
  }
  $pe = New-Object byte[] 128
  $pe[0] = 0x4d; $pe[1] = 0x5a; $pe[0x3c] = 0x40
  $pe[0x40] = 0x50; $pe[0x41] = 0x45; $pe[0x44] = 0x64; $pe[0x45] = 0x86
  [IO.File]::WriteAllBytes((Join-Path $resources 'mpv/mpv.exe'), $pe)
  # Use a Unicode path without embedding non-ASCII source in this .ps1.
  $folderName = 'portable space ' + [char]0x4e2d + [char]0x6587
  $output = Join-Path $testRoot $folderName
  $arguments = @{ ApplicationPath = $application; ResourceRoot = $resources; OutputDirectory = $output; SkipSign = $true }
  & "$PSScriptRoot\build-portable.ps1" @arguments
  $package = Join-Path $output "MyJellyfinClient_${version}_x64-portable.exe"
  $data = Join-Path $output 'MyJellyfinClient-data'
  [void](New-Item -ItemType Directory -Path $data -Force)
  [IO.File]::WriteAllText((Join-Path $data 'settings-fixture.txt'), 'keep existing synthetic settings')
  $env:MJC_WEBVIEW_DATA = Join-Path $testRoot 'unrelated-data'
  for ($launch = 0; $launch -lt 2; $launch++) {
    $process = Start-Process -FilePath $package -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(30000)) {
      Stop-Process -Id $process.Id -Force
      throw 'Portable fixture timed out.'
    }
    if ($process.ExitCode -ne 23) { throw "Child exit code was not forwarded: $($process.ExitCode)" }
    $runtime = [IO.File]::ReadAllText((Join-Path $data 'runtime-path.txt'))
    if (Test-Path -LiteralPath $runtime) { throw 'Temporary runtime was not removed after application exit.' }
  }
  if (@([IO.File]::ReadAllLines((Join-Path $data 'launches.txt'))).Count -ne 2) { throw 'Portable data was not reused.' }
  if ([IO.File]::ReadAllText((Join-Path $data 'settings-fixture.txt')) -ne 'keep existing synthetic settings') {
    throw 'An existing portable data file was modified.'
  }
  if (Test-Path -LiteralPath $env:MJC_WEBVIEW_DATA) { throw 'Launcher used the inherited development data directory.' }
  if (@(Get-ChildItem -LiteralPath $output -File).Count -ne 1) { throw 'Portable distribution contains more than one executable file.' }

  $hash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash
  $shader = Join-Path $resources 'mpv/portable_config/shaders/mjc-glass.glsl'
  Remove-Item -LiteralPath $shader
  $failed = $false
  try { & "$PSScriptRoot\build-portable.ps1" @arguments } catch {
    if ($_.Exception.Message -notmatch 'Required runtime files') { throw }
    $failed = $true
  }
  if (-not $failed -or (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $hash) {
    throw 'A missing runtime replaced the existing portable package.'
  }
  [IO.File]::WriteAllText($shader, 'synthetic fixture')
  $pe[0x44] = 0x4c; $pe[0x45] = 0x01
  [IO.File]::WriteAllBytes((Join-Path $resources 'mpv/mpv.exe'), $pe)
  $failed = $false
  try { & "$PSScriptRoot\build-portable.ps1" @arguments } catch {
    if ($_.Exception.Message -notmatch 'Not a Windows x64') { throw }
    $failed = $true
  }
  if (-not $failed) { throw 'Portable packager accepted a non-x64 player.' }
  if (@(Get-ChildItem -LiteralPath $temporaryRoot -Filter 'portable-build-*' -Directory).Count -ne 0) {
    throw 'Portable build left staging files behind.'
  }
  Write-Output 'PASS: single EXE, x64 payload, complete resources, Unicode/spaces, exit code, persistent sibling data, cache exclusion, runtime/staging cleanup and failed build preservation.'
} finally {
  if ($null -eq $previousData) { Remove-Item Env:\MJC_WEBVIEW_DATA -ErrorAction SilentlyContinue }
  else { $env:MJC_WEBVIEW_DATA = $previousData }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  if (-not $resolved.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to remove a portable test directory outside the workspace temporary root.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
