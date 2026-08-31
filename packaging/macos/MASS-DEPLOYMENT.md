# Deploying the Mac agent to many Macs

A guide for IT administrators. You deploy **two files**:

| File | What it is | Changes how often? |
|---|---|---|
| `<AgentName>.pkg` | The agent. Signed and notarized by us. Contains no customer settings. | Once per release |
| `<AgentName>-provision.sh` | Your organisation's settings, wrapped in a script. Plain text. | Only if your settings change |

**Install the `.pkg` first, then run the script.** That order matters.

The package on its own installs the agent but deliberately leaves it stopped,
because it does not yet know which server to talk to. The script supplies that
and starts it. Installing the package alone never fails and never breaks
anything — it just waits.

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

```sh
sudo installer -pkg <AgentName>.pkg -target /
sudo bash <AgentName>-provision.sh
echo "exit code: $?"      # 0 means success
```

## MDM with no script support

Some plain MDM "install enterprise application" commands can only send a
package — they cannot run scripts. Two options:

- **Preferred:** stage the settings file first. Have your MDM deliver your
  `.msh` to `/Library/Application Support/<CompanyName>/<AgentName>.msh`, then
  install the `.pkg`. The package picks it up automatically and starts the
  agent, no script needed.
- Otherwise, ask us for a small per-organisation settings package, which you
  deploy alongside the agent package. Either order works.

---

## Verifying a Mac by hand

```sh
sudo launchctl print system/<ServiceName> | grep -E 'state|pid'
ls -l /usr/local/mesh_services/<CompanyName>/<ServiceName>/
sudo cat /var/log/<ServiceName>-provision.log
```

You want to see `state = running` and a `pid`.

## Screen sharing needs one more thing

macOS blocks screen recording and remote control until it is explicitly
allowed, and **a script cannot grant this** — only a configuration profile
from your MDM can.

Deploy a **PPPC / Privacy Preferences Policy Control** profile granting the
agent:

- **Screen Recording**
- **Accessibility**

Without it, the agent connects and works, but remote screen viewing and
control will fail. Ask us for the profile matching your build — it is tied to
our code signature, so a generic one will not work.

You may also want a profile allowing the agent's background service, so users
do not see a "Background Items Added" notification after install.

---

## Updating to a new agent release

Deploy the new `.pkg` the same way. Existing settings on the Mac are kept
automatically, and the agent restarts on the new version. You do **not** need
to re-run the provisioning script for a version update.

Re-run the provisioning script only when your **settings** change (a new
server address, for example).

## Uninstalling

`Uninstall.command` ships next to the package. Deploy it as a script, or run
it by hand:

```sh
sudo bash Uninstall.command
```

It stops the agent, removes the whole install directory, clears its privacy
permissions, and detects whether it is already running as root — so it works
both from a deployment tool and from a Terminal window.

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
Expected. The package alone does not start the agent. Run the provisioning
script.

---

## Notes for whoever builds these files

Both artifacts come from `build-macos-pkg.js` in this folder. See
[README.md](README.md) for the full build, signing, and notarization steps.

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
