param(
  [string]$SdkArchive,
  [string]$OutputPath,
  [ValidatePattern('^\d+\.\d+$')]
  [string]$CompilerToolset
)

$ErrorActionPreference = 'Stop'
$bridgeDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginDirectory = Join-Path $bridgeDirectory 'plugin'
$outputDirectory = Join-Path $pluginDirectory 'build'
$expectedSdkHash = '49821e25568f4d7e462135f577f8fef2ab197326404f2c1daef139b8f3dc5e69'
if (-not $OutputPath) {
  $OutputPath = Join-Path $outputDirectory 'ATSCompanionTelemetry.dll'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

if (-not $SdkArchive) {
  $SdkArchive = Join-Path $env:TEMP 'ats-companion-scs-sdk-1.16.zip'
}
if (-not (Test-Path -LiteralPath $SdkArchive)) {
  Write-Host 'Downloading the official SCS Telemetry SDK 1.16...'
  try {
    Invoke-WebRequest -Uri 'https://download.eurotrucksimulator2.com/scs_sdk_1_16.zip' -OutFile $SdkArchive
  }
  catch {
    throw "Failed to download the SCS Telemetry SDK 1.16: $($_.Exception.Message)"
  }
}

$actualSdkHash = (Get-FileHash -LiteralPath $SdkArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSdkHash -ne $expectedSdkHash) {
  throw "The SCS Telemetry SDK archive failed its SHA-256 check. Expected $expectedSdkHash, received $actualSdkHash."
}

$sdkDirectory = Join-Path $env:TEMP 'ats-companion-scs-sdk-1.16'
if (-not (Test-Path -LiteralPath (Join-Path $sdkDirectory 'include\scssdk_telemetry.h'))) {
  if (Test-Path -LiteralPath $sdkDirectory) {
    Remove-Item -LiteralPath $sdkDirectory -Recurse -Force
  }
  Expand-Archive -LiteralPath $SdkArchive -DestinationPath $sdkDirectory -Force
}
$includeDirectory = Join-Path $sdkDirectory 'include'
if (-not (Test-Path -LiteralPath (Join-Path $includeDirectory 'scssdk_telemetry.h'))) {
  throw "The verified SCS SDK archive does not contain include\scssdk_telemetry.h: $SdkArchive"
}

$sourceFile = Join-Path $pluginDirectory 'ATSCompanionTelemetry.cpp'
$definitionFile = Join-Path $pluginDirectory 'ATSCompanionTelemetry.def'
if (-not (Test-Path -LiteralPath $sourceFile)) {
  throw "The telemetry plugin source file is missing: $sourceFile"
}
if (-not (Test-Path -LiteralPath $definitionFile)) {
  throw "The telemetry plugin export definition is missing: $definitionFile"
}

$compiler = Get-Command cl.exe -ErrorAction SilentlyContinue
$useDeveloperCommand = $CompilerToolset -or -not $compiler
if ($useDeveloperCommand) {
  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'Visual Studio C++ Build Tools were not found. Install the Desktop development with C++ workload, then rerun this script.'
  }
  $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $installation) {
    throw 'Visual Studio C++ Build Tools were not found. Install the Desktop development with C++ workload, then rerun this script.'
  }
  $developerCommand = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $developerCommand)) {
    throw "Visual Studio developer command was not found: $developerCommand"
  }
}

$outputParent = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
$compileCommand = "cl.exe /nologo /std:c++17 /EHsc /O2 /LD /I `"$includeDirectory`" `"$sourceFile`" /link /DEF:`"$definitionFile`" /OUT:`"$OutputPath`""
if (-not $useDeveloperCommand) {
  & $compiler.Source /nologo /std:c++17 /EHsc /O2 /LD /I $includeDirectory $sourceFile /link "/DEF:$definitionFile" "/OUT:$OutputPath"
  if ($LASTEXITCODE -ne 0) {
    throw "SCS telemetry plugin build failed with exit code $LASTEXITCODE."
  }
}
else {
  $toolsetArgument = if ($CompilerToolset) { " -vcvars_ver=$CompilerToolset" } else { '' }
  $command = "call `"$developerCommand`" -arch=x64 -host_arch=x64$toolsetArgument && $compileCommand"
  & $env:ComSpec /d /c $command
  if ($LASTEXITCODE -ne 0) {
    throw "SCS telemetry plugin build failed with exit code $LASTEXITCODE."
  }
}

if (-not (Test-Path -LiteralPath $OutputPath) -or (Get-Item -LiteralPath $OutputPath).Length -eq 0) {
  throw "The compiler reported success but the plugin DLL was not created: $OutputPath"
}
Write-Host "Built ATS telemetry plugin: $OutputPath"
