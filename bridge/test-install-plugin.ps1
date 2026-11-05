$ErrorActionPreference = 'Stop'

$pluginDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$installerPath = Join-Path $pluginDirectory 'setup-plugin.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ats-companion-plugin-test-$([guid]::NewGuid().ToString('N'))"
$pluginDll = Join-Path $testRoot 'source\ATSCompanionTelemetry.dll'
$env:ATS_COMPANION_INSTALL_TEST_PATH = ''

function Assert-Equal {
  param(
    [string]$Expected,
    [string]$Actual,
    [string]$Message
  )

  if ($Expected -cne $Actual) {
    throw "$Message Expected '$Expected', received '$Actual'."
  }
}

function New-TestGameDirectory {
  param([string]$Path)

  New-Item -ItemType Directory -Force -Path (Join-Path $Path 'bin\win_x64') | Out-Null
  return $Path
}

function Invoke-Installer {
  param([hashtable]$Arguments)

  try {
    & $installerPath @Arguments | Out-Null
    return $null
  }
  catch {
    return $_.Exception.Message
  }
}

function Read-Host {
  param([string]$Prompt)

  return $env:ATS_COMPANION_INSTALL_TEST_PATH
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pluginDll) | Out-Null
[System.IO.File]::WriteAllText($pluginDll, 'initial plugin')

try {
  $manualGame = New-TestGameDirectory (Join-Path $testRoot 'manual-game')
  $errorMessage = Invoke-Installer @{
    GameDirectory = $manualGame
    PluginDll = $pluginDll
  }
  Assert-Equal '' "$errorMessage" 'Manual installation should succeed.'
  $installedDll = Join-Path $manualGame 'bin\win_x64\plugins\ATSCompanionTelemetry.dll'
  Assert-Equal 'initial plugin' ([System.IO.File]::ReadAllText($installedDll)) 'Manual installation should copy the supplied plugin.'

  [System.IO.File]::WriteAllText($pluginDll, 'updated plugin')
  $errorMessage = Invoke-Installer @{
    GameDirectory = $manualGame
    PluginDll = $pluginDll
  }
  Assert-Equal '' "$errorMessage" 'Repeated installation should succeed.'
  Assert-Equal 'updated plugin' ([System.IO.File]::ReadAllText($installedDll)) 'Repeated installation should replace the previous plugin.'

  $steamRoot = Join-Path $testRoot 'steam'
  $libraryRoot = Join-Path $testRoot 'secondary-library'
  $detectedGame = New-TestGameDirectory (Join-Path $libraryRoot 'steamapps\common\American Truck Simulator')
  New-Item -ItemType Directory -Force -Path (Join-Path $steamRoot 'steamapps') | Out-Null
  $escapedLibraryRoot = $libraryRoot.Replace('\', '\\')
  Set-Content -LiteralPath (Join-Path $steamRoot 'steamapps\libraryfolders.vdf') -Value @"
"libraryfolders"
{
  "0" { "path" "$escapedLibraryRoot" }
}
"@
  $errorMessage = Invoke-Installer @{
    SteamPath = $steamRoot
    PluginDll = $pluginDll
  }
  Assert-Equal '' "$errorMessage" 'Steam library detection should install into a secondary library.'
  $detectedDll = Join-Path $detectedGame 'bin\win_x64\plugins\ATSCompanionTelemetry.dll'
  Assert-Equal 'updated plugin' ([System.IO.File]::ReadAllText($detectedDll)) 'Steam detection should select the ATS installation in the library file.'

  $alternateGame = New-TestGameDirectory (Join-Path $testRoot 'alternate-game')
  $env:ATS_COMPANION_INSTALL_TEST_PATH = $alternateGame
  $errorMessage = Invoke-Installer @{
    SteamPath = $steamRoot
    PluginDll = $pluginDll
  }
  Assert-Equal '' "$errorMessage" 'The installer should accept another folder when Steam finds one installation.'
  $alternateDll = Join-Path $alternateGame 'bin\win_x64\plugins\ATSCompanionTelemetry.dll'
  Assert-Equal 'updated plugin' ([System.IO.File]::ReadAllText($alternateDll)) 'Manual selection should override the detected Steam installation.'

  $env:ATS_COMPANION_INSTALL_TEST_PATH = ''
  $env:ATS_COMPANION_INSTALL_TEST_PATH = New-TestGameDirectory (Join-Path $testRoot 'prompt-game')
  $errorMessage = Invoke-Installer @{
    SteamPath = (Join-Path $testRoot 'empty-steam')
    PluginDll = $pluginDll
  }
  Assert-Equal '' "$errorMessage" 'The installer should accept a manually entered path when Steam detection fails.'
  $promptDll = Join-Path $env:ATS_COMPANION_INSTALL_TEST_PATH 'bin\win_x64\plugins\ATSCompanionTelemetry.dll'
  Assert-Equal 'updated plugin' ([System.IO.File]::ReadAllText($promptDll)) 'Manual fallback should install into the entered ATS directory.'

  $invalidGame = Join-Path $testRoot 'not-a-game'
  New-Item -ItemType Directory -Force -Path $invalidGame | Out-Null
  $errorMessage = Invoke-Installer @{
    GameDirectory = $invalidGame
    PluginDll = $pluginDll
  }
  if ($errorMessage -notmatch 'ATS x64 game binaries were not found') {
    throw "Invalid ATS paths should fail with a clear validation error. Received '$errorMessage'."
  }

  $blockedGame = New-TestGameDirectory (Join-Path $testRoot 'copy-failure')
  Set-Content -LiteralPath (Join-Path $blockedGame 'bin\win_x64\plugins') -Value 'not a directory'
  $errorMessage = Invoke-Installer @{
    GameDirectory = $blockedGame
    PluginDll = $pluginDll
  }
  if ($errorMessage -notmatch 'Failed to install the ATS telemetry plugin') {
    throw "Copy failures should be reported explicitly. Received '$errorMessage'."
  }

  Write-Host 'Windows plugin installer behavior tests passed.'
}
finally {
  Remove-Item Env:\ATS_COMPANION_INSTALL_TEST_PATH -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
