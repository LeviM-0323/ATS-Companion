param(
  [string]$GameDirectory
)

$ErrorActionPreference = 'Stop'
$pluginDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeDirectory = Split-Path -Parent $pluginDirectory
$outputDll = Join-Path $pluginDirectory 'build\ATSCompanionTelemetry.dll'
& (Join-Path $pluginDirectory 'build-plugin.ps1') -OutputPath $outputDll

if (-not $GameDirectory) {
  $steamPath = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
  $libraryRoots = @()
  if ($steamPath) {
    $libraryRoots += $steamPath
    $libraryFile = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $libraryFile) {
      $libraryText = Get-Content -LiteralPath $libraryFile -Raw
      $libraryRoots += [regex]::Matches($libraryText, '"path"\s+"([^"]+)"') | ForEach-Object {
        $_.Groups[1].Value.Replace('\\', '\')
      }
    }
  }
  $GameDirectory = $libraryRoots |
    ForEach-Object { Join-Path $_ 'steamapps\common\American Truck Simulator' } |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\win_x64') } |
    Select-Object -First 1
}

if (-not $GameDirectory) {
  $GameDirectory = Read-Host 'Enter the American Truck Simulator installation directory'
}
if (-not (Test-Path -LiteralPath (Join-Path $GameDirectory 'bin\win_x64'))) {
  throw "ATS x64 game binaries were not found under: $GameDirectory"
}

$destination = Join-Path $GameDirectory 'bin\win_x64\plugins'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath $outputDll -Destination (Join-Path $destination 'ATSCompanionTelemetry.dll') -Force
Write-Host "Installed the ATS Companion telemetry plugin to $destination"
Write-Host 'Restart ATS and keep the Windows bridge running to stream telemetry.'
