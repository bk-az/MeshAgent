# macOS Packaging Guide for MeshAgent

How to build, sign, and notarize a macOS installer (`.pkg`) for MeshAgent
that is reused, byte-identical, across every tenant — with each tenant's
server/mesh configuration supplied separately as a `.msh` file placed next
to the `.pkg` at install time.

Builds are **per-architecture** (arm64 and x86_64 separately), matching how
MeshCentral itself distributes the mac agent — the server detects the
requesting client's CPU and serves the matching build, rather than shipping
one double-sized universal binary to every machine. See the
[Appendix](#appendix-universal-binary) if you want a single universal
artifact instead.

## Why it's built this way

- **Apple notarization is tied to exact file bytes.** If a tenant's `.msh`
  were baked into the package payload, every tenant's `.pkg` would have a
  different hash and need its own notarization submission (slow, and a
  bad fit for handing out installers on demand). Keeping the `.msh`
  external means you sign + notarize **once per release**, not once per
  tenant.
- **This doesn't use `../MeshCentral/macosinstaller.js`.** That module
  hand-encodes the xar/cpio/pkg binary format in pure JS because it has to
  run inside the MeshCentral server on Linux/Windows, where no real Mac is
  available. It also bakes a specific tenant's `.msh` into every package it
  builds, by design — correct for its one-download-per-browser-request use
  case, wrong for a reusable signed artifact.
- **This doesn't use `../MeshCentral/agents/MeshAgentOSXPackager.zip`
  either.** That's a static, pre-built legacy bundle `.mpkg`
  (`authoringTool="com.apple.PackageMaker"`). PackageMaker was removed from
  Xcode over a decade ago and doesn't exist on any current Mac — the zip is
  a hand-editable template, not a working build tool — and bundle-style
  `.mpkg`s are rejected outright by modern macOS (Sequoia/Tahoe).
- **This uses `pkgbuild` + `productbuild`** — Apple's own, currently
  supported CLI tools for building flat installer packages (Xcode Command
  Line Tools). The build logic lives in
  [`build-macos-pkg.js`](build-macos-pkg.js) in this folder.

## Prerequisites

- macOS with Xcode Command Line Tools: `xcode-select --install`
  (provides `make`, `codesign`, `pkgbuild`, `productbuild`, `pkgutil`, `spctl`)
- Node.js (any recent version — the script only uses core modules)
- An Apple Developer Program membership, with two certificates installed
  in your keychain:
  - **Developer ID Application** — signs the binary
  - **Developer ID Installer** — signs the `.pkg` (a different identity
    type; check what you have with `security find-identity -v -p basic`)
- Optionally, a checkout of `../MeshCentral` alongside this repo, to reuse
  its installer background image

## 1. Build the agent binaries

```sh
cd MeshAgent
make -j4 macos ARCHID=29                 # arm64  -> meshagent_osx-arm-64
make clean                               # required: both mac targets share .o filenames
make -j4 macos ARCHID=16                 # x86_64 -> meshagent_osx-x86-64
```

## 2. Sign each binary

```sh
codesign --sign "Developer ID Application: Your Org (TEAMID)" \
  --options runtime --timestamp meshagent_osx-arm-64
codesign --sign "Developer ID Application: Your Org (TEAMID)" \
  --options runtime --timestamp meshagent_osx-x86-64

codesign -dv meshagent_osx-arm-64        # verify: TeamIdentifier should be set, not "adhoc"
codesign -dv meshagent_osx-x86-64
```

## 3. Build a pkg per architecture (no `.msh` baked into either)

```sh
node packaging/macos/build-macos-pkg.js meshagent_osx-arm-64 dist/arm64 \
  --background ./background.png \
  --company AssetSonar \
  --service SonarSightAgent \
  --exe SonarSightAgent \
  --display-name "Sonar Sight"



node packaging/macos/build-macos-pkg.js meshagent_osx-x86-64 dist/x86_64 \
  --background ./background.png \
  --company AssetSonar \
  --service SonarSightAgent \
  --exe SonarSightAgent \
  --display-name "Sonar Sight"
```

Produces `dist/arm64/SonarSightAgent.pkg` and
`dist/x86_64/SonarSightAgent.pkg` (unsigned), plus a matching
`Uninstall.command` in each folder.

The `.pkg` filename comes from `--exe` (override with `--pkg-name`), so the
package and the `.msh` it requires are always named alike --
`SonarSightAgent.pkg` next to `SonarSightAgent.msh`. `--display-name` only
sets the installer window title and is never used for the filename, so a
title with a space in it cannot leak into the artifact name.

Options (`node packaging/macos/build-macos-pkg.js --help`):

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | `.` | Output directory (or use the 2nd positional arg) |
| `--company <name>` | `meshagent` | Install path component (`/usr/local/mesh_services/<company>/<service>/`) |
| `--service <name>` | `meshagent` | launchd label / daemon dir name |
| `--exe <name>` | `meshagent` | Installed executable name, and the required `<exe>.msh` filename |
| `--display-name <name>` | `Mesh Agent` | Installer window title only (not the filename) |
| `--pkg-name <name>` | `--exe`, else `MeshAgent` | Output `.pkg` filename, without the extension |
| `--version <x.y.z>` | `1.0` | Package version |
| `--background <path>` | — | Optional PNG for the installer sidebar |
| `--sign <identity>` | — | Sign in this same step via `productbuild --sign` (skips step 4) |
| `--keep-work` | off | Keep the intermediate build directory, for debugging |

## 4. Sign each pkg

Skip this if you already passed `--sign` in step 3.

```sh
productsign --sign "Developer ID Installer: Your Org (TEAMID)" \
  dist/arm64/SonarSightAgent.pkg dist/arm64/SonarSightAgent-signed.pkg
productsign --sign "Developer ID Installer: Your Org (TEAMID)" \
  dist/x86_64/SonarSightAgent.pkg dist/x86_64/SonarSightAgent-signed.pkg

pkgutil --check-signature dist/arm64/SonarSightAgent-signed.pkg    # verify: "Status: signed..."
pkgutil --check-signature dist/x86_64/SonarSightAgent-signed.pkg
```

## 5. Notarize + staple each

One-time credential setup:

```sh
xcrun notarytool store-credentials "AC_PROFILE" \
  --apple-id "you@yourorg.com" --team-id TEAMID --password "app-specific-password"
```

Per release:

```sh
xcrun notarytool submit dist/arm64/SonarSightAgent-signed.pkg --keychain-profile "AC_PROFILE" --wait
xcrun stapler staple dist/arm64/SonarSightAgent-signed.pkg

xcrun notarytool submit dist/x86_64/SonarSightAgent-signed.pkg --keychain-profile "AC_PROFILE" --wait
xcrun stapler staple dist/x86_64/SonarSightAgent-signed.pkg

spctl -a -vv -t install dist/arm64/SonarSightAgent-signed.pkg      # verify: "accepted"
spctl -a -vv -t install dist/x86_64/SonarSightAgent-signed.pkg
```

`dist/arm64/SonarSightAgent-signed.pkg` and `dist/x86_64/SonarSightAgent-signed.pkg`
are now your two durable artifacts. Rebuild them only on a new MeshAgent
release — never per tenant.

## 6. Create a per-tenant `.msh`

One `.msh` per tenant works for **both** architectures — it's pure server
config, unrelated to CPU. Pull the real `MeshID` / `ServerID` from your
MeshCentral server (device group → "Add Agent" → download for macOS) —
don't hand-type these, they're specific to your server and mesh. Line
endings must be CRLF (`\r\n`):

```sh
printf 'MeshName=Acme Corp\r\nMeshType=2\r\nMeshID=0x<meshid-hex-from-server>\r\nServerID=<serverid-hex-from-server>\r\nMeshServer=wss://meshcentral.yourdomain.com:443/agent.ashx\r\n' > SonarSightAgent.msh
```

Common fields (see `webserver.js` in the MeshCentral repo for the full
list, including `Tag`, `InstallFlags`, `displayName`, `companyName`, etc.):

| Field | Meaning |
|---|---|
| `MeshName` | Human-readable device-group name |
| `MeshType` | Group type (as assigned by the server) |
| `MeshID` | Hex-encoded device-group ID, `0x`-prefixed |
| `ServerID` | Hex-encoded hash of the server's agent certificate |
| `MeshServer` | `wss://` URL the agent connects to (or `local` for LAN-only) |

## 7. Assemble the per-tenant install folder

Pick the `.pkg` matching the **target Mac's CPU** (check remotely with
`uname -m`: `arm64` or `x86_64`). The filename doesn't matter to the
installer logic — only the sibling `<exe>.msh` filename does — so both
architecture pkgs can even sit in the same folder next to one shared
`SonarSightAgent.msh` if you'd rather hand out both and let the deployer pick:

