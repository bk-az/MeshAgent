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

Run the matching `openssl/libstatic/linux/openssl-<arch>` script from a directory that
contains the unpacked OpenSSL source as `../openssl` (see the comment in each script).
The scripts set `CC` for the cross toolchains used upstream; adjust the paths for your
machine.

### Windows (`libstatic/*.lib`)

From a Visual Studio x64 / x86 / ARM64 Native Tools prompt with Perl and NASM installed:

```bat
perl Configure VC-WIN64A  no-shared no-module no-dso no-weak-ssl-ciphers no-srp no-psk no-comp no-zlib no-zlib-dynamic no-err no-rc5 no-idea no-md4 no-rmd160 no-seed no-camellia no-bf no-cast no-md2 no-mdc2 no-tests no-apps no-docs --api=1.1.0
nmake build_libs
```

`no-shared` makes the VC targets use `/MT` (release) and `/MTd` (with `--debug`), which is
what the existing `libcrypto64MT.lib` / `libcrypto64MTd.lib` names expect. Use `VC-WIN32`
for the 32-bit `*32MT*.lib` files and `VC-WIN64-ARM` for the `*ARM64*.lib` files, and copy
the resulting `libcrypto.lib` / `libssl.lib` over the corresponding files in `libstatic`.
The project files already link `Crypt32.lib`, `Bcrypt.lib` and `ws2_32.lib`, which is all
OpenSSL 3+/4 needs.

## Upgrading to a newer OpenSSL

1. Run the macOS script with the new version and `--refresh-headers`.
2. Rebuild the Linux/BSD/Windows libraries with the same options.
3. Build the agent (`make macos ARCHID=29` etc.) and confirm `meshagent -info` reports the
   new version; run an agent that has an existing `.db` to confirm its node ID is unchanged.
4. Skim the OpenSSL `CHANGES.md` for removed functions and grep for them in `microstack`
   and `microscript`; add another guarded branch only if something was removed.
