#!/usr/bin/env node
/*
 * build-macos-pkg.js
 *
 * Builds a generic, tenant-agnostic macOS installer (.pkg) for MeshAgent
 * using Apple's own `pkgbuild` + `productbuild` (Xcode Command Line Tools) --
 * the standard, currently-supported way to build a flat installer package.
 * MUST be run on macOS.
 *
 * Why not follow ../MeshCentral/macosinstaller.js or agents/MeshAgentOSXPackager.zip:
 *   - MeshAgentOSXPackager.zip is a PackageMaker-authored legacy bundle .mpkg
 *     (see its distribution.dist: authoringTool="com.apple.PackageMaker").
 *     PackageMaker was removed from Xcode over a decade ago and doesn't exist
 *     on any current Mac -- it's a static template, not a working build tool.
 *     Its format is also the bundle-style .mpkg that modern macOS
 *     (Sequoia/Tahoe) refuses to open.
 *   - macosinstaller.js hand-encodes the xar/cpio/pkg binary format in pure
 *     JS byte-by-byte. That's necessary there because it has to run inside
 *     the MeshCentral server on Linux/Windows with no Mac available. This
 *     script runs on a Mac as part of a release build, so it uses Apple's
 *     own tools instead of reimplementing their file format.
 *
 * Deployment model: one package + one script.
 *   The payload never contains a ".msh" settings file, and the postinstall
 *   NEVER fails when no configuration is present -- it installs the agent and
 *   leaves it stopped. That matters because mass-deployment tools (Jamf,
 *   Kandji, Intune, Mosyle, Munki, plain MDM) install a package first and
 *   configure it in a separate step; a non-zero exit would be reported as a
 *   failed install and retried forever.
 *
 *   The postinstall looks for a configuration in this order, first match wins:
 *     1. an already-installed "<exe>.msh"                    (upgrade/reinstall)
 *     2. "/Library/Application Support/<company>/<exe>.msh"  (staged by an MDM)
 *     3. "<exe>.msh" next to the .pkg being run              (manual install)
 *
 *   The normal path is none of those: deploy the package, then run the
 *   per-tenant provisioning script this same script can generate with
 *   --emit-provision-script. That script carries the tenant's ".msh" inside
 *   it as base64, writes it, restarts the daemon, verifies the daemon is
 *   actually running, and exits with a documented status code so the
 *   deployment tool can report success or failure accurately.
 *
 * Net effect: build + sign + notarize this .pkg exactly once per MeshAgent
 * release. Per tenant you generate one plain-text script -- no binary, no
 * certificate, no notarization:
 *   <pkgName>.pkg              <- byte-identical, already signed + notarized
 *   <exe>-provision.sh         <- that tenant's settings, unsigned, free to generate
 * See MASS-DEPLOYMENT.md in this folder for the per-tool instructions.
 *
 * Usage:
 *   node build-macos-pkg.js <path-to-agent-binary> [outputDir] [options]
 *
 * Options:
 *   --out <dir>            Same as the positional outputDir (default: ".")
 *   --company <name>       Install path / launchd naming (default: "meshagent")
 *   --service <name>       launchd label + daemon dir name (default: "meshagent")
 *   --exe <name>           Installed executable + required ".msh" name (default: "meshagent")
 *   --display-name <name>  Installer window title (default: "Mesh Agent")
 *   --pkg-name <name>      Output filename without ".pkg" (default: --exe,
 *                          else "MeshAgent" -- NOT hardcoded). Defaulting to
 *                          --exe keeps the .pkg and its required .msh
 *                          identically named: "<exe>.pkg" + "<exe>.msh".
 *   --version <x.y.z>      Package version (default: "1.0")
 *   --identifier <id>      Package identifier (default: "com.<company>.<service>",
 *                          so a rebranded build does not ship a com.meshagent.* receipt)
 *   --background <path>    Optional PNG for the installer sidebar
 *                          (e.g. ../MeshCentral/agents/macosinstallerbackground.png)
 *   --sign <identity>      "Developer ID Installer: Your Org (TEAMID)" -- signs
 *                          the product archive directly via productbuild --sign
 *                          (equivalent to signing separately with productsign
 *                          afterwards; use whichever fits your pipeline)
 *   --keep-work            Don't delete the intermediate build/ directory
 *
 * Per-tenant provisioning script (separate mode -- no binary, no signing):
 *   node build-macos-pkg.js --emit-provision-script <tenant.msh> \
 *     --out dist/ --company <name> --service <name> --exe <name>
 *   --emit-provision-script <f>  Tenant ".msh" to embed
 *   --script-name <name>         Output basename (default: --exe)
 *
 * Example:
 *   node packaging/macos/build-macos-pkg.js meshagent_universal dist/ \
 *     --background ../MeshCentral/agents/macosinstallerbackground.png \
 *     --sign "Developer ID Installer: Your Org (TEAMID)"
 *
 * Without --sign, finish signing + notarizing separately:
 *   productsign --sign "Developer ID Installer: Your Org (TEAMID)" \
 *     dist/MeshAgent.pkg dist/MeshAgent-signed.pkg
 *   xcrun notarytool submit dist/MeshAgent-signed.pkg --keychain-profile "AC_PROFILE" --wait
 *   xcrun stapler staple dist/MeshAgent-signed.pkg
 *
 * Then, per tenant (no signing tools involved, repeat forever):
 *   mkdir -p out/<tenant> && cp dist/MeshAgent-signed.pkg out/<tenant>/MeshAgent.pkg
 *   printf 'MeshName=...\r\nMeshType=...\r\nMeshID=0x...\r\nServerID=...\r\nMeshServer=wss://...\r\n' \
 *     > out/<tenant>/meshagent.msh
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

function xmlEscape(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function pkgIdentifierSegment(str) {
    return String(str).toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^-+|-+$/g, '') || 'meshagent';
}

// Sanitizes a display name / exe name into a safe .pkg filename component.
// Unlike pkgIdentifierSegment this keeps case and spaces (both fine in a
// macOS filename) and only strips characters a filesystem/path can't hold.
function pkgFileNameSegment(str) {
    return String(str).replace(/[\/:\\]/g, '-').replace(/\s+/g, ' ').trim() || 'MeshAgent';
}

// The payload never contains "<executableName>.msh". This script MUST NOT
// fail the install when no configuration is present: mass-deployment tools
// install the package first and provision it as a separate step, and a
// non-zero exit here is reported as a failed install and retried forever.
// Configuration is discovered in this order, first match wins:
//   1. an already-installed "<exe>.msh"                    (upgrade/reinstall)
//   2. "/Library/Application Support/<company>/<exe>.msh"  (staged by an MDM)
//   3. "<exe>.msh" next to the .pkg being run              (manual install)
// With none of those, the agent installs but is left stopped, to be
// provisioned later by "<exe>-provision.sh". Exit status is 0 either way.
function buildPostinstall(companyName, serviceName, executableName) {
    return `#!/bin/bash
# Tenant-agnostic postinstall. Never fails for a missing configuration.
set -u

SERVICENAME="${serviceName}"
COMPANYNAME="${companyName}"
EXECUTABLENAME="${executableName}"
INSTALLDIR="/usr/local/mesh_services/\${COMPANYNAME}/\${SERVICENAME}"
STAGEDMSH="/Library/Application Support/\${COMPANYNAME}/\${EXECUTABLENAME}.msh"
MSH="\${INSTALLDIR}/\${EXECUTABLENAME}.msh"
DAEMONPLIST="/Library/LaunchDaemons/\${SERVICENAME}.plist"
AGENTPLIST="/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist"

log() { echo "[\${SERVICENAME}] \$*"; }

mkdir -p "\${INSTALLDIR}" 2>/dev/null || true

# --- configuration discovery (first match wins) --------------------------
CONFIGSOURCE="none"
if [ -f "\${MSH}" ]; then
    CONFIGSOURCE="configuration already installed"
elif [ -f "\${STAGEDMSH}" ]; then
    if cp -f "\${STAGEDMSH}" "\${MSH}" 2>/dev/null; then
        CONFIGSOURCE="staged file \${STAGEDMSH}"
    fi
fi
if [ "\${CONFIGSOURCE}" = "none" ] && [ -n "\${1:-}" ]; then
    PKGDIR="$(cd "$(dirname "\$1")" 2>/dev/null && pwd || true)"
    if [ -n "\${PKGDIR:-}" ] && [ -f "\${PKGDIR}/\${EXECUTABLENAME}.msh" ]; then
        if cp -f "\${PKGDIR}/\${EXECUTABLENAME}.msh" "\${MSH}" 2>/dev/null; then
            CONFIGSOURCE="folder next to the installer package"
        fi
    fi
fi

# --- ownership / permissions (best effort; never abort the install) ------
chown -R root:wheel "/usr/local/mesh_services/\${COMPANYNAME}" 2>/dev/null || true
chmod 755 "\${INSTALLDIR}" 2>/dev/null || true
chmod 755 "\${INSTALLDIR}/\${EXECUTABLENAME}" 2>/dev/null || true
if [ -f "\${MSH}" ]; then
    chown root:wheel "\${MSH}" 2>/dev/null || true
    chmod 644 "\${MSH}" 2>/dev/null || true
fi
for P in "\${DAEMONPLIST}" "\${AGENTPLIST}"; do
    [ -f "\${P}" ] || continue
    chown root:wheel "\${P}" 2>/dev/null || true
    chmod 644 "\${P}" 2>/dev/null || true
done

# --- start the agent only when it is actually configured -----------------
if [ ! -f "\${MSH}" ]; then
    log "Installed successfully, but no tenant configuration was found."
    log "The agent has deliberately been left STOPPED."
    log "Provision this Mac by running \${EXECUTABLENAME}-provision.sh as root"
    log "(see MASS-DEPLOYMENT.md). Package installation itself succeeded."
    exit 0
fi

log "Configuration source: \${CONFIGSOURCE}"
/bin/launchctl bootout system "\${DAEMONPLIST}" >/dev/null 2>&1 || true
if /bin/launchctl bootstrap system "\${DAEMONPLIST}" >/dev/null 2>&1; then
    log "Daemon \${SERVICENAME} started."
elif /bin/launchctl load "\${DAEMONPLIST}" >/dev/null 2>&1; then
    log "Daemon \${SERVICENAME} started (legacy load)."
else
    log "WARNING: could not start \${SERVICENAME} now; it will start at next boot."
fi

CONSOLE_USER=$(stat -f '%Su' /dev/console 2>/dev/null || true)
CONSOLE_UID=$(id -u "\${CONSOLE_USER}" 2>/dev/null || true)
if [ -n "\${CONSOLE_UID:-}" ] && [ "\${CONSOLE_UID}" != "0" ] && [ -f "\${AGENTPLIST}" ]; then
    /bin/launchctl bootout "gui/\${CONSOLE_UID}" "\${AGENTPLIST}" >/dev/null 2>&1 || true
    /bin/launchctl bootstrap "gui/\${CONSOLE_UID}" "\${AGENTPLIST}" >/dev/null 2>&1 || true
fi
exit 0
`;
}

// Uninstaller. Usable both by a human (double-click / "sudo bash
// Uninstall.command") and by an MDM running it as root -- it re-execs itself
// under sudo only when it is not already root. Exits 0 when the agent is gone.
function buildUninstall(companyName, serviceName, executableName, identifier) {
    return `#!/bin/bash
set -u

if [ "$(id -u)" != "0" ]; then
    # Not root: re-run under sudo (interactive use). MDMs already run as root
    # and skip this branch entirely.
    exec sudo /bin/bash "\$0" "\$@"
fi

SERVICENAME="${serviceName}"
COMPANYNAME="${companyName}"
EXECUTABLENAME="${executableName}"
INSTALLDIR="/usr/local/mesh_services/\${COMPANYNAME}/\${SERVICENAME}"

echo "Stopping \${SERVICENAME}..."
/bin/launchctl bootout system "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 \\
    || /bin/launchctl unload "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 || true
/bin/launchctl remove "\${SERVICENAME}" >/dev/null 2>&1 || true
pkill -9 "\${SERVICENAME}" >/dev/null 2>&1 || true
CONSOLE_USER=$(stat -f '%Su' /dev/console 2>/dev/null || true)
CONSOLE_UID=$(id -u "\${CONSOLE_USER}" 2>/dev/null || true)
if [ -n "\${CONSOLE_UID:-}" ] && [ "\${CONSOLE_UID}" != "0" ]; then
    /bin/launchctl bootout "gui/\${CONSOLE_UID}" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" >/dev/null 2>&1 || true
fi

# The agent can start a separate diagnostic service (see meshcore/agentcore.c);
# remove it too so no orphaned daemon survives the uninstall.
for D in meshagentDiagnostic_periodicStart meshagentDiagnostic; do
    /bin/launchctl bootout system "/Library/LaunchDaemons/\${D}.plist" >/dev/null 2>&1 \\
        || /bin/launchctl unload "/Library/LaunchDaemons/\${D}.plist" >/dev/null 2>&1 || true
    rm -f "/Library/LaunchDaemons/\${D}.plist" >/dev/null 2>&1 || true
done
rm -rf "/usr/local/mesh_services/meshagentDiagnostic" >/dev/null 2>&1 || true

echo "Resetting TCC permissions for \${SERVICENAME}..."
# Bare Mach-O binaries carry a code-signing identifier, not a bundle id, so ask
# codesign for it -- "mdls kMDItemCFBundleIdentifier" returns (null) here.
SIGN_ID=$(codesign -dv "\${INSTALLDIR}/\${EXECUTABLENAME}" 2>&1 | sed -n 's/^Identifier=//p' | head -1)
for ID in "\${SIGN_ID}" "\${EXECUTABLENAME}" "\${SERVICENAME}"; do
    [ -n "\${ID}" ] || continue
    tccutil reset All "\${ID}" >/dev/null 2>&1 || true
done

# Remove the whole install directory, not a list of filenames. The agent
# creates many files beside its executable -- .db .log .msh .mshx .proxy .tag
# .update .update.exe .corereset .wlg (see the MeshAgent_MakeAbsolutePath
# calls in meshcore/agentcore.c) -- and an enumerated list silently goes stale
# as the agent gains new state files, leaving the directory behind because
# rmdir cannot remove a non-empty directory.
case "\${INSTALLDIR}" in
    /usr/local/mesh_services/?*/?*)
        rm -rf "\${INSTALLDIR}" || true
        ;;
    *)
        echo "Refusing to remove unexpected install path: \${INSTALLDIR}" >&2
        ;;
