# OpenSSL in MeshAgent

The agent links OpenSSL statically. This directory holds the vendored public headers
(`include/openssl`) and the prebuilt static libraries (`libstatic/...`). Both must come
from the **same OpenSSL version**, otherwise the link fails or, worse, silently misbehaves.

| Item | Value |
|---|---|
| Current version | OpenSSL 3.5.9 (LTS, supported until 2030-04-08) |
| Source | https://github.com/openssl/openssl/releases (tarball checksum is verified by the build scripts) |
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

The remaining `libstatic/linux/*` directories (mips, poky, pogo, ...) are legacy upstream targets
that this fork does not build; the `openssl-<arch>` scripts next to them document the original
cross-toolchain invocations and have been updated to the 3.x option list, but the libraries have
not been rebuilt.

### Windows (`libstatic/*.lib`)

```powershell
# from an x64 / x86 / ARM64 Native Tools prompt (or after vcvarsall), Perl on PATH
pwsh openssl/libstatic/build-openssl-windows.ps1 -Platform x64
pwsh openssl/libstatic/build-openssl-windows.ps1 -Platform x86
pwsh openssl/libstatic/build-openssl-windows.ps1 -Platform ARM64
```

Each run builds a release (`/MT`) and a `--debug` (`/MTd`) variant with `VC-WIN64A`, `VC-WIN32`
or `VC-WIN64-ARM` and overwrites the matching `libcrypto64MT.lib` / `libcrypto64MTd.lib`,
`*32MT*.lib` or `*ARM64*.lib` files (and the `libssl` twins). The script checks that the result
carries the `LIBCMT` / `LIBCMTD` default-library directive, so a `/MD` build cannot slip in.
The project files already link `Crypt32.lib`, `Bcrypt.lib` and `ws2_32.lib`, which is all
OpenSSL 3+ needs.

### All of the above from GitHub Actions

`.github/workflows/openssl-libs.yml` (manual `workflow_dispatch`, input: version) runs the two
scripts on the same runners and container images as the agent build workflows and uploads one
artifact per platform:

```sh
gh workflow run openssl-libs.yml --ref <branch> -f version=3.5.9
gh run download <run-id> -D /tmp/openssl-libs     # then copy into openssl/libstatic
```

## Upgrading to a newer OpenSSL

1. Run the macOS script with the new version and `--refresh-headers`.
2. Rebuild the Linux/BSD/Windows libraries with the same options.
3. Build the agent (`make macos ARCHID=29` etc.) and confirm `meshagent -info` reports the
   new version; run an agent that has an existing `.db` to confirm its node ID is unchanged.
4. Skim the OpenSSL `CHANGES.md` for removed functions and grep for them in `microstack`
   and `microscript`; add another guarded branch only if something was removed.