```sh
mkdir -p out/acme
cp dist/arm64/SonarSightAgent-signed.pkg out/acme/SonarSightAgent-arm64.pkg
cp dist/x86_64/SonarSightAgent-signed.pkg out/acme/SonarSightAgent-x86_64.pkg
cp SonarSightAgent.msh out/acme/SonarSightAgent.msh
cp dist/arm64/Uninstall.command out/acme/Uninstall.command
```

## 8. Install

```sh
cd out/acme
uname -m                                  # confirm this Mac's architecture first
sudo installer -pkg SonarSightAgent-arm64.pkg -target /     # or SonarSightAgent-x86_64.pkg
```

`installer` always passes the `.pkg`'s own path as `$1` to the postinstall
script, which looks for `<exe>.msh` next to it. If `SonarSightAgent.msh` isn't
sitting beside the `.pkg`, the install fails loudly with:

```
ERROR: SonarSightAgent.msh not found next to this installer package.
       Place a tenant-specific SonarSightAgent.msh in the same folder as
       the .pkg and re-run the installer.
```

## 9. Verify it's running

```sh
sudo launchctl list | grep SonarSightAgent
ls -la /usr/local/mesh_services/AssetSonar/SonarSightAgent/
cat /usr/local/mesh_services/AssetSonar/SonarSightAgent/SonarSightAgent.msh   # should match the tenant's file
```

## 10. Uninstall

```sh
sudo bash out/acme/Uninstall.command
```

## Appendix: universal binary

A single arm64+x86_64 binary avoids picking the right `.pkg` per Mac, at
the cost of roughly doubling the shipped size (every Mac only ever runs
one slice; the other sits on disk unused) and one extra build step:

```sh
lipo -create -output meshagent_universal meshagent_osx-arm-64 meshagent_osx-x86-64
lipo -info meshagent_universal            # verify: x86_64 arm64
```

Sign, package, sign-the-pkg, and notarize it exactly as in steps 2–5
above, just pointing at `meshagent_universal` instead of the two
arch-specific binaries, and skip building/signing/notarizing a second
copy. Sign **after** `lipo`, never before — `lipo -create` does not
preserve a valid signature from already-signed thin inputs.