esac

rm -f "/Library/Application Support/\${COMPANYNAME}/\${EXECUTABLENAME}.msh" >/dev/null 2>&1 || true
rm -f "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 || true
rm -f "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" >/dev/null 2>&1 || true
rm -f "/var/log/\${SERVICENAME}-provision.log" >/dev/null 2>&1 || true
# Only removes these if they are empty, so a second service under the same
# company (or another company) is left untouched.
rmdir "/Library/Application Support/\${COMPANYNAME}" >/dev/null 2>&1 || true
rmdir "/usr/local/mesh_services/\${COMPANYNAME}" >/dev/null 2>&1 || true
rmdir "/usr/local/mesh_services" >/dev/null 2>&1 || true
pkgutil --forget "${identifier}" >/dev/null 2>&1 || true

# --- verify, and report honestly ----------------------------------------
# Every removal above is best-effort, so without this the script would print
# "was uninstalled" even when nothing was actually removed.
LEFTOVERS=0
for P in "\${INSTALLDIR}" \\
         "/Library/LaunchDaemons/\${SERVICENAME}.plist" \\
         "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist"; do
    if [ -e "\${P}" ]; then
        echo "WARNING: still present: \${P}" >&2
        LEFTOVERS=1
    fi
done
if /bin/launchctl print "system/\${SERVICENAME}" >/dev/null 2>&1; then
    echo "WARNING: launchd still has \${SERVICENAME} registered; a reboot clears it." >&2
    LEFTOVERS=1
