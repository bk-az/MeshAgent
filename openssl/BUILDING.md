# OpenSSL in MeshAgent

The agent links OpenSSL statically. This directory holds the vendored public headers
(`include/openssl`) and the prebuilt static libraries (`libstatic/...`). Both must come
from the **same OpenSSL version**, otherwise the link fails or, worse, silently misbehaves.

| Item | Value |
|---|---|
| Current version | OpenSSL 3.5.9 (LTS, supported until 2030-04-08) |
| Source | https://github.com/openssl/openssl/releases (the build scripts verify the tarball against a SHA-256 pinned in each script; for a version without a pin they fall back to the `.sha256` published with the release and warn) |
| Configure options | see `COMMON_OPTS` in `libstatic/macos/build-openssl-macos.sh` |

## Why the source needs almost no changes

OpenSSL 3.x/4.x keeps every function the agent uses; most are merely *deprecated*
(low-level `RSA_*`, `HMAC_*`, `MD5_*`, `SHA*_*`, `EVP_PKEY_get1_RSA`, ...). The libraries
are built with `--api=1.1.0` **without** `no-deprecated`, so:

- nothing is removed from the library, and
- the generated `configuration.h` sets `OPENSSL_CONFIGURED_API` to 1.1.0, so the headers
  do not emit deprecation warnings for the unchanged upstream sources.

The only source changes are guarded with `#if OPENSSL_VERSION_NUMBER >= 0x30000000L`
so the tree still builds against OpenSSL 1.1.1 headers (upstream) and merges stay trivial:

1. `microstack/ILibCrypto.c` `util_from_p12()`: PKCS#12 blobs written by 1.1.x use
   RC2-40 for the certificate bag. OpenSSL 3+ only ships RC2 in the `legacy` provider, so
   on a parse failure the provider is loaded once (it is compiled into libcrypto thanks to
   `no-module`) and the parse is retried. Without this an upgraded agent could not read its
   stored certificate and would generate a new node identity.
2. `microstack/ILibCrypto.c` FIPS block (only with `make ... FIPS=1`): uses the 3.x
   `EVP_default_properties_enable_fips()` API instead of the removed `FIPS_mode_set()`.
3. `microstack/ILibWrapperWebRTC.c`: `_MINCORE` builds used `DTLSv1_method()`, which was
   removed in 4.0; they now use `DTLS_method()` like every other build.
4. `microstack/ILibCrypto.c` `util_mkCertEx()`: the `CRYPTO_mem_ctrl()` debug call is
   skipped on 3.0+ (memory debugging was removed there, the call was already a no-op).
5. `microstack/ILibCrypto.c` `util_mkCertEx()`: on 4.0+ the subject name is built in a
   fresh `X509_NAME` and set with `X509_set_subject_name()`, because
   `X509_get_subject_name()` returns a `const` pointer since 4.0.
6. `microstack/ILibCrypto.c` `ILibCrypto_WinGetBySubject()` (Windows certificate-store
   lookup): the `X509_LOOKUP_get_by_subject_fn` callback takes a `const X509_NAME *` since
   3.0, so the parameter is declared `const` on 3.0+ (MSVC warned C4028/C4090 otherwise).
7. `SSL_CTX_set_options()` calls in `microstack/ILibWebClient.c`, `microstack/ILibWebServer.c`
   and `microscript/ILibDuktape_net.c` no longer pass `SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER |
   SSL_MODE_ENABLE_PARTIAL_WRITE`. Those are *mode* flags (values 0x2 and 0x1) and were never
   applied as modes; in 1.1.1 the same option bits were unused, but since OpenSSL 3.0 they mean
   `SSL_OP_CLEANSE_PLAINTEXT` and `SSL_OP_NO_EXTENDED_MASTER_SECRET`, so every TLS connection
   silently disabled the Extended Master Secret extension. Dropping them restores the exact
   1.1.1 behaviour. They are deliberately not moved to `SSL_CTX_set_mode()`: the send path
   ignores `SSL_write()`'s return value, which is only safe without partial writes.

Items 3 and 5 are only *active* when building against 4.x headers; with the vendored
3.5 headers the code compiles exactly as it did before. They are kept so the tree builds
unchanged against 1.1.1, 3.x and 4.x, which makes a later version switch a rebuild of the
libraries only.

