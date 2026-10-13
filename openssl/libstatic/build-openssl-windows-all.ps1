<#
.SYNOPSIS
  One-shot rebuild of every Windows OpenSSL static library on a machine with Visual Studio 2022.

.DESCRIPTION
  Finds Visual Studio 2022 with vswhere, loads the compiler environment for x64, x86 and ARM64
  in turn, makes sure a native Windows Perl is available (installs Strawberry Perl with winget
  if there is none), and runs build-openssl-windows.ps1 for each platform. Optionally builds
  MeshAgent-2022.sln afterwards and checks that the produced executables embed the new OpenSSL
  version banner.

  Run it from any normal PowerShell window (no developer prompt needed):

    powershell -ExecutionPolicy Bypass -File openssl\libstatic\build-openssl-windows-all.ps1
    powershell -ExecutionPolicy Bypass -File openssl\libstatic\build-openssl-windows-all.ps1 -BuildAgent
    powershell -ExecutionPolicy Bypass -File openssl\libstatic\build-openssl-windows-all.ps1 -Platforms x64,x86

  ARM64 needs the "MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools" component; the script
  skips ARM64 with a warning if it is missing (the x64-hosted cross compiler is used, so no
  ARM64 machine is required).

.PARAMETER Version
  OpenSSL version to build (default 3.5.9).
.PARAMETER Platforms
  Which of x64, x86, ARM64 to build (default: all three).
.PARAMETER BuildAgent
  After the libraries, build MeshAgent-2022.sln (Release) for each platform and verify the
  executables contain "OpenSSL <Version>".
.PARAMETER Tarball
  Already downloaded openssl-<Version>.tar.gz; downloaded once into %TEMP% otherwise.
#>
[CmdletBinding()]
param(
	[string]$Version = '3.5.9',
	[ValidateSet('x64', 'x86', 'ARM64')][string[]]$Platforms = @('x64', 'x86', 'ARM64'),
	[switch]$BuildAgent,
	[string]$Tarball
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = (Resolve-Path (Join-Path $Here '..\..')).Path
$Inner = Join-Path $Here 'build-openssl-windows.ps1'
if (-not (Test-Path $Inner)) { throw "missing $Inner" }

# ---------------------------------------------------------------- Visual Studio 2022
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found; is Visual Studio 2022 installed?" }
$vsPath = & $vswhere -latest -products * -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "No Visual Studio 2022 with the C++ x86/x64 build tools was found" }
$vcvarsall = Join-Path $vsPath 'VC\Auxiliary\Build\vcvarsall.bat'
if (-not (Test-Path $vcvarsall)) { throw "vcvarsall.bat not found under $vsPath" }
Write-Host "Using Visual Studio at $vsPath"

$msvcDir = Get-ChildItem (Join-Path $vsPath 'VC\Tools\MSVC') | Sort-Object Name -Descending | Select-Object -First 1
$hasArm64 = Test-Path (Join-Path $msvcDir.FullName 'bin\Hostx64\arm64\cl.exe')

# vcvarsall architecture argument per platform (x64-hosted toolchains).
$vcArch = @{ x64 = 'x64'; x86 = 'x64_x86'; ARM64 = 'x64_arm64' }