fi
if pgrep -x "\${EXECUTABLENAME}" >/dev/null 2>&1; then
    echo "WARNING: a \${EXECUTABLENAME} process is still running." >&2
    LEFTOVERS=1
fi

if [ "\${LEFTOVERS}" = "0" ]; then
    echo "\${SERVICENAME} was uninstalled."
    exit 0
fi
echo "\${SERVICENAME} was only PARTIALLY uninstalled -- see the warnings above." >&2
exit 1
`;
}

// Per-tenant provisioning script. The tenant's ".msh" is carried inside the
// script as base64 (byte-exact, so CRLF line endings survive) and written to
// the installed location, then the daemon is restarted and its state verified.
//
// Feedback contract for mass-deployment tools -- every path ends in an
// explicit, documented exit code, with human-readable reasons on stdout/stderr
// (which Jamf, Kandji, Intune, Mosyle and Munki all capture) and a copy in
// /var/log/<service>-provision.log:
//   0  success: configuration installed and the agent is verified running
//   1  not run as root
//   2  agent not installed -- deploy the .pkg first
//   3  could not write the configuration
//   4  configuration written but the agent did not start
function buildProvisionScript(companyName, serviceName, executableName, mshBase64) {
    return `#!/bin/bash
#
# ${executableName} tenant provisioning script.
#
# Run this AFTER installing ${executableName}.pkg. It installs this tenant's
# configuration and starts the agent. Safe to run repeatedly (idempotent).
#
# Exit codes -- for mass-deployment reporting:
#   0  SUCCESS  configuration installed, agent verified running
#   1  ERROR    not run as root
#   2  ERROR    agent not installed (deploy ${executableName}.pkg first)
#   3  ERROR    could not write the configuration
#   4  ERROR    configuration written but the agent did not start
#
set -u

