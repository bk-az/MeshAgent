# Deploying the Mac agent to many Macs

A guide for IT administrators. Your download is a disk image holding these
files; open it and they appear in a Finder window:

| File | What it is | Changes how often? |
|---|---|---|
| `<AgentName>.pkg` | The agent. Signed and notarized by us. Contains no customer settings. | Once per release |
| `<AgentName>.msh` | Your organisation's settings, as a bare file. Opened from the disk image, the package reads it from beside itself and starts the agent. An MDM that can deliver files but not run scripts stages it at `/Library/Application Support/<CompanyName>/` before the package installs. | Only if your settings change |
| `<AgentName>-provision.sh` | The same settings, wrapped in a script for tools that run a post-install script. Plain text. | Only if your settings change |
| `<AgentName>-PPPC.mobileconfig` | Configuration profile that pre-approves the agent's privacy permissions (remote control, Full Disk Access). Deployed through your MDM. | Once per release |
| `<AgentName>-Uninstall.pkg` | Removes the agent. Signed and notarized, so it can be double-clicked. | Once per release |
| `Uninstall.command` | The same uninstaller as a script, for deployment tools. | Once per release |

**The package has to be given its settings** in one of three ways: it is
opened from the disk image with the `.msh` beside it, the `.msh` was staged
before it installs, or the script runs after it. Without any of those, the
package installs the agent but deliberately leaves it stopped, because it does
not yet know which server to talk to. Installing the package alone never fails
and never breaks anything — it just waits. The profile can go out before or
after; see [Screen sharing needs one more thing](#screen-sharing-needs-one-more-thing).

> Why a disk image: macOS attributes installer scripts to the package's
> signing team, which has no access to Downloads, Desktop or Documents, so a
> package copied into one of those folders cannot read a settings file next
> to it. A mounted image sits under `/Volumes`, which is not protected.

> **Which package do I use?** There is one package per Mac processor type.
> Run `uname -m` on a target Mac: `arm64` (Apple Silicon) or `x86_64` (Intel).
> Use the matching package. Most deployment tools can pick automatically with a
> smart group; if in doubt, deploy both and let each Mac take the one it needs.

---

## How you know it worked

The provisioning script is what reports success or failure to your deployment
tool. It exits with a standard code, and your tool reads that code:

| Exit code | Meaning | What to do |
|---|---|---|
| **0** | Success — settings installed and the agent is confirmed running | Nothing |
| **1** | Not run as root | Run it as root / with elevated privileges |
| **2** | Agent is not installed | Deploy the `.pkg` first, then re-run |
| **3** | Could not write the settings file | Check disk space and that the Mac's disk is not full or read-only |
| **4** | Settings installed but the agent would not start | See [Troubleshooting](#troubleshooting) |

Anything other than `0` is a failure and your tool will report it as such.

The script does not just assume success — it asks launchd whether the agent is
actually running before exiting `0`. It is also safe to run repeatedly: if the
settings are already correct and the agent is already running, it changes
nothing and exits `0`.

Every run also appends to a log on the Mac, which is the first place to look:

```
/var/log/<ServiceName>-provision.log
```

---

## Jamf Pro

1. **Upload the package.** *Settings → Computer Management → Packages → New*,
   upload `<AgentName>.pkg`.
2. **Upload the script.** *Settings → Computer Management → Scripts → New*,
   paste in the contents of `<AgentName>-provision.sh`. Set **Priority: After**.
3. **Create one policy** containing both:
   - *Packages* → add the `.pkg` (Action: Install)
   - *Scripts* → add the script, Priority **After**
4. Scope it, and set the trigger you want (Enrollment Complete, Recurring
   Check-in, or Self Service).

Jamf runs the package first and the script second, and reports the policy as
failed if the script returns non-zero. Script output appears in the policy log.

> Jamf passes its own arguments to scripts (`$1` is the mount point). The
> provisioning script ignores all arguments, so this is harmless.

## Kandji

1. *Library → Add New Item → Custom App*.
2. Upload `<AgentName>.pkg`, **Audit & Enforce** or **Install Once**.
3. Under **Post-install script**, paste the contents of
   `<AgentName>-provision.sh`.
4. Assign to a Blueprint.

Kandji ties the post-install script to the app install, so ordering is
guaranteed. A non-zero exit shows the item as failed.

## Microsoft Intune

1. *Apps → macOS → Add → macOS app (PKG)*.
2. Upload `<AgentName>.pkg`.
3. On the **Pre/post-install scripts** step, paste the contents of
   `<AgentName>-provision.sh` into **Post-install script**.
4. Assign to a group.

Use the PKG app's built-in post-install script, **not** a separate
*Devices → Scripts* item. A standalone platform script runs on its own
schedule and may run before the app is installed. (If you must use one, the
script waits up to 30 seconds for the package — set `MESH_WAIT_FOR_AGENT` to
a larger number of seconds at the top of the script to wait longer.)

> Intune requires the `.pkg` to be signed with a Developer ID Installer
> certificate. Ours is.

## Mosyle

1. *Management → Custom Commands / Apps & Books* → upload `<AgentName>.pkg` as
   a custom package.
2. Add a **Custom Command** (shell script) with the contents of
   `<AgentName>-provision.sh`, scheduled to run after the package install.

## Munki

1. Import the package: `munkiimport <AgentName>.pkg`
2. Edit the resulting pkginfo and add the provisioning script as a
   `postinstall_script` (paste the whole script as the string value).

Munki runs `postinstall_script` after the item installs, and records a failure
if it exits non-zero.

## Any other tool, or by hand

Installed from the mounted disk image there is nothing to run afterwards —
the installer reads the `.msh` beside the package and starts the agent:

```sh
sudo installer -pkg /Volumes/<VolumeName>/<AgentName>.pkg -target /
```

If the package was installed from a copy elsewhere, provision it afterwards:

```sh
sudo bash <AgentName>-provision.sh
echo "exit code: $?"      # 0 means success
```

## MDM with no script support

Some plain MDM "install enterprise application" commands can only send a
package — they cannot run scripts. Stage the settings file instead: have your
MDM deliver `<AgentName>.msh` from your download to
`/Library/Application Support/<CompanyName>/<AgentName>.msh`, then install the
`.pkg`. The package picks it up automatically and starts the agent, no script
needed.

If your MDM can only deliver packages, wrap the `.msh` in one of your own and
deploy that first:

```sh
mkdir -p "settings/Library/Application Support/<CompanyName>"
cp <AgentName>.msh "settings/Library/Application Support/<CompanyName>/"
pkgbuild --root settings --identifier com.example.<agentname>-settings --version 1 <AgentName>-settings.pkg
```

Should it land after the agent package instead, reinstall the agent package:
reinstalling keeps an existing configuration and picks up a staged one.

---

## Verifying a Mac by hand

```sh
sudo launchctl print system/<ServiceName> | grep -E 'state|pid'
ls -l /usr/local/mesh_services/<CompanyName>/<ServiceName>/
sudo cat /var/log/<ServiceName>-provision.log
```

You want to see `state = running` and a `pid`.

## Screen sharing needs one more thing

macOS blocks remote control and access to protected files until it is
explicitly allowed, and **a script or package cannot grant this** — only a
configuration profile delivered by your MDM can. Installing the profile by
double-clicking it or with `profiles install` does **not** work: macOS refuses
it with a profile-installation error, because this kind of payload may only
come from an MDM.

Deploy `<AgentName>-PPPC.mobileconfig` as a **device-level (computer)
profile**:

| Tool | Where |
|---|---|
| Jamf Pro | *Computers → Configuration Profiles → Upload*, then scope it |
| Kandji | *Library → Add New Item → Custom Profile*, assign to the Blueprint |
| Microsoft Intune | *Devices → macOS → Configuration profiles → Create → Templates → Custom*, upload the file |
| Mosyle | *Management → Custom Profiles* (or *Privacy Preferences*) |
| Munki | Cannot install it. Munki has no MDM channel, so deliver the profile with whatever MDM enrolled the Mac |

It grants the agent, and only the agent:

- **Accessibility** and **event posting** — remote mouse and keyboard control
- **Full Disk Access** — remote file management in protected folders
- **Screen Recording**: Apple does not let any profile grant this one. The
  profile does the most it can: a **standard user** can switch it on in
  *System Settings → Privacy & Security → Screen Recording* without an
  administrator password. The first remote screen session on each Mac will
  prompt the signed-in user to do so.
- **Background Items** — approves the agent's background service, so users
  do not see a "Background Items Added" notification after install.

Without the profile, the agent connects and works, but remote screen viewing
and control fail until a local administrator approves each permission by hand.

The profile is tied to the code signature and install path of the agent build
it ships with, so a profile from a different vendor, or a hand-edited one,
will not match. Use the one that came with your package, and take the new one
when you take a new release (the identifiers inside are stable, so your MDM
updates the existing profile in place).

---

## Updating to a new agent release

Deploy the new `.pkg` the same way. Existing settings on the Mac are kept
automatically, and the agent restarts on the new version. You do **not** need
to re-run the provisioning script for a version update.

Re-run the provisioning script only when your **settings** change (a new
server address, for example).

## Uninstalling

Two forms of the same uninstaller ship next to the package. By hand, open the
disk image and double-click `<AgentName>-Uninstall.pkg`: it is signed and
notarized like the agent package, so Gatekeeper lets it run, and Installer asks
for the administrator password. (A double-clicked `Uninstall.command` ends in
"Apple could not verify" on macOS 15 and later; shell scripts cannot be
notarized.) From a deployment tool, deploy the package, or run the script as
root:

```sh
sudo bash Uninstall.command
```

Either way it stops the agent, removes the whole install directory, clears its
privacy permissions, and detects whether it is already running as root — so
the script works both from a deployment tool and from a Terminal window.

It reports its result the same way the provisioning script does, so your tool
can tell a real uninstall from a failed one:

| Exit code | Meaning |
|---|---|
| **0** | Fully removed — nothing left behind |
| **1** | Partially removed — it prints a `WARNING:` line naming each item that survived |

A `1` usually means a file was locked or the agent was still running. Re-run
it, and if it still fails, reboot and run it once more.

---

## Troubleshooting

**Exit code 2 — "agent not installed"**
The package did not install, or the script ran first. Confirm the package
installed (`ls /usr/local/mesh_services/`), and check that your tool runs the
package before the script.

**Exit code 4 — "agent did not start"**
Usually the wrong processor architecture: an Apple Silicon package on an Intel
Mac, or the reverse. The package installs without complaint but the agent
cannot run. Check with:

```sh
uname -m
lipo -archs /usr/local/mesh_services/<CompanyName>/<ServiceName>/<AgentName>
```

Those two must match. If they do, check `/var/log/install.log` and
`sudo launchctl print system/<ServiceName>`.

**Agent runs but never appears on the server**
The settings are wrong, not the deployment. Check the server address is
reachable from the Mac's network, then confirm the installed settings:

```sh
sudo cat /usr/local/mesh_services/<CompanyName>/<ServiceName>/<AgentName>.msh
```

**Install succeeded but the agent is stopped, and no script ran**
Expected when the package was installed from a copy outside the disk image
and no `.msh` was staged. `/var/log/install.log` shows what the installer
found as `Configuration source:`. Run the provisioning script, or reinstall
the package from the mounted image.

---

## Notes for whoever builds these files

The agent `.pkg`, the uninstall `.pkg`, the profile and `Uninstall.command`
come from `build-macos-pkg.js` in this folder; the `.msh` is the tenant's settings file as the server
generates it, and the provisioning script is built from that same file. The
disk image that carries them to the admin is produced by whoever hands the
files over (AssetSonar builds a plain ISO 9660 image server-side, which macOS
mounts under a `.dmg` name). See [README.md](README.md) for the full build,
signing, and notarization steps.
The `.pkg` build also writes `<AgentName>-PPPC.mobileconfig` beside it; the
profile can be regenerated alone with `--emit-pppc-profile <agent-binary>` and
the same naming flags.

```sh
# Once per release, per architecture — then sign and notarize:
node build-macos-pkg.js meshagent_osx-arm-64 dist/arm64 \
  --company AssetSonar --service SonarSightAgent --exe SonarSightAgent \
  --display-name "Sonar Sight" --version 1.2.3

# Once per customer — plain text, no certificates, no notarization:
node build-macos-pkg.js --emit-provision-script tenant.msh --out dist/acme \
  --company AssetSonar --service SonarSightAgent --exe SonarSightAgent
```

`--company`, `--service` and `--exe` **must be identical** in both commands,
or the script will look for the agent in the wrong place and exit `2`.
