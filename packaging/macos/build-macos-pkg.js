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
 * What's different from MeshCentral's package for multi-tenant use:
 *   The payload never contains a ".msh" settings file. The postinstall
 *   script instead requires a "<executableName>.msh" to be present in the
 *   SAME FOLDER as the .pkg being run (installer always passes the pkg's
 *   own path as $1 to pre/postinstall scripts) and copies it into place
 *   before the agent daemon is (re)started. Missing it fails the install
 *   loudly instead of installing a non-functional agent.
 *
 * Net effect: build + sign + notarize this .pkg exactly once per MeshAgent
 * release. Provisioning a tenant afterwards is just:
 *   <tenant folder>/<pkgName>.pkg     <- byte-identical, already-signed/notarized
 *   <tenant folder>/<executableName>.msh   <- that tenant's settings, unsigned, free to generate
 * copied or zipped together. No re-signing, no re-notarizing, per tenant.
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
 *   --background <path>    Optional PNG for the installer sidebar
 *                          (e.g. ../MeshCentral/agents/macosinstallerbackground.png)
 *   --sign <identity>      "Developer ID Installer: Your Org (TEAMID)" -- signs
 *                          the product archive directly via productbuild --sign
 *                          (equivalent to signing separately with productsign
 *                          afterwards; use whichever fits your pipeline)
 *   --keep-work            Don't delete the intermediate build/ directory
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

// The payload never contains "<executableName>.msh". $1, passed by
// /usr/sbin/installer, is the full path to this .pkg itself; its directory
// is where a tenant's "<exe>.msh" is expected to sit alongside it.
function buildPostinstall(companyName, serviceName, executableName) {
    return `#!/bin/bash
set -e

SERVICENAME="${serviceName}"
COMPANYNAME="${companyName}"
EXECUTABLENAME="${executableName}"
INSTALLDIR="/usr/local/mesh_services/\${COMPANYNAME}/\${SERVICENAME}"

# --- tenant provisioning -------------------------------------------------
# This package ships with no .msh baked in. A "<EXECUTABLENAME>.msh" must be
# present next to the .pkg being run (same folder), and gets installed as
# this machine's tenant configuration. Fail loudly rather than install a
# non-functional agent if it's missing.
PKG_DIR=""
if [ -n "\${1:-}" ]; then
    PKG_DIR="$(cd "$(dirname "\$1")" 2>/dev/null && pwd)"
fi
if [ -z "\${PKG_DIR:-}" ] || [ ! -f "\${PKG_DIR}/\${EXECUTABLENAME}.msh" ]; then
    echo "ERROR: \${EXECUTABLENAME}.msh not found next to this installer package." >&2
    echo "       Place a tenant-specific \${EXECUTABLENAME}.msh in the same folder as" >&2
    echo "       the .pkg and re-run the installer." >&2
    exit 1
fi
mkdir -p "\${INSTALLDIR}"
cp -f "\${PKG_DIR}/\${EXECUTABLENAME}.msh" "\${INSTALLDIR}/\${EXECUTABLENAME}.msh"
# --------------------------------------------------------------------------

chown -R root:wheel "/usr/local/mesh_services/\${COMPANYNAME}" || true
chown root:wheel "\${INSTALLDIR}/\${EXECUTABLENAME}" "\${INSTALLDIR}/\${EXECUTABLENAME}.msh"
chown root:wheel "/Library/LaunchDaemons/\${SERVICENAME}.plist" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist"

chmod 755 "\${INSTALLDIR}" "\${INSTALLDIR}/\${EXECUTABLENAME}"
chmod 644 "\${INSTALLDIR}/\${EXECUTABLENAME}.msh" "/Library/LaunchDaemons/\${SERVICENAME}.plist" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist"

/bin/launchctl bootout system "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 || true
/bin/launchctl bootstrap system "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 || /bin/launchctl load "/Library/LaunchDaemons/\${SERVICENAME}.plist"

CONSOLE_USER=$(stat -f '%Su' /dev/console 2>/dev/null || true)
CONSOLE_UID=$(id -u "\${CONSOLE_USER}" 2>/dev/null || true)
if [ -n "\${CONSOLE_UID}" ] && [ "\${CONSOLE_UID}" != "0" ]; then
    /bin/launchctl bootout "gui/\${CONSOLE_UID}" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" >/dev/null 2>&1 || true
    /bin/launchctl bootstrap "gui/\${CONSOLE_UID}" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" >/dev/null 2>&1 || true
fi
`;
}