SERVICENAME="${serviceName}"
COMPANYNAME="${companyName}"
EXECUTABLENAME="${executableName}"
INSTALLDIR="/usr/local/mesh_services/\${COMPANYNAME}/\${SERVICENAME}"
AGENTBIN="\${INSTALLDIR}/\${EXECUTABLENAME}"
MSH="\${INSTALLDIR}/\${EXECUTABLENAME}.msh"
DAEMONPLIST="/Library/LaunchDaemons/\${SERVICENAME}.plist"
AGENTPLIST="/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist"
LOGFILE="/var/log/\${SERVICENAME}-provision.log"

# Seconds to wait for the .pkg to finish installing, for deployment tools that
# do not strictly order "install package" before "run script". 0 disables.
WAIT_FOR_AGENT="\${MESH_WAIT_FOR_AGENT:-30}"

_stamp() { date '+%Y-%m-%d %H:%M:%S'; }
# The redirect is placed on the group, not the echo: a failing ">>" is reported
# by the shell itself, so "echo ... 2>/dev/null" would still leak "Permission
# denied" onto stderr and make a successful run look like a failed one.
_tolog() { { printf '%s\\n' "\$1" >> "\${LOGFILE}"; } 2>/dev/null || true; }
log() {
    MSG="$(_stamp) [\${SERVICENAME}] \$*"
    echo "\${MSG}"
    _tolog "\${MSG}"
}
die() {
    CODE="\$1"; shift
    MSG="$(_stamp) [\${SERVICENAME}] ERROR(\${CODE}): \$*"
    echo "\${MSG}" >&2
    _tolog "\${MSG}"
    exit "\${CODE}"
}

if [ "$(id -u)" != "0" ]; then
    die 1 "must run as root (use: sudo bash \$0)"
fi

# --- 1. the package must already be installed ----------------------------
WAITED=0
while [ ! -x "\${AGENTBIN}" ] && [ "\${WAITED}" -lt "\${WAIT_FOR_AGENT}" ]; do
    [ "\${WAITED}" = "0" ] && log "Waiting up to \${WAIT_FOR_AGENT}s for \${EXECUTABLENAME}.pkg to finish installing..."
    sleep 1
    WAITED=$((WAITED + 1))
done
[ -x "\${AGENTBIN}" ] || die 2 "agent not installed at \${AGENTBIN} -- deploy \${EXECUTABLENAME}.pkg before running this script"
[ -f "\${DAEMONPLIST}" ] || die 2 "launch daemon missing at \${DAEMONPLIST} -- the .pkg did not install correctly"

# --- 2. write this tenant's configuration --------------------------------
mkdir -p "\${INSTALLDIR}" 2>/dev/null || true
TMPMSH="$(mktemp "\${TMPDIR:-/tmp}/\${EXECUTABLENAME}.msh.XXXXXX")" || die 3 "could not create a temporary file"
if ! /usr/bin/base64 -D > "\${TMPMSH}" 2>/dev/null <<'MSH_B64'
${mshBase64}
MSH_B64
then
    rm -f "\${TMPMSH}"
    die 3 "could not decode the embedded configuration"
