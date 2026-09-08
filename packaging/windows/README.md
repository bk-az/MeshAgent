# Windows Packaging — embed a tenant `.msh` into a signed `.exe`

The Windows counterpart to [`../macos`](../macos). Same goal — **sign once per
release, provision per tenant** — but where macOS keeps the `.msh` beside the
package, Windows embeds it *inside* the signed `.exe` without breaking the
signature.

## Why this works without re-signing

An Authenticode signature does not cover three parts of a PE file: the
optional-header checksum, the certificate-table directory entry, and the
attribute certificate table itself. [`embed-msh-windows.js`](embed-msh-windows.js)
appends the `.msh` to the end of the file and grows the certificate table to
cover it, so the appended bytes land in a region the signature ignores. The
Microsoft signature stays valid, so you:

1. Build and **sign + timestamp the `.exe` once per release**.
2. Stamp each tenant's `.msh` in afterwards — no certificate, no re-signing.

For an **unsigned** `.exe` (or any non-PE file) there is no certificate table,
so the `.msh` is simply appended. The agent finds it either way by reading the
trailing marker.

Trailer written at end-of-file, which the agent looks for:

```
[ ...msh bytes... ][ msh length: 4 bytes big-endian ][ 16-byte GUID ]
```

## Usage

```sh
# One signed .exe per release  +  one .msh per tenant  ->  a ready-to-ship .exe
node packaging/windows/embed-msh-windows.js \
  MeshAgentSigned.exe  tenant.msh  dist/acme/SonarSightAgent.exe  --verify
```

`--verify` re-reads the output and confirms the `.msh` round-trips and, for a
signed input, that the Authenticode hash is unchanged.

| Flag | Meaning |
|---|---|
| `--force` | Overwrite the output file if it exists |
| `--verify` | Confirm round-trip + (signed) unchanged Authenticode hash |
| `--random-policy` | Tag with the null-policy GUID — the fixed-length filler case, so every tenant's `.exe` is the same size (useful when the download size must not reveal which tenant it is) |

### Inspect or verify an existing binary

```sh
node packaging/windows/embed-msh-windows.js --info    agent.exe          # PE + embedded-MSH summary
node packaging/windows/embed-msh-windows.js --extract agent.exe out.msh  # dump the embedded .msh
node packaging/windows/embed-msh-windows.js --hash    agent.exe          # Authenticode-stable sha384
```

The `--hash` value is the signature-stable hash (checksum + cert-table entry
zeroed, cert table excluded) — it is **not** what `Get-FileHash` /
`certutil -hashfile` report, and it does not change when you embed a `.msh`.

## Relationship to `../../../MeshCentral/exeHandler.js`

The server's `exeHandler.js` implements the same byte format but streams the
result straight into an HTTP download. This is the file-in / file-out
packaging version. Output is **byte-for-byte identical** to the server's, which
[`embed-msh-windows.test.js`](embed-msh-windows.test.js) checks against the
real reference module and against signed and unsigned PE specimens from
`../../../MeshCentral/agents`:

```sh
node packaging/windows/embed-msh-windows.test.js
```

Two intentional corrections over the reference, both confined to the
signature-stable hash of **unsigned** binaries with an embedded `.msh` (the
signed path — the one that matters here — is identical): the reference's
trailing-MSH trim never fires because it compares a lowercase hex string to an
uppercase GUID and reads the trailer length in the wrong byte order. This tool
fixes both so `--hash` is genuinely stable across embedding on unsigned
binaries too.

## Signing pipeline

```sh
# Sign + timestamp ONCE per release (on Windows, or with osslsigncode):
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 ^
  /a MeshAgent.exe

# Then, per tenant, forever, with no signing tools:
node packaging/windows/embed-msh-windows.js MeshAgent.exe tenant.msh out.exe --verify
signtool verify /pa out.exe      # still valid: the .msh is inside the cert table
```