New PKCS#12 blobs written by `util_to_p12()` use the OpenSSL 3+/4 defaults
(AES-256-CBC, PBKDF2/HMAC-SHA256). OpenSSL 1.1.1 can read those too, so a downgrade of
the agent binary does not lose the identity either.

## Rebuilding the libraries

All platforms must be rebuilt from the same tarball with the same feature options.
`no-module` is required (it builds the legacy provider into libcrypto); do **not** add
`no-deprecated`, `no-legacy` or `no-rc2`.

### macOS (also refreshes the vendored headers)

```sh
./openssl/libstatic/macos/build-openssl-macos.sh 3.5.9 --refresh-headers
```

Builds `osx-x86-64` (min macOS 10.12) and `osx-arm-64` (min macOS 11.0) and copies the
generated headers into `openssl/include/openssl`, patching `configuration.h` so its
word-size section is selected by compiler macros instead of being hard-coded for the
build machine (the header directory is shared by every platform).

### Linux and BSD

```sh
./openssl/libstatic/build-openssl-static.sh <arch> [version]
# <arch>: x86 | x86-64 | alpine-x86-64 | arm64 | aarch64 | armhf | freebsd_x86-64 | openbsd_x86-64
```

The script compiles natively with the platform's own compiler (musl-gcc for `alpine-x86-64`),
verifies the tarball checksum, checks that the `OPENSSL_NO_*` feature set matches the vendored
`configuration.h`, and copies `libcrypto.a` / `libssl.a` into `libstatic/linux/<arch>` or
`libstatic/bsd/<arch>`. Run it on the same base image the agent is built on in
`.github/workflows/linux-build.yml` (debian:bookworm for `aarch64`, the armv6 Raspbian image for
`armhf`, FreeBSD 13.5 for `freebsd_x86-64`) so the library shares the agent's libc baseline.
On Debian/Ubuntu the script needs `build-essential perl curl`, plus `libc6-dev-i386 gcc-multilib`
for `x86` (the `-m32` include path needs the `asm/` headers that `gcc-multilib` provides) and
`musl-tools` for `alpine-x86-64` (the script appends the host kernel headers after musl's with
`-idirafter`, the same way `MUSL_CC` does in the top-level makefile). Without GitHub Actions, the
same images run locally under Docker (Colima with Rosetta on Apple silicon; `tonistiigi/binfmt
--install arm` for the armv6 container): mount the checkout at `/src` and run the script inside.

The remaining `libstatic/linux/*` directories (mips, poky, pogo, ...) are legacy upstream targets
that this fork does not build; the `openssl-<arch>` scripts next to them document the original
cross-toolchain invocations and have been updated to the 3.x option list, but the libraries have
not been rebuilt.

**FreeBSD and OpenBSD are not supported by this fork for now.** The libraries under
`libstatic/bsd/` are still the OpenSSL 1.1.1s build and no longer link against the 3.5.9 headers
(the agent now calls 3.x-only functions such as `OSSL_PROVIDER_load`), so `make freebsd ARCHID=30`
and `make openbsd ARCHID=37` fail at link time until those libraries are rebuilt. The *FreeBSD
Build* workflow is therefore reduced to a manual trigger, the `freebsd` job is removed from
`release.yml` and `meshagent_freebsd_x86-64` from `.github/release-files.json`. To bring BSD back,
run `build-openssl-static.sh freebsd_x86-64` / `openbsd_x86-64` on those platforms (or the
`freebsd` and `openbsd` jobs of `openssl-libs.yml`), commit the output, and restore those three
workflow entries.

### Windows (`libstatic/*.lib`)

Step-by-step guide for a Windows machine with Visual Studio 2022 (Community, Professional or
Build Tools all work). Everything else the build needs is installed or located by the script.

**1. Prerequisites**

- Visual Studio 2022 with the workload *Desktop development with C++*. For the ARM64
  libraries also tick the component *MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools*
  (Visual Studio Installer > Modify > Individual components). Without it the script builds
  x64 and x86 and skips ARM64 with a warning.
- Git, and this branch checked out (`git checkout openssl_upgrade`).
- Internet access: the script downloads `openssl-<version>.tar.gz` from GitHub and, if no
  native Windows Perl is installed, installs Strawberry Perl through `winget`. (Git's bundled
  msys Perl cannot build MSVC targets and is ignored.) To install Perl by hand instead, get it
  from https://strawberryperl.com and re-run.

**2. Build the libraries**

Open a normal PowerShell window (no developer prompt needed), `cd` to the repository root
and run:

