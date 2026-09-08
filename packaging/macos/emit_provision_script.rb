#!/usr/bin/env ruby
# frozen_string_literal: true
#
# emit_provision_script.rb
#
# Ruby port of the "--emit-provision-script" mode of build-macos-pkg.js, and
# only that mode: it writes one per-tenant macOS provisioning script and never
# touches an agent binary, pkgbuild, productbuild or a signing identity.
# Because of that it needs no Xcode tools and no Mac -- it is plain text in,
# plain text out -- while build-macos-pkg.js stays the tool that builds the
# .pkg itself.
#
# The deployment model it belongs to (see MASS-DEPLOYMENT.md):
#   <ExeName>.pkg                 built + signed + notarized ONCE per release,
#                                 contains no tenant configuration
#   <ExeName>-provision.command   generated per tenant, unsigned, free
#
# Difference from the .sh the JS emits: this one is shaped like the
# Uninstall.command that ships beside the package, so the same file serves both
# audiences.
#   * A human double-clicks it in Finder. macOS opens a ".command" in Terminal,
#     the script sees it is not root, re-execs itself through sudo, and sudo
#     asks for the administrator password right there -- no Terminal knowledge
#     needed. Its mode is 0755 for exactly that reason.
#   * A mass-deployment tool (Jamf, Kandji, Intune, Mosyle, Munki, plain MDM)
#     already runs scripts as root, so it never enters that branch, and every
#     exit path still ends in the documented exit code those tools report on.
#     The end-of-run pause is tty-gated and time-limited, so an unattended run
#     cannot hang on it.
#
# Usage:
#   ruby emit_provision_script.rb <tenant.msh> [options]
#
# Options:
#   --out <dir>            Output directory (default: ".")
#   --company <name>       MUST match the .pkg (default: "meshagent")
#   --service <name>       MUST match the .pkg (default: "meshagent")
#   --exe <name>           MUST match the .pkg (default: "meshagent")
#   --script-name <name>   Output basename before "-provision" (default: --exe)
#   --ext <command|sh>     Output extension (default: "command", which is what
#                          makes double-clicking work). Use "sh" for a tool
#                          that only accepts an uploaded ".sh" file, e.g.
#                          Microsoft Intune -- the contents are identical.
#   --no-syntax-check      Skip the "bash -n" check of the emitted script
#
# Example (matching the .pkg from mac-build-sign.md):
#   ruby packaging/macos/emit_provision_script.rb ~/Downloads/SonarSight.msh \
#     --out dist/arm64 --company AssetSonar --service SonarSightAgent \
#     --exe SonarSightAgent

require 'base64'

module EmitProvisionScript
  DEFAULT_NAME = 'meshagent'
  VALID_EXTENSIONS = %w[command sh].freeze

  # These three land inside the emitted shell script as double-quoted string
  # literals and as path components, so anything that could terminate the
  # quoting, expand, or escape the install directory is rejected outright
  # rather than silently producing a broken script.
  SAFE_NAME = /\A[A-Za-z0-9][A-Za-z0-9 ._-]*\z/.freeze

  module_function

  # Mirrors pkgFileNameSegment() in build-macos-pkg.js: keeps case and spaces
  # (both legal in a macOS filename), strips only what a path cannot hold.
  def file_name_segment(str)
    cleaned = str.to_s.gsub(%r{[/:\\]}, '-').gsub(/\s+/, ' ').strip
    cleaned.empty? ? 'MeshAgent' : cleaned
  end

  def check_name(kind, value)
    return value if SAFE_NAME.match?(value)

    raise "invalid --#{kind} #{value.inspect}: use letters, digits, space, '.', '_' or '-' " \
          '(it must match the value the .pkg was built with)'
  end

  # --------------------------------------------------------------------------
  # The emitted script. Kept in a NON-interpolating heredoc so the shell body
  # is literal: no Ruby escape processing to fight, so "printf '%s\n'" and
  # trailing "\" line continuations survive exactly as written. Values are
  # substituted through the {{...}} placeholders below, with gsub's block form
  # so a "\" in a replacement can never be read as a backreference.
  # --------------------------------------------------------------------------
  PROVISION_TEMPLATE = <<'PROVISION_TEMPLATE'
