# Compiles the read-only raw-input observer with the .NET Framework 4 compiler that ships with Windows.
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc (.NET Framework 4.x is required to build)" }
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'app\native\RawMouse.cs'
$out = Join-Path $root 'app\native\RawMouse.exe'
& $csc /nologo /optimize+ /target:exe /platform:anycpu /r:System.Windows.Forms.dll "/out:$out" $src
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
Write-Host "Built $out"
