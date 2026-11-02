param(
  [string]$GameDirectory,
  [string]$PluginDll,
  [string]$SteamPath,
  [switch]$BuildFromSource
)

$ErrorActionPreference = 'Stop'
$pluginDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$releaseAssetUri = 'https://github.com/LeviM-0323/ATS-Companion/releases/latest/download/ATSCompanionTelemetry.dll'
$temporaryDll = $null

function Get-SteamLibraryRoots {
  $roots = @()
  $detectedSteamPath = $SteamPath
  if (-not $detectedSteamPath) {
    try {
      $detectedSteamPath = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath
    }
    catch {
      Write-Host "Steam installation could not be detected automatically: $($_.Exception.Message)"
    }
  }

  if ($detectedSteamPath) {
    $roots += $detectedSteamPath
    $libraryFile = Join-Path $detectedSteamPath 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $libraryFile -PathType Leaf) {
      try {
        $libraryText = Get-Content -LiteralPath $libraryFile -Raw -ErrorAction Stop
        $roots += [regex]::Matches($libraryText, '"path"\s+"((?:\\.|[^"])*)"') | ForEach-Object {
          $_.Groups[1].Value.Replace('\\', '\')
        }
      }
      catch {
        Write-Host "Steam library folders could not be read: $($_.Exception.Message)"
      }
    }
  }

  return @($roots | Where-Object { $_ } | Select-Object -Unique)
}

function Find-AtsGameDirectories {
  $roots = Get-SteamLibraryRoots
  return @(
    $roots |
      ForEach-Object { Join-Path $_ 'steamapps\common\American Truck Simulator' } |
      Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\win_x64') -PathType Container } |
      Select-Object -Unique
  )
}

function Get-PluginDll {
  if ($BuildFromSource) {
    if ($PluginDll) {
      throw 'Choose either -PluginDll or -BuildFromSource, not both.'
    }
    $buildOutput = Join-Path ([System.IO.Path]::GetTempPath()) "ATSCompanionTelemetry-$([guid]::NewGuid().ToString('N')).dll"
    & (Join-Path $pluginDirectory 'build-plugin.ps1') -OutputPath $buildOutput
    if (-not (Test-Path -LiteralPath $buildOutput -PathType Leaf)) {
      throw 'The source build completed without producing the telemetry plugin DLL.'
    }
    $script:temporaryDll = $buildOutput
    return $buildOutput
  }

  if ($PluginDll) {
    return $PluginDll
  }

  foreach ($candidate in @(
      (Join-Path $pluginDirectory 'ATSCompanionTelemetry.dll'),
      (Join-Path $pluginDirectory 'build\ATSCompanionTelemetry.dll')
    )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }

  $downloadPath = Join-Path ([System.IO.Path]::GetTempPath()) "ATSCompanionTelemetry-$([guid]::NewGuid().ToString('N')).dll"
  try {
    Invoke-WebRequest -Uri $releaseAssetUri -OutFile $downloadPath -ErrorAction Stop
  }
  catch {
    Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    throw "Could not download the prebuilt telemetry plugin from the latest GitHub Release. Download ATSCompanionTelemetry.dll manually and retry with -PluginDll <path>. Details: $($_.Exception.Message)"
  }

  if (-not (Test-Path -LiteralPath $downloadPath -PathType Leaf) -or (Get-Item -LiteralPath $downloadPath).Length -eq 0) {
    Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    throw 'The latest GitHub Release did not provide a non-empty ATSCompanionTelemetry.dll asset.'
  }
  $script:temporaryDll = $downloadPath
  return $downloadPath
}

try {
  $sourceDll = Get-PluginDll
  if (-not (Test-Path -LiteralPath $sourceDll -PathType Leaf)) {
    throw "The telemetry plugin DLL was not found: $sourceDll"
  }
  $sourceDll = (Resolve-Path -LiteralPath $sourceDll).Path
  if ((Get-Item -LiteralPath $sourceDll).Length -eq 0) {
    throw "The telemetry plugin DLL is empty: $sourceDll"
  }

  if (-not $GameDirectory) {
    $detectedGames = @(Find-AtsGameDirectories)
    if ($detectedGames.Count -eq 1) {
      $GameDirectory = $detectedGames[0]
      Write-Host "Detected American Truck Simulator at: $GameDirectory"
    }
    elseif ($detectedGames.Count -gt 1) {
      Write-Host 'Multiple American Truck Simulator installations were found:'
      for ($index = 0; $index -lt $detectedGames.Count; $index++) {
        Write-Host "  $($index + 1). $($detectedGames[$index])"
      }
      $selection = Read-Host 'Enter an installation number, or press Enter to choose a folder manually'
      if ($selection) {
        $selectedIndex = 0
        if (-not [int]::TryParse($selection, [ref]$selectedIndex) -or $selectedIndex -lt 1 -or $selectedIndex -gt $detectedGames.Count) {
          throw "Invalid ATS installation selection: $selection"
        }
        $GameDirectory = $detectedGames[$selectedIndex - 1]
      }
    }
    else {
      Write-Host 'American Truck Simulator was not detected in the Steam libraries.'
    }
  }

  if (-not $GameDirectory) {
    $GameDirectory = Read-Host 'Enter the American Truck Simulator installation directory'
  }
  if (-not $GameDirectory -or -not (Test-Path -LiteralPath $GameDirectory -PathType Container)) {
    throw "The selected ATS installation directory does not exist: $GameDirectory"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $GameDirectory 'bin\win_x64') -PathType Container)) {
    throw "ATS x64 game binaries were not found under: $GameDirectory"
  }

  $destinationDirectory = Join-Path $GameDirectory 'bin\win_x64\plugins'
  $destinationDll = Join-Path $destinationDirectory 'ATSCompanionTelemetry.dll'
  $stagedDll = Join-Path $destinationDirectory "ATSCompanionTelemetry-$([guid]::NewGuid().ToString('N')).tmp"
  try {
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath $sourceDll -Destination $stagedDll -ErrorAction Stop
    Move-Item -LiteralPath $stagedDll -Destination $destinationDll -Force -ErrorAction Stop
  }
  catch {
    Remove-Item -LiteralPath $stagedDll -Force -ErrorAction SilentlyContinue
    throw "Failed to install the ATS telemetry plugin to '$destinationDll'. Check that the game directory is writable and ATS is closed. Details: $($_.Exception.Message)"
  }

  Write-Host "Installed the ATS Companion telemetry plugin to $destinationDll"
  Write-Host 'Restart ATS and keep the Windows bridge running to stream telemetry.'
}
finally {
  if ($temporaryDll) {
    Remove-Item -LiteralPath $temporaryDll -Force -ErrorAction SilentlyContinue
  }
}