#!/bin/bash
#
# {{EXE_NAME}} tenant provisioning script.
#
# Run this AFTER installing the {{EXE_NAME}} package. It installs this tenant's
# configuration (carried inside this file, below) and starts the agent. It is
# idempotent -- running it again is harmless.
#
# Two supported ways to run it:
#   * Double-click it in Finder. Terminal opens and the script asks for the
#     administrator password itself (same behaviour as Uninstall.command).
#   * From a mass-deployment tool, which already runs scripts as root, or by
#     hand:   sudo bash "{{SCRIPT_BASENAME}}"
#
# Exit codes -- for mass-deployment reporting:
#   0  SUCCESS  configuration installed, agent verified running
#   1  ERROR    not running as root and could not elevate
#   2  ERROR    agent not installed (deploy the {{EXE_NAME}} package first)
#   3  ERROR    could not write the configuration
#   4  ERROR    configuration written but the agent did not start
#
# A copy of every message also goes to /var/log/{{SERVICE_NAME}}-provision.log.
#
# Environment overrides:
#   MESH_WAIT_FOR_AGENT   seconds to wait for the package to appear (default
#                         30; 0 disables the wait)
#   MESH_NO_PAUSE=1       never wait for a keypress at the end
#
set -u

SERVICENAME="{{SERVICE_NAME}}"
COMPANYNAME="{{COMPANY_NAME}}"
EXECUTABLENAME="{{EXE_NAME}}"
INSTALLDIR="/usr/local/mesh_services/${COMPANYNAME}/${SERVICENAME}"
AGENTBIN="${INSTALLDIR}/${EXECUTABLENAME}"
MSH="${INSTALLDIR}/${EXECUTABLENAME}.msh"
DAEMONPLIST="/Library/LaunchDaemons/${SERVICENAME}.plist"
AGENTPLIST="/Library/LaunchAgents/${SERVICENAME}-launchagent.plist"
LOGFILE="/var/log/${SERVICENAME}-provision.log"

# Seconds to wait for the .pkg to finish installing, for deployment tools that
# do not strictly order "install package" before "run script".
WAIT_FOR_AGENT="${MESH_WAIT_FOR_AGENT:-30}"
case "${WAIT_FOR_AGENT}" in
    '' | *[!0-9]*) WAIT_FOR_AGENT=30 ;;  # non-numeric would break the -lt test
esac

_stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# The redirect is placed on the group, not the printf: a failing ">>" is
# reported by the shell itself, so "printf ... 2>/dev/null" would still leak
# "Permission denied" onto stderr and make a good run look like a failed one.
_tolog() { { printf '%s\n' "$1" >> "${LOGFILE}"; } 2>/dev/null || true; }

# Only ever pauses for a human. A Terminal window opened by a double-click can
# close the instant the script exits, taking the result with it. Both tty tests
# fail under every deployment tool (they capture stdout through a pipe), and the
# read times out regardless, so an unattended run cannot block here.
pause_if_interactive() {
    [ "${MESH_NO_PAUSE:-0}" = "1" ] && return 0
    [ -t 0 ] || return 0
    [ -t 1 ] || return 0
    printf '\nPress return to close this window (it closes by itself in 5 minutes)... '
    read -r -t 300 || true
    printf '\n'
}

log() {
    MSG="$(_stamp) [${SERVICENAME}] $*"
    echo "${MSG}"
    _tolog "${MSG}"
}
die() {
    CODE="$1"; shift
    MSG="$(_stamp) [${SERVICENAME}] ERROR(${CODE}): $*"
    echo "${MSG}" >&2
    _tolog "${MSG}"
    pause_if_interactive
    exit "${CODE}"
}

