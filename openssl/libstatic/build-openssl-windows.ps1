<#
.SYNOPSIS
  Builds the static OpenSSL libraries used by the Windows projects (openssl/libstatic/*.lib).

.DESCRIPTION
  Run from a Visual Studio "Native Tools" developer prompt (or after vcvarsall) whose target
  architecture matches -Platform. Perl must be on PATH (Strawberry Perl is fine); NASM is not
  needed because the libraries are built with no-asm, like the previous 1.1.1 ones.

  Builds a release (/MT) and a debug (/MTd) variant and copies them over
    x64   -> libcrypto64MT.lib  libssl64MT.lib  libcrypto64MTd.lib  libssl64MTd.lib
    x86   -> libcrypto32MT.lib  libssl32MT.lib  libcrypto32MTd.lib  libssl32MTd.lib
    ARM64 -> libcryptoARM64.lib libsslARM64.lib libcryptoARM64d.lib libsslARM64d.lib

  The tarball is verified against the .sha256 published on the OpenSSL GitHub release page.

.EXAMPLE
  pwsh openssl/libstatic/build-openssl-windows.ps1 -Platform x64
  pwsh openssl/libstatic/build-openssl-windows.ps1 -Platform ARM64 -Version 3.5.9
#>
param(
	[Parameter(Mandatory = $true)][ValidateSet('x64', 'x86', 'ARM64')][string]$Platform,
	[string]$Version = '3.5.9',
	[string]$Tarball = $env:OPENSSL_TARBALL
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the 5.1 progress bar makes downloads very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($tool in 'cl', 'nmake', 'perl') {
	if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found on PATH; run from a VS developer prompt with Perl installed" }
}

# Keep in sync with COMMON_OPTS in build-openssl-static.sh / macos/build-openssl-macos.sh.
$CommonOpts = @('no-shared', 'no-module', 'no-dso', 'no-weak-ssl-ciphers', 'no-srp', 'no-psk', 'no-comp',
	'no-zlib', 'no-zlib-dynamic', 'no-err', 'no-rc5', 'no-idea', 'no-md4', 'no-rmd160', 'no-seed',
	'no-camellia', 'no-bf', 'no-cast', 'no-md2', 'no-mdc2', 'no-tests', 'no-apps', 'no-docs', 'no-asm',
	'--api=1.1.0')

switch ($Platform) {
	'x64'   { $Target = 'VC-WIN64A';   $Suffix = '64MT';  $DebugSuffix = '64MTd' }
	'x86'   { $Target = 'VC-WIN32';    $Suffix = '32MT';  $DebugSuffix = '32MTd' }
	'ARM64' { $Target = 'VC-WIN64-ARM'; $Suffix = 'ARM64'; $DebugSuffix = 'ARM64d' }
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("openssl-build-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $Work | Out-Null
try {
	$BaseUrl = "https://github.com/openssl/openssl/releases/download/openssl-$Version"
	if (-not $Tarball) {
		$Tarball = Join-Path $Work "openssl-$Version.tar.gz"
		Write-Host "Downloading openssl-$Version.tar.gz"
		Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/openssl-$Version.tar.gz" -OutFile $Tarball
	}
	# Download the checksum to a file: Windows PowerShell 5.1 returns binary content as a byte
	# array for this file's MIME type, so .Content cannot be used as a string.
	$ShaFile = Join-Path $Work 'expected.sha256'
	Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/openssl-$Version.tar.gz.sha256" -OutFile $ShaFile
	$Expected = ((Get-Content $ShaFile -Raw).Trim() -split '\s+')[0].ToLower()
	$Actual = (Get-FileHash -Algorithm SHA256 $Tarball).Hash.ToLower()
	if ($Expected -ne $Actual) { throw "SHA256 mismatch for ${Tarball}: expected $Expected, actual $Actual" }
	Write-Host "Verified openssl-$Version.tar.gz ($Actual)"

	$Vendored = Join-Path $Here '..\include\openssl\configuration.h'

	foreach ($variant in @(@{ Name = 'release'; Extra = @();          Suffix = $Suffix },
	                        @{ Name = 'debug';   Extra = @('--debug'); Suffix = $DebugSuffix })) {
		$Src = Join-Path $Work $variant.Name
		New-Item -ItemType Directory -Path $Src | Out-Null
		tar -xzf $Tarball -C $Src --strip-components=1
		if ($LASTEXITCODE -ne 0) { throw "tar failed" }
		Push-Location $Src
		try {
			Write-Host "==> Configuring $Platform $($variant.Name) ($Target)"
			$configureArgs = @($Target) + $CommonOpts + @($variant.Extra)
			& perl Configure @configureArgs
			if ($LASTEXITCODE -ne 0) { throw "Configure failed" }
			Write-Host "==> Building $Platform $($variant.Name)"
			& nmake build_libs
			if ($LASTEXITCODE -ne 0) { throw "nmake failed" }

			# The vendored headers come from the macOS build; the feature set must match.
			if (Test-Path $Vendored) {
				# Ignored: no-asm, and the engines/loaders OpenSSL enables per OS (Windows cert store,
				# Linux AF_ALG, BSD /dev/crypto); none of them affect the public headers.
				$filter = { $_ -match '^#\s*define OPENSSL_NO_' -and $_ -notmatch 'OPENSSL_NO_(ASM|WINSTORE|AFALGENG|DEVCRYPTOENG)\b' }
				$built = Get-Content 'include\openssl\configuration.h' | Where-Object $filter | ForEach-Object { $_ -replace '\s+', ' ' } | Sort-Object
				$vend  = Get-Content $Vendored | Where-Object $filter | ForEach-Object { $_ -replace '\s+', ' ' } | Sort-Object
				$diff = Compare-Object $vend $built
				if ($diff) { $diff | Format-Table | Out-String | Write-Host; throw "OPENSSL_NO_* feature set differs from the vendored configuration.h" }
			}

			# Static VC builds must carry the static CRT: LIBCMT for /MT, LIBCMTD for /MTd.
			$directives = (& dumpbin /directives libcrypto.lib) -join "`n"
			$hasMT  = $directives -match 'DEFAULTLIB:"?LIBCMT"?(\s|$)'
			$hasMTd = $directives -match 'DEFAULTLIB:"?LIBCMTD"?'
			if ($variant.Name -eq 'debug' -and -not $hasMTd) { throw "libcrypto.lib is not built with /MTd (no LIBCMTD directive)" }
			if ($variant.Name -eq 'release' -and (-not $hasMT -or $hasMTd)) { throw "libcrypto.lib is not built with /MT (expected LIBCMT, not LIBCMTD)" }

			Copy-Item libcrypto.lib (Join-Path $Here "libcrypto$($variant.Suffix).lib") -Force
			Copy-Item libssl.lib    (Join-Path $Here "libssl$($variant.Suffix).lib")    -Force
			Write-Host "==> Installed libcrypto$($variant.Suffix).lib and libssl$($variant.Suffix).lib"
		} finally { Pop-Location }
	}
	Write-Host "Done."
} finally {
	Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
