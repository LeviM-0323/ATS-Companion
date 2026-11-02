param(
  [string]$SdkArchive,
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$pluginDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeDirectory = Split-Path -Parent $pluginDirectory
$repositoryDirectory = Split-Path -Parent $bridgeDirectory
$outputDirectory = Join-Path $pluginDirectory 'build'
if (-not $OutputPath) {
  $OutputPath = Join-Path $outputDirectory 'ATSCompanionTelemetry.dll'
}

if (-not $SdkArchive) {
  $SdkArchive = Join-Path $env:TEMP 'ats-companion-scs-sdk-1.16.zip'
}
if (-not (Test-Path -LiteralPath $SdkArchive)) {
  Write-Host 'Downloading the official SCS Telemetry SDK 1.16...'
  Invoke-WebRequest -Uri 'https://download.eurotrucksimulator2.com/scs_sdk_1_16.zip' -OutFile $SdkArchive
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
  throw "The SCS SDK archive does not contain include\scssdk_telemetry.h: $SdkArchive"
}

$compiler = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $compiler) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
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

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$sourceFile = Join-Path $pluginDirectory 'ATSCompanionTelemetry.cpp'
$definitionFile = Join-Path $pluginDirectory 'ATSCompanionTelemetry.def'
$compileCommand = "cl.exe /nologo /std:c++17 /EHsc /O2 /LD /I `"$includeDirectory`" `"$sourceFile`" /link /DEF:`"$definitionFile`" /OUT:`"$OutputPath`""
if ($compiler) {
  & $compiler.Source /nologo /std:c++17 /EHsc /O2 /LD /I $includeDirectory $sourceFile /link "/DEF:$definitionFile" "/OUT:$OutputPath"
  if ($LASTEXITCODE -ne 0) {
    throw "SCS telemetry plugin build failed with exit code $LASTEXITCODE."
  }
}
else {
  $command = "call `"$developerCommand`" -arch=x64 -host_arch=x64 && $compileCommand"
  & $env:ComSpec /d /c $command
  if ($LASTEXITCODE -ne 0) {
    throw "SCS telemetry plugin build failed with exit code $LASTEXITCODE."
  }
}

if (-not (Test-Path -LiteralPath $OutputPath)) {
  throw "The compiler reported success but the plugin DLL was not created: $OutputPath"
}
Write-Host "Built ATS telemetry plugin: $OutputPath"