# --- 0. become root ------------------------------------------------------
# Double-clicked from Finder this runs as the logged-in user, so it re-execs
# itself under sudo and lets sudo prompt for the administrator password in the
# Terminal window macOS just opened. Deployment tools run as root already and
# skip the whole branch. "exec" replaces this process, so a rejected password
# ends the run with sudo's own status of 1 -- the same code this script uses
# for "not root". $0 is only usable when it is a real file: piped in through
# stdin ("... | bash") there is nothing to re-run, so say so instead.
if [ "$(id -u)" != "0" ]; then
    if [ -f "$0" ] && [ -r "$0" ]; then
        log "Requesting administrator privileges (sudo)..."
        exec sudo /bin/bash "$0" "$@"
    fi
    die 1 "must run as root (use: sudo bash <this script>)"
fi

# --- 1. the package must already be installed ----------------------------
WAITED=0
while [ ! -x "${AGENTBIN}" ] && [ "${WAITED}" -lt "${WAIT_FOR_AGENT}" ]; do
    [ "${WAITED}" = "0" ] && log "Waiting up to ${WAIT_FOR_AGENT}s for the ${EXECUTABLENAME} package to finish installing..."
    sleep 1
    WAITED=$((WAITED + 1))
done
[ -x "${AGENTBIN}" ] || die 2 "agent not installed at ${AGENTBIN} -- install ${EXECUTABLENAME}.pkg before running this script"
[ -f "${DAEMONPLIST}" ] || die 2 "launch daemon missing at ${DAEMONPLIST} -- the .pkg did not install correctly"

# --- 2. write this tenant's configuration --------------------------------
mkdir -p "${INSTALLDIR}" 2>/dev/null || true
TMPMSH="$(mktemp "${TMPDIR:-/tmp}/${EXECUTABLENAME}.msh.XXXXXX")" || die 3 "could not create a temporary file"
if ! /usr/bin/base64 -D > "${TMPMSH}" 2>/dev/null <<'MSH_B64'
{{MSH_BASE64}}
MSH_B64
then
    rm -f "${TMPMSH}"
    die 3 "could not decode the embedded configuration"
fi
[ -s "${TMPMSH}" ] || { rm -f "${TMPMSH}"; die 3 "the embedded configuration is empty"; }

if [ -f "${MSH}" ] && cmp -s "${TMPMSH}" "${MSH}"; then
    log "Configuration already up to date."
    CHANGED=0
else
    # "cat >" rather than "mv": it keeps the existing file's inode, owner and
    # mode, and works when TMPDIR is on another volume.
    cat "${TMPMSH}" > "${MSH}" || { rm -f "${TMPMSH}"; die 3 "could not write ${MSH}"; }
    # A write that ran out of disk half way leaves a truncated .msh that the
    # agent would happily load, so confirm the bytes really landed.
    cmp -s "${TMPMSH}" "${MSH}" || { rm -f "${TMPMSH}"; die 3 "${MSH} was written incompletely"; }
    log "Configuration written to ${MSH}."
    CHANGED=1
fi
rm -f "${TMPMSH}"
chown root:wheel "${MSH}" 2>/dev/null || true
chmod 644 "${MSH}" 2>/dev/null || true

# --- 3. (re)start the agent ----------------------------------------------
is_running() {
    /bin/launchctl print "system/${SERVICENAME}" 2>/dev/null \
        | grep -qE '^[[:space:]]*(state = running|pid = [0-9]+)'
}

if [ "${CHANGED}" = "1" ] || ! is_running; then
    log "Starting ${SERVICENAME}..."
    /bin/launchctl bootout system "${DAEMONPLIST}" >/dev/null 2>&1 || true
    /bin/launchctl bootstrap system "${DAEMONPLIST}" >/dev/null 2>&1 \
        || /bin/launchctl load "${DAEMONPLIST}" >/dev/null 2>&1 || true
else
    log "${SERVICENAME} is already running with this configuration."
fi

# --- 4. verify, so the exit code reflects reality ------------------------
TRIES=0
while ! is_running && [ "${TRIES}" -lt 15 ]; do sleep 1; TRIES=$((TRIES + 1)); done
if ! is_running; then
    die 4 "configuration installed but ${SERVICENAME} is not running. Inspect: launchctl print system/${SERVICENAME}"
fi

