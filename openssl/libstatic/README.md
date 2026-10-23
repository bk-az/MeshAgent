# Prebuilt OpenSSL static libraries

Every file here must come from the same OpenSSL version as the headers in
`../include/openssl` (currently 3.5.9). The full guide, including Windows step by step, is in
[../BUILDING.md](../BUILDING.md).

| Platform | Command | Output |
|---|---|---|
| Windows x64, x86, ARM64 | `powershell -ExecutionPolicy Bypass -File openssl\libstatic\build-openssl-windows-all.ps1 -BuildAgent` (any PowerShell window on a machine with Visual Studio 2022) | `*.lib` in this directory |
| macOS | `./openssl/libstatic/macos/build-openssl-macos.sh 3.5.9 --refresh-headers` | `macos/osx-*/` and the vendored headers |
| Linux | `./openssl/libstatic/build-openssl-static.sh <arch>` run on that platform | `linux/<arch>/` |
| FreeBSD / OpenBSD | not supported for now: `bsd/<arch>/` is still the 1.1.1s build and does not link against the 3.5.9 headers; rebuild with `build-openssl-static.sh freebsd_x86-64` / `openbsd_x86-64` (or the `openssl-libs.yml` BSD jobs) to restore it | `bsd/<arch>/` |
| All non-macOS at once | GitHub Actions workflow *OpenSSL static libs* (`.github/workflows/openssl-libs.yml`) | artifacts to copy here |

Check a library's version with `strings libcrypto.a | grep "OpenSSL 3"` (or
`findstr /C:"OpenSSL 3" libcrypto64MT.lib` on Windows).