function Save-Environment {
	$snap = @{}
	Get-ChildItem Env: | ForEach-Object { $snap[$_.Name] = $_.Value }
	return $snap
}
function Restore-Environment([hashtable]$snap) {
	Get-ChildItem Env: | Where-Object { -not $snap.ContainsKey($_.Name) } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
	foreach ($k in $snap.Keys) { if ($snap[$k] -ne '') { Set-Item "Env:$k" $snap[$k] } }
}
function Import-VcVars([string]$arch) {
	$lines = cmd /c "`"$vcvarsall`" $arch >nul 2>&1 && set"
	if ($LASTEXITCODE -ne 0) { throw "vcvarsall.bat $arch failed" }
	foreach ($line in $lines) {
		if ($line -match '^([^=]+)=(.+)$') { Set-Item "Env:$($matches[1])" $matches[2] }
	}
}

# ---------------------------------------------------------------- native Perl
function Test-NativePerl {
	$p = Get-Command perl -ErrorAction SilentlyContinue
	if (-not $p) { return $false }
	return ((& perl -e 'print $^O') -eq 'MSWin32')   # Git's msys perl reports "msys" and cannot build VC targets
}
function Ensure-Perl {
	$strawberry = 'C:\Strawberry\perl\bin'
	if (Test-Path (Join-Path $strawberry 'perl.exe')) { $env:PATH = "$strawberry;$env:PATH" }
	if (Test-NativePerl) { Write-Host "Using Perl: $((Get-Command perl).Source)"; return }
	if (Get-Command winget -ErrorAction SilentlyContinue) {
		Write-Host "No native Windows Perl found; installing Strawberry Perl with winget"
		& winget install --id StrawberryPerl.StrawberryPerl -e --accept-package-agreements --accept-source-agreements
		if (Test-Path (Join-Path $strawberry 'perl.exe')) { $env:PATH = "$strawberry;$env:PATH" }
	}
	if (-not (Test-NativePerl)) { throw "A native Windows Perl is required (https://strawberryperl.com). Install it and re-run." }
	Write-Host "Using Perl: $((Get-Command perl).Source)"
}

# ---------------------------------------------------------------- tarball (downloaded once)
if (-not $Tarball) {
	$Tarball = Join-Path $env:TEMP "openssl-$Version.tar.gz"
	if (-not (Test-Path $Tarball)) {
		Write-Host "Downloading openssl-$Version.tar.gz to $Tarball"
		Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/openssl/openssl/releases/download/openssl-$Version/openssl-$Version.tar.gz" -OutFile $Tarball
	}
}
# build-openssl-windows.ps1 verifies the SHA256 against the published checksum on every run.

# ---------------------------------------------------------------- build libraries
$results = [ordered]@{}
$baseEnv = Save-Environment
foreach ($p in $Platforms) {
	if ($p -eq 'ARM64' -and -not $hasArm64) {
		Write-Warning "ARM64 build tools are not installed (VS Installer: 'MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools'); skipping ARM64"
		$results[$p] = 'skipped (no ARM64 toolchain)'
		continue
	}
	Write-Host ""
	Write-Host "=================== OpenSSL $Version for $p ==================="
	try {
		Import-VcVars $vcArch[$p]
		Ensure-Perl
		& $Inner -Platform $p -Version $Version -Tarball $Tarball
		$results[$p] = 'built'
	} catch {
		Write-Warning "$p failed: $_"
		$results[$p] = "FAILED: $_"
	} finally {
		Restore-Environment $baseEnv
	}
}

# ---------------------------------------------------------------- optional agent build + check
if ($BuildAgent) {
	$sln = Join-Path $Repo 'MeshAgent-2022.sln'
	foreach ($p in $Platforms) {
		if ($results[$p] -ne 'built') { continue }
		Write-Host ""
		Write-Host "=================== MeshAgent Release|$p ==================="
		try {
			Import-VcVars $vcArch[$p]
			$started = Get-Date
			& msbuild $sln /m /p:Configuration=Release "/p:Platform=$p"
			if ($LASTEXITCODE -ne 0) { throw "msbuild failed" }
			$exes = Get-ChildItem (Join-Path $Repo 'Release\*.exe') | Where-Object { $_.LastWriteTime -ge $started }
			if (-not $exes) { throw "no executable was produced in Release\" }
			foreach ($exe in $exes) {
				if (Select-String -Path $exe.FullName -Pattern "OpenSSL $Version" -Quiet) {
					Write-Host "$($exe.Name): OpenSSL $Version"
				} else { throw "$($exe.Name) does not contain the 'OpenSSL $Version' banner" }
			}
			$results[$p] = 'built, agent verified'
		} catch {
			Write-Warning "$p agent build failed: $_"
			$results[$p] = "built, agent FAILED: $_"
		} finally {
			Restore-Environment $baseEnv
		}
	}
}

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "Summary (OpenSSL $Version):"
$failed = $false
foreach ($k in $results.Keys) {
	Write-Host ("  {0,-6} {1}" -f $k, $results[$k])
	if ($results[$k] -like '*FAILED*') { $failed = $true }
}
Write-Host ""
Write-Host "Libraries are in $Here (libcrypto*.lib / libssl*.lib). Commit them together with the headers."
foreach ($f in Get-ChildItem (Join-Path $Here '*.lib')) {
	$banner = if (Select-String -Path $f.FullName -Pattern "OpenSSL $Version" -Quiet) { "OpenSSL $Version" } else { "OLD VERSION" }
	Write-Host ("  {0,-24} {1}" -f $f.Name, $banner)
}
if ($failed) { exit 1 }