# Login-session agent (screen sharing / KVM). Best effort: it only exists once
# a user is logged in, and its absence is not a provisioning failure.
CONSOLE_USER=$(stat -f '%Su' /dev/console 2>/dev/null || true)
CONSOLE_UID=$(id -u "${CONSOLE_USER}" 2>/dev/null || true)
if [ -n "${CONSOLE_UID:-}" ] && [ "${CONSOLE_UID}" != "0" ] && [ -f "${AGENTPLIST}" ]; then
    /bin/launchctl bootout "gui/${CONSOLE_UID}" "${AGENTPLIST}" >/dev/null 2>&1 || true
    /bin/launchctl bootstrap "gui/${CONSOLE_UID}" "${AGENTPLIST}" >/dev/null 2>&1 || true
    log "Login-session agent (re)started for ${CONSOLE_USER}."
fi

log "SUCCESS: ${SERVICENAME} is configured and running."
pause_if_interactive
exit 0
PROVISION_TEMPLATE

  # Returns the provisioning script as a String.
  #
  # msh_base64      the tenant .msh, base64, already wrapped into lines
  # script_basename the filename it will be saved as (used in its own help text)
  def build_provision_script(company_name:, service_name:, executable_name:, msh_base64:, script_basename:)
    PROVISION_TEMPLATE
      .gsub('{{COMPANY_NAME}}') { company_name }
      .gsub('{{SERVICE_NAME}}') { service_name }
      .gsub('{{EXE_NAME}}') { executable_name }
      .gsub('{{SCRIPT_BASENAME}}') { script_basename }
      .gsub('{{MSH_BASE64}}') { msh_base64 }
  end

  # Writes "<name>-provision.<ext>" into out_dir, mode 0755 so a double-click
  # in Finder actually runs it. Returns { script_path:, warnings: }.
  def emit(msh_path:, out_dir: '.', company_name: nil, service_name: nil,
           executable_name: nil, script_name: nil, ext: 'command',
           syntax_check: true)
    company_name = check_name('company', company_name || DEFAULT_NAME)
    service_name = check_name('service', service_name || DEFAULT_NAME)
    executable_name = check_name('exe', executable_name || DEFAULT_NAME)
    unless VALID_EXTENSIONS.include?(ext)
      raise "invalid --ext #{ext.inspect}: expected one of #{VALID_EXTENSIONS.join(', ')}"
    end

    raise ".msh file not found: #{msh_path}" unless File.file?(msh_path)

    raw = File.binread(msh_path)
    raise "The .msh file is empty: #{msh_path}" if raw.empty?

    # Validate before deployment rather than discovering it on 500 Macs.
    warnings = []
    # Matched as bytes: a .msh with any non-UTF-8 byte in it would make a
    # UTF-8-tagged match raise instead of just reporting the warning.
    text = raw.dup.force_encoding(Encoding::BINARY)
    missing = %w[MeshServer MeshID ServerID].reject { |key| text =~ /^[ \t]*#{key}=/ }
    unless missing.empty?
      warnings << ".msh has no #{missing.join(', ')} line(s) -- the agent may not be able to connect."
    end
    unless text.include?("\r\n")
      warnings << '.msh does not use CRLF line endings; MeshCentral-generated files do.'
    end

    # base64 keeps the bytes exact, so CRLF and any encoding survive being
    # carried through a shell here-doc. The base64 alphabet cannot contain the
    # "MSH_B64" delimiter, so the here-doc can never be terminated early.
    msh_base64 = Base64.strict_encode64(raw).scan(/.{1,76}/).join("\n")

    script_basename = "#{file_name_segment(script_name || executable_name)}-provision.#{ext}"
    script_path = File.join(out_dir, script_basename)
    script = build_provision_script(
      company_name: company_name, service_name: service_name,
      executable_name: executable_name, msh_base64: msh_base64,
      script_basename: script_basename
    )

    require 'fileutils'
    FileUtils.mkdir_p(out_dir)
    File.binwrite(script_path, script)
    File.chmod(0o755, script_path)

    # Cheap insurance: a generated shell script that does not parse is the one
    # failure mode this tool could ship to every Mac at once.
    if syntax_check && File.executable?('/bin/bash')
      unless system('/bin/bash', '-n', script_path)
        raise "the emitted script failed \"bash -n\": #{script_path}"
      end
    end

    { script_path: script_path, warnings: warnings }
  end

  HELP = <<~TXT
    Usage: ruby emit_provision_script.rb <tenant.msh> [options]

    Writes one per-tenant macOS provisioning script. No agent binary, no
    pkgbuild/productbuild, no signing identity -- build the .pkg once with
    build-macos-pkg.js, then generate one of these per tenant.

    Options:
      --out <dir>           Output directory (default: ".")
      --company <name>      MUST match the .pkg (default: "meshagent")
      --service <name>      MUST match the .pkg (default: "meshagent")
      --exe <name>          MUST match the .pkg (default: "meshagent")
      --script-name <name>  Output basename before "-provision" (default: --exe)
      --ext <command|sh>    Output extension (default: "command", which is what
                            lets a user double-click it). Use "sh" for a tool
                            that only accepts an uploaded ".sh"; same contents.
      --no-syntax-check     Skip the "bash -n" check of the emitted script

    The emitted script runs either way round, like Uninstall.command: a
    double-click opens Terminal and it elevates itself with sudo, while a
    deployment tool that already runs as root goes straight through and gets a
    documented exit code (0 ok, 1 not root, 2 pkg missing, 3 write failed,
    4 agent did not start).

    Example:
      ruby emit_provision_script.rb ~/Downloads/SonarSight.msh \\
        --out dist/arm64 --company AssetSonar --service SonarSightAgent \\
        --exe SonarSightAgent
  TXT

  def main(argv)
    if argv.empty? || argv[0] == '-h' || argv[0] == '--help'
      puts HELP
      exit(argv.empty? ? 1 : 0)
    end

    positional = []
    opts = { out: '.', ext: 'command', syntax_check: true }
    i = 0
    while i < argv.length
      arg = argv[i]
      case arg
      when '--out' then opts[:out] = argv[i += 1]
      when '--company' then opts[:company_name] = argv[i += 1]
      when '--service' then opts[:service_name] = argv[i += 1]
      when '--exe' then opts[:executable_name] = argv[i += 1]
      when '--script-name' then opts[:script_name] = argv[i += 1]
      when '--ext' then opts[:ext] = argv[i += 1]
      when '--no-syntax-check' then opts[:syntax_check] = false
      when '-h', '--help'
        puts HELP
        exit 0
      else
        raise "unknown option: #{arg}" if arg.start_with?('--')

        positional << arg
      end
      i += 1
    end

    # A missing option value would otherwise become nil and silently fall back
    # to a default that does not match the .pkg.
    { out: '--out', company_name: '--company', service_name: '--service',
      executable_name: '--exe', script_name: '--script-name', ext: '--ext' }.each do |key, flag|
      raise "missing value for #{flag}" if opts.key?(key) && opts[key].nil?
    end
    raise 'Expected exactly one <tenant.msh>' unless positional.length == 1

    emitted = emit(
      msh_path: positional[0], out_dir: opts[:out],
      company_name: opts[:company_name], service_name: opts[:service_name],
      executable_name: opts[:executable_name], script_name: opts[:script_name],
      ext: opts[:ext], syntax_check: opts[:syntax_check]
    )
    emitted[:warnings].each { |w| warn "WARNING: #{w}" }

    path = emitted[:script_path]
    puts "Wrote #{path}"
    puts ''
    puts 'Install the .pkg first, then run this script. Either:'
    puts "  double-click it in Finder (it asks for the administrator password), or"
    puts "  sudo bash #{path.include?(' ') ? path.inspect : path}"
    puts ''
    puts 'Exit codes: 0 success  1 not root  2 pkg not installed  3 config write failed  4 agent did not start'
    if opts[:ext] == 'command'
      puts ''
      puts 'If you send it somewhere (zip, email, download), the receiving Mac may'
      puts 'strip the executable bit or quarantine it, which blocks the double-click:'
      puts "  chmod +x '#{File.basename(path)}' && xattr -d com.apple.quarantine '#{File.basename(path)}'"
    end
  end
end

if __FILE__ == $PROGRAM_NAME
  begin
    EmitProvisionScript.main(ARGV)
  rescue StandardError => e
    warn(e.message)
    exit 1
  end
end
