#!/bin/bash
#
# Builds the static OpenSSL libraries used by "make macos" (osx-x86-64 and osx-arm-64) and,
# optionally, refreshes the vendored headers in openssl/include/openssl.
#
#   ./build-openssl-macos.sh                     # build libs for the default version
#   ./build-openssl-macos.sh 3.5.9               # build a specific version
#   ./build-openssl-macos.sh 3.5.9 --refresh-headers
#
# Environment:
#   OPENSSL_TARBALL   path to an already downloaded openssl-<ver>.tar.gz (skips the download)
#   JOBS              parallel make jobs (default: number of CPUs)
#
# The tarball is verified against the .sha256 published on the OpenSSL GitHub release page.
#
set -euo pipefail

VERSION="${1:-3.5.9}"
REFRESH_HEADERS=0
[ "${2:-}" = "--refresh-headers" ] && REFRESH_HEADERS=1

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"
WORK="$(mktemp -d /tmp/openssl-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Options shared by every MeshAgent OpenSSL build. Keep this list in sync with the Linux
# scripts in ../linux/openssl-* and with the Windows notes in ../../BUILDING.md.
#
#   no-shared/no-module  static libs; the "legacy" provider is compiled into libcrypto so
#                        util_from_p12() can load it without any files on disk (RC2 PKCS#12).
#   --api=1.1.0          headers do not flag APIs deprecated after 1.1.0, so the unchanged
#                        MeshAgent sources build without deprecation warnings. Nothing is
#                        removed from the library (no-deprecated is NOT given).
#   threads              left enabled (default) so libcrypto is safe if touched off-thread.
#   asm                  left enabled on macOS for constant-time AES-NI / ARMv8 crypto.
COMMON_OPTS="no-shared no-module no-dso no-weak-ssl-ciphers no-srp no-psk no-comp no-zlib no-zlib-dynamic \
no-err no-rc5 no-idea no-md4 no-rmd160 no-seed no-camellia no-bf no-cast no-md2 no-mdc2 \
no-tests no-apps no-docs --api=1.1.0"

TARBALL="${OPENSSL_TARBALL:-$WORK/openssl-$VERSION.tar.gz}"
BASEURL="https://github.com/openssl/openssl/releases/download/openssl-$VERSION"
if [ ! -f "$TARBALL" ]; then
	echo "Downloading openssl-$VERSION.tar.gz"
	curl -fL --retry 3 -o "$TARBALL" "$BASEURL/openssl-$VERSION.tar.gz"
fi
curl -fsL --retry 3 -o "$WORK/expected.sha256" "$BASEURL/openssl-$VERSION.tar.gz.sha256"
EXPECTED="$(cut -d' ' -f1 "$WORK/expected.sha256")"
ACTUAL="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
if [ "$EXPECTED" != "$ACTUAL" ]; then
	echo "SHA256 mismatch for $TARBALL" >&2
	echo "  expected $EXPECTED" >&2
	echo "  actual   $ACTUAL" >&2
	exit 1
fi
echo "Verified openssl-$VERSION.tar.gz ($ACTUAL)"

build_arch() {
	local dir="$1" target="$2" minflag="$3"
	local src="$WORK/$dir"
	mkdir -p "$src"
	tar xzf "$TARBALL" -C "$src" --strip-components=1
	echo "==> Configuring $dir ($target)"
	(cd "$src" && ./Configure "$target" $COMMON_OPTS "$minflag" > configure.log 2>&1) || { cat "$src/configure.log"; exit 1; }
	echo "==> Building $dir"
	(cd "$src" && make -j"$JOBS" build_libs > build.log 2>&1) || { tail -50 "$src/build.log"; exit 1; }
	mkdir -p "$HERE/$dir"
	cp "$src/libcrypto.a" "$src/libssl.a" "$HERE/$dir/"
	echo "==> Installed $HERE/$dir/libcrypto.a and libssl.a"
}

# Deployment targets match MACOSARCH in the top-level makefile.
build_arch osx-x86-64 darwin64-x86_64-cc -mmacosx-version-min=10.12
build_arch osx-arm-64 darwin64-arm64-cc  -mmacosx-version-min=11.0

if [ "$REFRESH_HEADERS" = 1 ]; then
	INC="$ROOT/openssl/include/openssl"
	SRC="$WORK/osx-arm-64/include/openssl"
	echo "==> Refreshing vendored headers in $INC"
	rm -f "$INC"/*.h "$INC"/*.H
	cp "$SRC"/*.h "$INC/"
	# The vendored include directory is shared by every platform, so the generated
	# configuration.h must not hard-code the word size of the machine that built it.
	perl -0pi -e 's{#  (?:define|undef) BN_LLONG\n(?:.*\n){0,12}?#  (?:define|undef) THIRTY_TWO_BIT\n(?:\s*/\* clang-format on \*/\n)?}{#  if defined(_WIN64)\n#   undef BN_LLONG\n#   undef SIXTY_FOUR_BIT_LONG\n#   define SIXTY_FOUR_BIT\n#   undef THIRTY_TWO_BIT\n#  elif defined(__LP64__) || defined(_LP64)\n#   undef BN_LLONG\n#   define SIXTY_FOUR_BIT_LONG\n#   undef SIXTY_FOUR_BIT\n#   undef THIRTY_TWO_BIT\n#  else\n#   define BN_LLONG\n#   undef SIXTY_FOUR_BIT_LONG\n#   undef SIXTY_FOUR_BIT\n#   define THIRTY_TWO_BIT\n#  endif\n}' "$INC/configuration.h"
	grep -q 'defined(_WIN64)' "$INC/configuration.h" || { echo "configuration.h word-size patch did not apply" >&2; exit 1; }
	echo "==> Headers refreshed (OpenSSL $VERSION)"
fi

echo "Done."
