#!/bin/sh
#
# Builds the static OpenSSL libraries for one Linux or BSD architecture directory under
# openssl/libstatic (the macOS libraries are built by macos/build-openssl-macos.sh).
#
#   ./build-openssl-static.sh <arch> [version]
#
#   <arch>     x86 | x86-64 | alpine-x86-64 | arm64 | aarch64 | armhf |
#              freebsd_x86-64 | openbsd_x86-64
#   [version]  OpenSSL version, default 3.5.9
#
# The script compiles natively: run it on (or in a container/VM for) the platform whose
# directory you are refreshing, with the same compiler the agent itself is built with, so the
# library targets the same C runtime and architecture baseline as the agent. The GitHub
# workflow .github/workflows/openssl-libs.yml does exactly that for every directory.
#
# Environment:
#   OPENSSL_TARBALL   path to an already downloaded openssl-<ver>.tar.gz (skips the download)
#   CC                compiler (alpine-x86-64 defaults to musl-gcc)
#   JOBS              parallel make jobs (default: number of CPUs)
#   MAKE              GNU make binary (default: gmake if present, else make)
#
# The tarball is verified against the SHA-256 pinned in this script (falling back to the .sha256
# published on the OpenSSL GitHub release page for versions that are not pinned).
#
set -eu

ARCH="${1:-}"
VERSION="${2:-3.5.9}"
[ -n "$ARCH" ] || { echo "usage: $0 <arch> [version]" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
MAKE="${MAKE:-$(command -v gmake 2>/dev/null || command -v make)}"
if [ -z "${JOBS:-}" ]; then
	JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
fi
WORK="$(mktemp -d /tmp/openssl-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Options shared by every MeshAgent OpenSSL build. Keep this list in sync with COMMON_OPTS in
# macos/build-openssl-macos.sh, build-openssl-windows.ps1 and the notes in ../BUILDING.md.
#
#   no-shared/no-module  static libs; the "legacy" provider is compiled into libcrypto so
#                        util_from_p12() can load it without any files on disk (RC2 PKCS#12).
#   --api=1.1.0          headers do not flag APIs deprecated after 1.1.0, so the unchanged
#                        MeshAgent sources build without deprecation warnings. Nothing is
#                        removed from the library (no-deprecated is NOT given).
#   no-asm               matches the previous 1.1.1 libraries for these platforms and keeps
#                        the build free of per-arch assembler requirements.
COMMON_OPTS="no-shared no-module no-dso no-weak-ssl-ciphers no-srp no-psk no-comp no-zlib no-zlib-dynamic \
no-err no-rc5 no-idea no-md4 no-rmd160 no-seed no-camellia no-bf no-cast no-md2 no-mdc2 \
no-tests no-apps no-docs no-asm --api=1.1.0"

case "$ARCH" in
	x86)            TARGET=linux-x86;     OUT="$HERE/linux/$ARCH" ;;
	x86-64)         TARGET=linux-x86_64;  OUT="$HERE/linux/$ARCH" ;;
	alpine-x86-64)  TARGET=linux-x86_64;  OUT="$HERE/linux/$ARCH"; CC="${CC:-musl-gcc}"; export CC ;;
	arm64|aarch64)  TARGET=linux-aarch64; OUT="$HERE/linux/$ARCH" ;;
	armhf)          TARGET=linux-armv4;   OUT="$HERE/linux/$ARCH" ;;
	freebsd_x86-64) TARGET=BSD-x86_64;    OUT="$HERE/bsd/$ARCH" ;;
	openbsd_x86-64) TARGET=BSD-x86_64;    OUT="$HERE/bsd/$ARCH" ;;
	*)
		echo "unknown arch '$ARCH'; known: x86 x86-64 alpine-x86-64 arm64 aarch64 armhf freebsd_x86-64 openbsd_x86-64" >&2
		exit 2 ;;
esac

fetch_url() {
	if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$2" "$1"
	elif command -v fetch >/dev/null 2>&1; then fetch -o "$2" "$1"
	else ftp -o "$2" "$1"; fi
}
sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
	else sha256 -q "$1"; fi
}