fi
[ -s "\${TMPMSH}" ] || { rm -f "\${TMPMSH}"; die 3 "the embedded configuration is empty"; }

if [ -f "\${MSH}" ] && cmp -s "\${TMPMSH}" "\${MSH}"; then
    log "Configuration already up to date."
    CHANGED=0
else
    cat "\${TMPMSH}" > "\${MSH}" || { rm -f "\${TMPMSH}"; die 3 "could not write \${MSH}"; }
    log "Configuration written to \${MSH}."
    CHANGED=1
fi
rm -f "\${TMPMSH}"
chown root:wheel "\${MSH}" 2>/dev/null || true
chmod 644 "\${MSH}" 2>/dev/null || true

# --- 3. (re)start the agent ----------------------------------------------
is_running() {
    /bin/launchctl print "system/\${SERVICENAME}" 2>/dev/null \\
        | grep -qE '^[[:space:]]*(state = running|pid = [0-9]+)'
}

if [ "\${CHANGED}" = "1" ] || ! is_running; then
    log "Starting \${SERVICENAME}..."
    /bin/launchctl bootout system "\${DAEMONPLIST}" >/dev/null 2>&1 || true
    /bin/launchctl bootstrap system "\${DAEMONPLIST}" >/dev/null 2>&1 \\
        || /bin/launchctl load "\${DAEMONPLIST}" >/dev/null 2>&1 || true
else
    log "\${SERVICENAME} already running with this configuration."
fi

# --- 4. verify, so the exit code reflects reality ------------------------
TRIES=0
while ! is_running && [ "\${TRIES}" -lt 15 ]; do sleep 1; TRIES=$((TRIES + 1)); done
if ! is_running; then
    die 4 "configuration installed but \${SERVICENAME} is not running. Inspect: launchctl print system/\${SERVICENAME}"
fi

# Login-session agent (screen sharing / KVM). Best effort: it only exists once
# a user is logged in, and its absence is not a provisioning failure.
CONSOLE_USER=$(stat -f '%Su' /dev/console 2>/dev/null || true)
CONSOLE_UID=$(id -u "\${CONSOLE_USER}" 2>/dev/null || true)
if [ -n "\${CONSOLE_UID:-}" ] && [ "\${CONSOLE_UID}" != "0" ] && [ -f "\${AGENTPLIST}" ]; then
    /bin/launchctl bootout "gui/\${CONSOLE_UID}" "\${AGENTPLIST}" >/dev/null 2>&1 || true
    /bin/launchctl bootstrap "gui/\${CONSOLE_UID}" "\${AGENTPLIST}" >/dev/null 2>&1 || true
    log "Login-session agent (re)started for \${CONSOLE_USER}."
fi

log "SUCCESS: \${SERVICENAME} is configured and running."
exit 0
`;
}

function buildLaunchDaemonPlist(companyName, serviceName, executableName) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${serviceName}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/mesh_services/${companyName}/${serviceName}/${executableName}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/usr/local/mesh_services/${companyName}/${serviceName}/</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>1</integer>
  </dict>
</plist>
`;
}

function buildLaunchAgentPlist(companyName, serviceName, executableName) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${serviceName}-launchagent</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/mesh_services/${companyName}/${serviceName}/${executableName}</string>
      <string>-kvmagent</string>
    </array>
    <key>LimitLoadToSessionType</key>
    <array>
      <string>LoginWindow</string>
      <string>Aqua</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/usr/local/mesh_services/${companyName}/${serviceName}/</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

/**
 * Builds a generic (no .msh baked in) macOS installer package via the
 * native `pkgbuild` + `productbuild` toolchain.
 *
 * @param {object} opts
 * @param {string} opts.agentPath        Path to the compiled meshagent binary
 * @param {string} opts.outDir           Where to write "<pkgName>.pkg" + Uninstall.command
 * @param {string} [opts.companyName]    Default: "meshagent"
 * @param {string} [opts.serviceName]    Default: "meshagent"
 * @param {string} [opts.executableName] Default: "meshagent"
 * @param {string} [opts.displayName]    Default: "Mesh Agent"
 * @param {string} [opts.pkgName]        Output filename (without ".pkg"). Default:
 *                                       opts.executableName, else "MeshAgent"
 * @param {string} [opts.identifier]     Package identifier. Default: "com.<company>.<service>"
 * @param {string} [opts.version]        Default: "1.0"
 * @param {string} [opts.backgroundPath] Optional PNG for the installer sidebar
 * @param {string} [opts.signIdentity]   "Developer ID Installer: ..." -- passed to productbuild --sign
 * @param {boolean} [opts.keepWork]      Don't delete the intermediate build/ dir
 * @returns {Promise<{pkgPath: string, uninstallPath: string, workDir: string}>}
 */