```powershell
powershell -ExecutionPolicy Bypass -File openssl\libstatic\build-openssl-windows-all.ps1 -BuildAgent
```

The script finds Visual Studio with `vswhere`, loads the x64, x86 and ARM64 compiler
environments in turn (x64-hosted cross compilers, so an x64 machine builds all three), and
for every platform builds a release and a debug variant of `libcrypto` and `libssl` (static,
`/MT /Zl`, so the project's `/MT` or `/MTd` setting decides the C runtime at link time). Each
result is checked for the absence of a dynamic-runtime (`MSVCRT`) directive and for the
`OpenSSL <version>` banner before it overwrites the matching files:

| Platform | Files replaced in `openssl/libstatic` |
|---|---|
| x64   | `libcrypto64MT.lib` `libssl64MT.lib` `libcrypto64MTd.lib` `libssl64MTd.lib` |
| x86   | `libcrypto32MT.lib` `libssl32MT.lib` `libcrypto32MTd.lib` `libssl32MTd.lib` |
| ARM64 | `libcryptoARM64.lib` `libsslARM64.lib` `libcryptoARM64d.lib` `libsslARM64d.lib` |

`-BuildAgent` then builds `MeshAgent-2022.sln` (Release) for every platform that succeeded
and fails if a produced `Release\*.exe` does not contain the `OpenSSL <version>` string.
Expect 30 to 60 minutes in total; the end of the output is a summary like:

```
Summary (OpenSSL 3.5.9):
  x64    built, agent verified
  x86    built, agent verified
  ARM64  built, agent verified
  libcrypto32MT.lib        OpenSSL 3.5.9
  ...
```

The Windows script additionally passes `-D_WIN32_WINNT=0x0601` (Windows 7+), so OpenSSL seeds its
DRBG through `BCryptGenRandom` instead of the CryptoAPI path, which needs `%SystemRoot%` in the
process environment and fails in children spawned with a minimal explicit environment (the reason
for the `SystemRoot` injection in `ILibProcessPipe.c`). The committed libraries have been built
with it since 3a0265d: `findstr /M /C:"BCryptGenRandom" openssl\libstatic\libcrypto64MT.lib`
prints the file name. If the agent link ever fails on `BCryptGenRandom`, add `bcrypt.lib` to the
linker inputs of the `-2022.vcxproj` projects (OpenSSL requests it with a `#pragma comment(lib)`,
which `/Zl` may drop).

Useful options: `-Platforms x64,x86` to build a subset, `-Version 3.5.10` for another
release, `-Tarball C:\path\openssl-3.5.9.tar.gz` to reuse a downloaded archive (its
SHA256 is still verified against the pinned checksum). When moving to a new release, add its
SHA-256 to the `known_sha256` / `$KnownSha256` table in all three build scripts after checking
the release signature.

**3. Check and commit**

```powershell
findstr /M /C:"OpenSSL 3.5.9" Release\MeshAgent64.exe      # prints the file name when found
git status                                                 # the 12 .lib files should be modified
git add openssl\libstatic\*.lib
git commit -m "Rebuild Windows OpenSSL static libraries (3.5.9)"
git push
```

Only the `.lib` files need committing; the headers in `openssl/include/openssl` are already
the matching 3.5.9 ones on this branch. After the push the *Windows Build* GitHub workflow
links the agent against the new libraries as a second check.

**Troubleshooting**

- *`error LNK2019: unresolved external symbol __dtoul3_legacy`* (or another `__*3` helper) when
  linking the agent: the OpenSSL objects were compiled by a newer MSVC toolset than the one the
  project configuration uses. All configurations in the `-2022` projects use `v143`; if a
  configuration was switched back to `v142`, either restore `v143` or rebuild the libraries from
  a `vcvarsall ... -vcvars_ver=14.29` prompt.

- *"vswhere.exe not found"* or *"No Visual Studio 2022 ... found"*: install the C++ workload
  listed above; a bare Visual Studio without C++ tools is not enough.
- *"A native Windows Perl is required"*: `winget` is unavailable or was blocked; install
  Strawberry Perl manually and re-run.
- *"Configure failed"* or *"nmake failed"*: the full OpenSSL output is printed just above the
  message. The commonest cause is an msys Perl earlier on `PATH` than Strawberry Perl.
- Running the per-platform script directly, from a matching *Native Tools* prompt, is also
  possible: `pwsh openssl\libstatic\build-openssl-windows.ps1 -Platform x64` (or `x86`, `ARM64`).

No project changes are required: the `.vcxproj` files reference the libraries by their fixed
names (`..\openssl\libstatic\libcrypto64MT.lib` and so on) and `..\openssl\include` for the
headers, so a normal Visual Studio build picks up the new OpenSSL as soon as the files are
replaced. OpenSSL 3 additionally needs `bcrypt.lib` for its random seeding; its
`rand_win.c` pulls that in itself with `#pragma comment(lib, "bcrypt.lib")`, and `Crypt32.lib`
and `ws2_32.lib` are already in the linker inputs.

### All of the above from GitHub Actions

`.github/workflows/openssl-libs.yml` (manual `workflow_dispatch`, input: version) runs the two
scripts on the same runners and container images as the agent build workflows and uploads one
artifact per platform:

```sh
gh workflow run openssl-libs.yml --ref <branch> -f version=3.5.9
gh run download <run-id> -D /tmp/openssl-libs     # then copy into openssl/libstatic
```

## Verification checklist

Work through these in order; each stage proves the one before it.

**1. Libraries in the tree** (every file, every platform):

```sh
# macOS / Linux: every line must print the same 3.x version, none may print 1.1.1
# (only libcrypto embeds the banner; libssl is always rebuilt together with it)
for f in $(find openssl/libstatic -name 'libcrypto*'); do printf '%-55s ' "$f"; strings "$f" | grep -m1 -o -E 'OpenSSL [0-9.]+[a-z]?'; echo; done
```
```powershell
# Windows
Get-ChildItem openssl\libstatic\libcrypto*.lib | % { "{0,-24} {1}" -f $_.Name, (Select-String -Path $_ -Pattern 'OpenSSL [0-9.]+[a-z]?' | Select -First 1).Matches[0].Value }
```
`grep -m1 OPENSSL_VERSION_STR openssl/include/openssl/opensslv.h` must show the same version.

**2. Every agent builds and links.** `make macos ARCHID=29` / `16`, `make linux ARCHID=6` etc.,
`msbuild MeshAgent-2022.sln /p:Configuration=Release /p:Platform=x64` (and x86, ARM64). A link
error mentioning `OPENSSL_` or `SSL_` symbols means the library for that platform is still old.
After the branch is pushed, the *Windows Build*, *Linux Build* and *macOS Build* workflows must all
be green. *FreeBSD Build* is manual-only until the BSD libraries are rebuilt (see "Linux and BSD" above).

**3. The binaries carry the new version and no old banner.**

```sh
strings meshagent_osx-arm-64 | grep -E 'OpenSSL [0-9]'      # exactly one line, the new version
strings meshagent_osx-arm-64 | grep -c 'OpenSSL 1\.1'        # must print 0
```
```powershell
findstr /M /C:"OpenSSL 3." Release\MeshAgent64.exe            # prints the file name
findstr /M /C:"OpenSSL 1.1" Release\MeshAgent64.exe           # prints nothing
```

**4. The agent runs with the new library.** From a scratch folder (never install a test build):
`./meshagent_osx-arm-64 -info` prints `Using OpenSSL 3.x.y`.

**5. Existing identities survive.** Copy a `.db` from an installed 1.1.1-era agent next to the
new binary in the scratch folder, start it once against the server, and confirm the server shows
the same node ID (no new device appears). This exercises the RC2 PKCS#12 legacy-provider path.

**6. A real session works.** Install the packaged build on one test machine per platform, open a
desktop session, a terminal session and a file transfer from MeshCentral, and confirm the agent
reconnects after `kickstart`/service restart.

**7. What the pentester sees.** Download the installer from the tenant's Owner download page,
extract the agent executable from it, and repeat step 3 on *that* file. The finding is closed
only when the file customers download reports the new version. Keep the build date and OpenSSL
version in the release notes / asset inventory as the report's remediation asks.

## Upgrading to a newer OpenSSL

1. Run the macOS script with the new version and `--refresh-headers`.
2. Rebuild the Linux/Windows libraries with the same options (and the BSD ones, if BSD support
   has been restored by then).
3. Build the agent (`make macos ARCHID=29` etc.) and confirm `meshagent -info` reports the
   new version; run an agent that has an existing `.db` to confirm its node ID is unchanged.
4. Skim the OpenSSL `CHANGES.md` for removed functions and grep for them in `microstack`
   and `microscript`; add another guarded branch only if something was removed.