function buildUninstall(companyName, serviceName, executableName) {
    return `#!/bin/bash

echo "Stopping ${serviceName}..."
sudo /bin/launchctl bootout system "/Library/LaunchDaemons/${serviceName}.plist" &> /dev/null || sudo /bin/launchctl unload "/Library/LaunchDaemons/${serviceName}.plist" &> /dev/null
sudo pkill -9 "${serviceName}" &> /dev/null || true
CONSOLE_USER=$(stat -f '%Su' /dev/console 2>/dev/null || true)
CONSOLE_UID=$(id -u "\${CONSOLE_USER}" 2>/dev/null || true)
if [ -n "\${CONSOLE_UID}" ] && [ "\${CONSOLE_UID}" != "0" ]; then
    sudo /bin/launchctl bootout "gui/\${CONSOLE_UID}" "/Library/LaunchAgents/${serviceName}-launchagent.plist" &> /dev/null || true
fi

echo "Resetting TCC permissions for ${serviceName}..."
BUNDLE_ID=$(mdls -name kMDItemCFBundleIdentifier -raw "/usr/local/mesh_services/${companyName}/${serviceName}/${executableName}" 2>/dev/null || true)
if [ -n "\${BUNDLE_ID}" ] && [ "\${BUNDLE_ID}" != "(null)" ]; then
    sudo tccutil reset All "\${BUNDLE_ID}" &> /dev/null || true
fi
sudo tccutil reset All "${serviceName}" &> /dev/null || true

sudo rm -f "/usr/local/mesh_services/${companyName}/${serviceName}/${executableName}" &> /dev/null
sudo rm -f "/usr/local/mesh_services/${companyName}/${serviceName}/${executableName}.msh" &> /dev/null
sudo rm -f "/usr/local/mesh_services/${companyName}/${serviceName}/${executableName}.db" &> /dev/null
sudo rm -f "/Library/LaunchDaemons/${serviceName}.plist" &> /dev/null
sudo rm -f "/Library/LaunchAgents/${serviceName}-launchagent.plist" &> /dev/null
echo "${serviceName} was uninstalled."
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
    const identifier = 'com.meshagent.' + pkgIdentifierSegment(serviceName) + '.pkg';
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

        // Resources for the product archive (welcome text, optional background)
        const welcomeText = 'Welcome to the ' + displayName + ' installer\n\n'
            + 'This installer requires a "' + executableName + '.msh" tenant settings file to be present in the same folder as this .pkg. '
            + 'If it is missing, installation will fail with an error.\n\n'
            + 'Once installed, this software allows an administrator to remotely monitor and control this computer over the internet.\n\n'
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
        await fsp.writeFile(uninstallPath, buildUninstall(companyName, serviceName, executableName), { mode: 0o755 });

        return { pkgPath: pkgPath, uninstallPath: uninstallPath, workDir: workDir };
    } finally {
        if (!opts.keepWork) { await fsp.rm(workDir, { recursive: true, force: true }); }
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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
        else if (a === '--sign') { opts.signIdentity = argv[++i]; }
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
        '  --background <path>    Optional PNG for the installer sidebar',
        '  --sign <identity>      "Developer ID Installer: Your Org (TEAMID)"',
        '  --keep-work             Keep the intermediate build/ directory (debugging)',
        '',
        'The resulting .pkg contains NO tenant .msh file. At install time it',
        'requires "<exe>.msh" to be present in the same folder as the .pkg, e.g.:',
        '  dist/SonarSightAgent.pkg',
        '  dist/SonarSightAgent.msh   <- per-tenant, generated separately (named after --exe)',
        '',
        'Requires macOS with Xcode Command Line Tools (pkgbuild, productbuild).'
    ].join('\n'));
}

async function main() {
    const argv = process.argv.slice(2);
    const opts = parseArgs(argv);
    if (opts.help || opts._.length === 0) { printHelp(); process.exit(opts.help ? 0 : 1); return; }

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
    console.log('For each tenant, place their own "' + (opts.executableName || 'meshagent') + '.msh" next to');
    console.log(path.basename(result.pkgPath) + ' before running the installer.');
}

if (require.main === module) {
    main().catch(function (e) { console.error(e.message || e); process.exit(1); });
}

module.exports = { buildMacOSInstaller };