async function buildMacOSInstaller(opts) {
    if (process.platform !== 'darwin') { throw new Error('pkgbuild/productbuild only exist on macOS; run this on a Mac.'); }

    const companyName = opts.companyName || 'meshagent';
    const serviceName = opts.serviceName || 'meshagent';
    const executableName = opts.executableName || 'meshagent';
    const displayName = opts.displayName || 'Mesh Agent';
    const version = opts.version || '1.0';
    // Derived from --company/--service so a rebranded product does not ship a
    // "com.meshagent.*" receipt. This is the pkgutil receipt and upgrade key.
    const identifier = opts.identifier
        || ('com.' + pkgIdentifierSegment(companyName) + '.' + pkgIdentifierSegment(serviceName));
    // Uses the RAW (pre-default) opts here so an uncustomized run still
    // produces "MeshAgent.pkg", while --exe (or an explicit --pkg-name)
    // renames the output file to match. Deliberately does NOT fall back to
    // --display-name: that is a human-facing title ("Mesh Agent") and would
    // put a space in the filename, and the .pkg is meant to sit next to a
    // "<exe>.msh" -- deriving both from --exe keeps the pair named alike.
    const pkgFileName = pkgFileNameSegment(opts.pkgName || opts.executableName || 'MeshAgent') + '.pkg';

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meshagent-macos-pkg-'));
    try {
        const rootDir = path.join(workDir, 'root');
        const scriptsDir = path.join(workDir, 'scripts');
        const resourcesDir = path.join(workDir, 'resources');
        const installDir = path.join(rootDir, 'usr', 'local', 'mesh_services', companyName, serviceName);
        const launchDaemons = path.join(rootDir, 'Library', 'LaunchDaemons');
        const launchAgents = path.join(rootDir, 'Library', 'LaunchAgents');

        await fsp.mkdir(installDir, { recursive: true });
        await fsp.mkdir(launchDaemons, { recursive: true });
        await fsp.mkdir(launchAgents, { recursive: true });
        await fsp.mkdir(scriptsDir, { recursive: true });
        await fsp.mkdir(resourcesDir, { recursive: true });

        // Payload: deliberately no "<executableName>.msh" (see buildPostinstall).
        await fsp.copyFile(opts.agentPath, path.join(installDir, executableName));
        await fsp.chmod(path.join(installDir, executableName), 0o755);
        await fsp.writeFile(path.join(launchDaemons, serviceName + '.plist'), buildLaunchDaemonPlist(companyName, serviceName, executableName));
        await fsp.writeFile(path.join(launchAgents, serviceName + '-launchagent.plist'), buildLaunchAgentPlist(companyName, serviceName, executableName));

        await fsp.writeFile(path.join(scriptsDir, 'postinstall'), buildPostinstall(companyName, serviceName, executableName));
        await fsp.chmod(path.join(scriptsDir, 'postinstall'), 0o755);

        // Resources for the product archive (welcome text, optional background).
        // This is the pane a human sees when double-clicking the .pkg, so it has
        // to describe what actually happens -- including that a missing
        // configuration is NOT an error any more.
        const welcomeText = 'Welcome to the ' + displayName + ' installer\n\n'
            + 'This installs ' + displayName + ' on this Mac. Once it is configured, an\n'
            + 'administrator can remotely monitor and control this computer over the\n'
            + 'internet.\n\n'
            + 'Configuration is supplied separately from this package. The installer\n'
            + 'looks for a "' + executableName + '.msh" settings file in this order:\n\n'
            + '  1. One already installed on this Mac -- an existing configuration is\n'
            + '     kept as-is, so upgrading does not disturb it\n'
            + '  2. /Library/Application Support/' + companyName + '/' + executableName + '.msh\n'
            + '  3. "' + executableName + '.msh" placed next to this installer package\n\n'
            + 'If none is found, the agent is installed but deliberately left stopped\n'
            + 'and installation still succeeds. An administrator can configure it\n'
            + 'afterwards by running "' + executableName + '-provision.sh" as root.\n\n'
            + 'This software is provided under Apache 2.0 license.\n';
        await fsp.writeFile(path.join(resourcesDir, 'welcome.txt'), welcomeText);
        let backgroundFileName = null;
        if (opts.backgroundPath) {
            backgroundFileName = 'background' + path.extname(opts.backgroundPath);
            await fsp.copyFile(opts.backgroundPath, path.join(resourcesDir, backgroundFileName));
        }

        // 1) pkgbuild: turn root+scripts into one component package.
        const componentPkg = path.join(workDir, 'component.pkg');
        await execFileP('pkgbuild', [
            '--root', rootDir,
            '--scripts', scriptsDir,
            '--identifier', identifier,
            '--version', version,
            '--install-location', '/',
            componentPkg
        ]);

        // 2) productbuild: wrap the component package into a distributable
        //    product archive (adds the welcome screen / background / title).
        const distributionPath = path.join(workDir, 'Distribution.xml');
        const distribution = '<?xml version="1.0" encoding="utf-8"?>\n'
            + '<installer-script minSpecVersion="1.000000">\n'
            + '    <title>' + xmlEscape(displayName) + '</title>\n'
            + '    <options customize="always" allow-external-scripts="no" rootVolumeOnly="true"/>\n'
            + (backgroundFileName ? '    <background file="' + xmlEscape(backgroundFileName) + '" alignment="topleft" scaling="tofit"/>\n' : '')
            + '    <welcome file="welcome.txt" mime-type="text/plain"/>\n'
            + '    <choices-outline>\n'
            + '        <line choice="' + xmlEscape(identifier) + '"/>\n'
            + '    </choices-outline>\n'
            + '    <choice id="' + xmlEscape(identifier) + '" title="' + xmlEscape(displayName) + '" visible="false">\n'
            + '        <pkg-ref id="' + xmlEscape(identifier) + '"/>\n'
            + '    </choice>\n'
            + '    <pkg-ref id="' + xmlEscape(identifier) + '" version="' + xmlEscape(version) + '" onConclusion="none">component.pkg</pkg-ref>\n'
            + '    <options hostArchitectures="arm64,x86_64"/>\n'
            + '</installer-script>\n';
        await fsp.writeFile(distributionPath, distribution);

        await fsp.mkdir(opts.outDir, { recursive: true });
        const pkgPath = path.join(opts.outDir, pkgFileName);
        const productbuildArgs = [
            '--distribution', distributionPath,
            '--resources', resourcesDir,
            '--package-path', workDir
        ];
        if (opts.signIdentity) { productbuildArgs.push('--sign', opts.signIdentity); }
        productbuildArgs.push(pkgPath);
        await execFileP('productbuild', productbuildArgs);

        const uninstallPath = path.join(opts.outDir, 'Uninstall.command');
        await fsp.writeFile(uninstallPath, buildUninstall(companyName, serviceName, executableName, identifier), { mode: 0o755 });

        return { pkgPath: pkgPath, uninstallPath: uninstallPath, workDir: workDir };
    } finally {
        if (!opts.keepWork) { await fsp.rm(workDir, { recursive: true, force: true }); }
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Writes a per-tenant provisioning script that carries the given ".msh"
 * inside it. No agent binary and no signing tools are involved: this is the
 * cheap, repeatable, per-tenant half of the "one signed package + one script"
 * deployment model.
 *
 * @param {object} opts
 * @param {string} opts.mshPath          Tenant ".msh" to embed
 * @param {string} opts.outDir           Where to write "<name>-provision.sh"
 * @param {string} [opts.companyName]    Must match the package (default "meshagent")
 * @param {string} [opts.serviceName]    Must match the package (default "meshagent")
 * @param {string} [opts.executableName] Must match the package (default "meshagent")
 * @param {string} [opts.scriptName]     Output basename without "-provision.sh"
 * @returns {Promise<{scriptPath: string, warnings: string[]}>}
 */
async function buildProvisionScriptFile(opts) {
    const companyName = opts.companyName || 'meshagent';
    const serviceName = opts.serviceName || 'meshagent';
    const executableName = opts.executableName || 'meshagent';

    const raw = await fsp.readFile(opts.mshPath);
    const warnings = [];
    if (raw.length === 0) { throw new Error('The .msh file is empty: ' + opts.mshPath); }

    // Validate before deployment rather than discovering it on 500 Macs.
    const text = raw.toString('utf8');
    const missing = ['MeshServer', 'MeshID', 'ServerID'].filter(function (key) {
        return !(new RegExp('^[ \\t]*' + key + '=', 'm')).test(text);
    });
    if (missing.length) { warnings.push('.msh has no ' + missing.join(', ') + ' line(s) -- the agent may not be able to connect.'); }
    if (text.indexOf('\r\n') === -1) { warnings.push('.msh does not use CRLF line endings; MeshCentral-generated files do.'); }

    // base64 keeps the bytes exact, so CRLF and any encoding survive being
    // carried through a shell here-doc.
    const mshBase64 = (raw.toString('base64').match(/.{1,76}/g) || []).join('\n');

    await fsp.mkdir(opts.outDir, { recursive: true });
    const scriptPath = path.join(opts.outDir, pkgFileNameSegment(opts.scriptName || executableName) + '-provision.sh');
    await fsp.writeFile(scriptPath, buildProvisionScript(companyName, serviceName, executableName, mshBase64));
    await fsp.chmod(scriptPath, 0o755);
    return { scriptPath: scriptPath, warnings: warnings };
}

function parseArgs(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') { opts.out = argv[++i]; }
        else if (a === '--company') { opts.companyName = argv[++i]; }
        else if (a === '--service') { opts.serviceName = argv[++i]; }
        else if (a === '--exe') { opts.executableName = argv[++i]; }
        else if (a === '--display-name') { opts.displayName = argv[++i]; }
        else if (a === '--pkg-name') { opts.pkgName = argv[++i]; }
        else if (a === '--version') { opts.version = argv[++i]; }
        else if (a === '--background') { opts.backgroundPath = argv[++i]; }
        else if (a === '--identifier') { opts.identifier = argv[++i]; }
        else if (a === '--sign') { opts.signIdentity = argv[++i]; }
        else if (a === '--emit-provision-script') { opts.emitProvision = argv[++i]; }
        else if (a === '--script-name') { opts.scriptName = argv[++i]; }
        else if (a === '--keep-work') { opts.keepWork = true; }
        else if (a === '--help' || a === '-h') { opts.help = true; }
        else { opts._.push(a); }
    }
    return opts;
}

function printHelp() {
    console.log([
        'Usage: node build-macos-pkg.js <path-to-agent-binary> [outputDir] [options]',
        '',
        'Options:',
        '  --out <dir>            Output directory (default: ".")',
        '  --company <name>       Default: "meshagent"',
        '  --service <name>       Default: "meshagent"',
        '  --exe <name>           Default: "meshagent"',
        '  --display-name <name>  Default: "Mesh Agent"',
        '  --pkg-name <name>      Output filename without ".pkg". Default: --exe,',
        '                         else "MeshAgent"',
        '  --version <x.y.z>      Default: "1.0"',
        '  --identifier <id>      Package id (default: "com.<--company>.<--service>")',
        '  --background <path>    Optional PNG for the installer sidebar',
        '  --sign <identity>      "Developer ID Installer: Your Org (TEAMID)"',
        '  --keep-work             Keep the intermediate build/ directory (debugging)',
        '',
        'Per-tenant provisioning script (no agent binary or signing needed):',
        '  node build-macos-pkg.js --emit-provision-script <tenant.msh> [options]',
        '',
        '  --emit-provision-script <f>  Tenant .msh to embed in the script',
        '  --script-name <name>         Output basename (default: --exe)',
        '  (also honours --out, --company, --service, --exe -- these MUST match',
        '   the values the .pkg was built with)',
        '',
        'The resulting .pkg contains NO tenant .msh and never fails for a missing',
        'one. Deploy the package, then run the provisioning script as root:',
        '  dist/SonarSightAgent.pkg              <- signed + notarized once per release',
        '  dist/SonarSightAgent-provision.sh     <- per tenant, plain text, no signing',
        'See MASS-DEPLOYMENT.md for Jamf / Kandji / Intune / Mosyle / Munki steps.',
        '',
        'Requires macOS with Xcode Command Line Tools (pkgbuild, productbuild).'
    ].join('\n'));
}

async function main() {
    const argv = process.argv.slice(2);
    const opts = parseArgs(argv);
    if (opts.help) { printHelp(); process.exit(0); return; }

    if (opts.emitProvision) {
        const mshPath = path.resolve(opts.emitProvision);
        await fsp.access(mshPath).catch(function () { throw new Error('.msh file not found: ' + mshPath); });
        const emitted = await buildProvisionScriptFile({
            mshPath: mshPath,
            outDir: path.resolve(opts.out || opts._[0] || '.'),
            companyName: opts.companyName,
            serviceName: opts.serviceName,
            executableName: opts.executableName,
            scriptName: opts.scriptName
        });
        emitted.warnings.forEach(function (w) { console.warn('WARNING: ' + w); });
        console.log('Wrote ' + emitted.scriptPath);
        console.log('');
        console.log('Deploy the .pkg first, then run this script as root. Exit codes:');
        console.log('  0 success   1 not root   2 pkg not installed   3 config write failed   4 agent did not start');
        return;
    }

    if (opts._.length === 0) { printHelp(); process.exit(1); return; }

    const agentPath = path.resolve(opts._[0]);
    const outDir = path.resolve(opts.out || opts._[1] || '.');

    await fsp.access(agentPath).catch(() => { throw new Error('Agent binary not found: ' + agentPath); });

    const result = await buildMacOSInstaller({
        agentPath: agentPath,
        outDir: outDir,
        companyName: opts.companyName,
        serviceName: opts.serviceName,
        executableName: opts.executableName,
        displayName: opts.displayName,
        pkgName: opts.pkgName,
        version: opts.version,
        backgroundPath: opts.backgroundPath ? path.resolve(opts.backgroundPath) : undefined,
        identifier: opts.identifier,
        signIdentity: opts.signIdentity,
        keepWork: opts.keepWork
    });

    const stat = await fsp.stat(result.pkgPath);
    const q = function (p) { return '"' + p.replace(/"/g, '\\"') + '"'; };
    const signedPath = result.pkgPath.replace(/\.pkg$/, '-signed.pkg');
    console.log('Wrote ' + result.pkgPath + ' (' + stat.size + ' bytes)' + (opts.signIdentity ? ' [signed]' : ' [unsigned]'));
    console.log('Wrote ' + result.uninstallPath);
    if (!opts.signIdentity) {
        console.log('');
        console.log('This package is UNSIGNED. Next steps:');
        console.log('  productsign --sign "Developer ID Installer: Your Org (TEAMID)" \\');
        console.log('    ' + q(result.pkgPath) + ' ' + q(signedPath));
        console.log('  xcrun notarytool submit ' + q(signedPath) + ' --keychain-profile "AC_PROFILE" --wait');
        console.log('  xcrun stapler staple ' + q(signedPath));
    }
    console.log('');
    console.log('This package contains no tenant configuration and will not fail without one.');
    console.log('Generate a per-tenant provisioning script (no signing required):');
    console.log('  node ' + path.basename(__filename) + ' --emit-provision-script <tenant.msh> \\');
    console.log('    --out <dir> --company ' + (opts.companyName || 'meshagent')
        + ' --service ' + (opts.serviceName || 'meshagent')
        + ' --exe ' + (opts.executableName || 'meshagent'));
}

if (require.main === module) {
    main().catch(function (e) { console.error(e.message || e); process.exit(1); });
}

module.exports = { buildMacOSInstaller: buildMacOSInstaller, buildProvisionScriptFile: buildProvisionScriptFile };