# SHA-256 of each release tarball this repository has been built against, recorded here so the
# check does not depend on the host the tarball came from (the .sha256 next to the release only
# catches a corrupt download, not a tampered release). Keep in sync with the same table in
# build-openssl-windows.ps1 and macos/build-openssl-macos.sh. When adding a version, take the
# hash from https://www.openssl.org/source/ and check the release .asc against the OpenSSL
# signing key before recording it.
known_sha256() {
	case "$1" in
		3.5.9) echo 603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a ;;
		*) echo "" ;;
	esac
}

TARBALL="${OPENSSL_TARBALL:-$WORK/openssl-$VERSION.tar.gz}"
BASEURL="https://github.com/openssl/openssl/releases/download/openssl-$VERSION"
if [ ! -f "$TARBALL" ]; then
	echo "Downloading openssl-$VERSION.tar.gz"
	fetch_url "$BASEURL/openssl-$VERSION.tar.gz" "$TARBALL"
fi
EXPECTED="$(known_sha256 "$VERSION")"
if [ -z "$EXPECTED" ]; then
	echo "WARNING: no pinned SHA-256 for openssl-$VERSION in $0; falling back to the checksum published with the release" >&2
	fetch_url "$BASEURL/openssl-$VERSION.tar.gz.sha256" "$WORK/expected.sha256"
	EXPECTED="$(cut -d' ' -f1 "$WORK/expected.sha256")"
fi
ACTUAL="$(sha256_of "$TARBALL")"
if [ "$EXPECTED" != "$ACTUAL" ]; then
	echo "SHA256 mismatch for $TARBALL" >&2
	echo "  expected $EXPECTED" >&2
	echo "  actual   $ACTUAL" >&2
	exit 1
fi
echo "Verified openssl-$VERSION.tar.gz ($ACTUAL)"

SRC="$WORK/src"
mkdir -p "$SRC"
tar xzf "$TARBALL" -C "$SRC"
SRC="$SRC/openssl-$VERSION"

echo "==> Configuring $ARCH ($TARGET) with CC=${CC:-<default>}"
(cd "$SRC" && ./Configure "$TARGET" $COMMON_OPTS > configure.log 2>&1) || { cat "$SRC/configure.log"; exit 1; }
echo "==> Building $ARCH with $MAKE -j$JOBS"
(cd "$SRC" && "$MAKE" -j"$JOBS" build_libs > build.log 2>&1) || { tail -50 "$SRC/build.log"; exit 1; }

# The vendored headers are generated by the macOS build; the feature set must be identical
# so that the public structs and OPENSSL_NO_* switches match this library.
VENDORED="$HERE/../include/openssl/configuration.h"
if [ -f "$VENDORED" ]; then
	# Ignored: no-asm, and the engines/loaders OpenSSL enables per OS (Windows cert store,
	# Linux AF_ALG, BSD /dev/crypto); none of them affect the public headers.
	IGNORE='OPENSSL_NO_(ASM|WINSTORE|AFALGENG|DEVCRYPTOENG)$'
	grep -h '^#  *define OPENSSL_NO_' "$SRC/include/openssl/configuration.h" | sed 's/  */ /g' | grep -v -E "$IGNORE" | sort > "$WORK/built.no"
	grep -h '^#  *define OPENSSL_NO_' "$VENDORED" | sed 's/  */ /g' | grep -v -E "$IGNORE" | sort > "$WORK/vendored.no"
	if ! cmp -s "$WORK/built.no" "$WORK/vendored.no"; then
		echo "OPENSSL_NO_* feature set differs from the vendored configuration.h:" >&2
		diff "$WORK/vendored.no" "$WORK/built.no" >&2 || true
		exit 1
	fi
fi

mkdir -p "$OUT"
cp "$SRC/libcrypto.a" "$SRC/libssl.a" "$OUT/"
echo "==> Installed $OUT/libcrypto.a and libssl.a"
strings "$OUT/libcrypto.a" | grep -m1 "OpenSSL $VERSION" || { echo "version banner not found in libcrypto.a" >&2; exit 1; }
echo "Done."
