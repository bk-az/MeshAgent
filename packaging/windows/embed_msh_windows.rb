#!/usr/bin/env ruby
# frozen_string_literal: true
#
# embed_msh_windows.rb
#
# Ruby port of embed-msh-windows.js. Embeds a tenant ".msh" settings file into
# a Windows MeshAgent ".exe", file-in / file-out, for the "sign once, provision
# per tenant" model.
#
# Why this works without re-signing (signed binaries):
#   An Authenticode signature does NOT cover three regions of a PE file: the
#   optional-header CheckSum (4 bytes), the certificate-table data-directory
#   entry (8 bytes), and the attribute certificate table itself. This tool
#   appends the MSH at the very end of the file and GROWS the certificate table
#   (both the data-directory size field and the WIN_CERTIFICATE dwLength) to
#   cover it. Because that region is excluded from the Authenticode hash, the
#   Microsoft signature stays valid -- sign + timestamp the .exe once per
#   release, then stamp every tenant's .msh in afterwards with no certificate.
#
#   For an UNSIGNED binary (or any non-PE file) there is no certificate table,
#   so the MSH is simply appended. The agent finds it either way via the
#   trailing GUID + length.
#
# Trailer written at end-of-file (what the agent looks for):
#   [ ...msh bytes... ][ msh length: 4 bytes BIG-endian ][ 16-byte GUID ]
#
# The bytes produced here are identical to those of exeHandler.js /
# embed-msh-windows.js; embed_msh_windows_test.rb checks that against the real
# reference module's output and real PE specimens.
#
# Usage:
#   ruby embed_msh_windows.rb <signed-agent.exe> <tenant.msh> <output.exe> [options]
#
# Options:
#   --random-policy   Tag with the null-policy GUID (fixed-length filler case)
#   --force           Overwrite <output.exe> if it exists
#   --verify          Re-read the output and confirm the MSH round-trips and,
#                     for signed input, the Authenticode hash is unchanged
#
# Inspect / verify an existing binary instead of embedding:
#   ruby embed_msh_windows.rb --info    <agent.exe>
#   ruby embed_msh_windows.rb --extract <agent.exe> [out.msh]
#   ruby embed_msh_windows.rb --hash    <agent.exe>

require 'digest'

module EmbedMshWindows
  # 16-byte markers written as the final bytes of the file. Identical to the
  # values in ../MeshCentral/exeHandler.js -- the agent recognizes these exact
  # GUIDs, so they must never change.
  EXE_JAVASCRIPT_GUID = 'B996015880544A19B7F7E9BE44914C18'
  EXE_MESH_POLICY_GUID = 'B996015880544A19B7F7E9BE44914C19'
  EXE_NULL_POLICY_GUID = 'B996015880544A19B7F7E9BE44914C20'

  # Bytes appended after the MSH content: 4-byte length + 16-byte GUID.
  TRAILER_OVERHEAD = 20

  module_function

  # All reads/writes are BINARY. Ruby strings default to UTF-8, which would
  # corrupt byte offsets, so every buffer is ASCII-8BIT and every file access
  # goes through binread/binwrite.
  def read_binary(path)
    File.binread(path)
  end

  # --- little/big-endian helpers, mapping the JS DataView calls -------------
  #   writeUInt32LE -> pack('V')   readUInt32LE -> unpack1('V')
  #   writeUInt32BE -> pack('N')   readUInt32BE -> unpack1('N')
  #   readUInt16LE  -> unpack1('v')
  def u32le(buf, off) buf.byteslice(off, 4).unpack1('V') end
  def u16le(buf, off) buf.byteslice(off, 2).unpack1('v') end
  def pack_u32le(v) [v].pack('V') end
  def pack_u32be(v) [v].pack('N') end
  def guid_bytes(hex) [hex].pack('H*') end
  def trailing_guid_hex(buf) buf.byteslice(buf.bytesize - 16, 16).unpack1('H*').upcase end

  # --------------------------------------------------------------------------
  # Parse a PE from a file. Returns a hash of the offsets the embed/hash logic
  # needs. Faithful to exeHandler.js.parseWindowsExecutable, with arm64 machine
  # recognition added. Raises on anything that is not a PE.
  # --------------------------------------------------------------------------
  def parse_windows_executable(path)
    parse_windows_executable_from_buffer(read_binary(path), full: true)
  end

  def parse_windows_executable_from_buffer(buf, full: false)
    raise 'unrecognized binary format (no MZ signature)' unless u16le(buf, 0).to_s(16).upcase == '5A4D'

    nt = u32le(buf, 60)
    raise 'not a PE file (no PE signature)' unless buf.byteslice(nt, 4).unpack1('H*') == '50450000'

    ret = {}
    if full
      ret[:format] = case u16le(buf, nt + 4).to_s(16)
                     when '14c' then 'x86'   # IMAGE_FILE_MACHINE_I386
                     when '8664' then 'x64'  # IMAGE_FILE_MACHINE_AMD64
                     when 'aa64' then 'arm64' # IMAGE_FILE_MACHINE_ARM64
                     when '1c0' then 'arm'   # IMAGE_FILE_MACHINE_ARM
                     end
    end

    opt = nt + 24
    ret[:CheckSumPos] = opt + 64

    case u16le(buf, opt).to_s(16).upcase
    when '10B' # PE32 (32-bit)
      ret[:CertificateTableAddress] = u32le(buf, opt + 128)
      ret[:CertificateTableSize]    = u32le(buf, opt + 132)
      ret[:CertificateTableSizePos] = opt + 132
    when '20B' # PE32+ (64-bit, incl. arm64)
      ret[:CertificateTableAddress] = u32le(buf, opt + 144)
      ret[:CertificateTableSize]    = u32le(buf, opt + 148)
      ret[:CertificateTableSizePos] = opt + 148
    else
      raise format('unknown optional-header magic: 0x%x', u16le(buf, opt))
    end

    if ret[:CertificateTableAddress] != 0
      ret[:certificateDwLength] = u32le(buf, ret[:CertificateTableAddress])
    end
    ret
  end

  # --------------------------------------------------------------------------
  # Core: build the output byte string with the MSH embedded. Mirrors
  # exeHandler.js buildEmbeddedBuffer exactly for both branches.
  # --------------------------------------------------------------------------
  def build_embedded_buffer(source, msh, platform: 'win32', random_policy: false, peinfo: nil)
    source = source.dup.force_encoding(Encoding::BINARY)
    msh = msh.dup.force_encoding(Encoding::BINARY)
    guid = guid_bytes(random_policy ? EXE_NULL_POLICY_GUID : EXE_MESH_POLICY_GUID)
    len_be = pack_u32be(msh.bytesize)

    pe = peinfo || (platform == 'win32' ? parse_windows_executable_from_buffer(source) : nil)

    # Unsigned Windows, or non-Windows: plain append, no header patching.
    if platform != 'win32' || pe[:CertificateTableAddress] == 0
      return source + msh + len_be + guid
    end

    # Signed Windows: grow the certificate table so the appended MSH sits
    # inside the (unsigned) certificate region.
    dw_len = pe[:certificateDwLength]
    padding = (8 - ((dw_len + msh.bytesize + TRAILER_OVERHEAD) % 8)) % 8 # quad-align
    delta = msh.bytesize + TRAILER_OVERHEAD + padding

    new_cert_table_size = pack_u32le(pe[:CertificateTableSize] + delta)
    new_dw_length = pack_u32le(pe[:certificateDwLength] + delta)

    seg1 = source.byteslice(0, pe[:CertificateTableSizePos])                                                 # up to & incl. cert-table SIZE field start
    seg2 = source.byteslice(pe[:CertificateTableSizePos] + 4, pe[:CertificateTableAddress] - (pe[:CertificateTableSizePos] + 4)) # gap up to WIN_CERTIFICATE dwLength
    seg3 = source.byteslice(pe[:CertificateTableAddress] + 4, source.bytesize - (pe[:CertificateTableAddress] + 4)) # rest of the file after dwLength

    out = +''
    out.force_encoding(Encoding::BINARY)
    out << seg1 << new_cert_table_size << seg2 << new_dw_length << seg3
    out << ("\x00".b * padding) if padding.positive?
    out << msh << len_be << guid
    out
  end

  # --------------------------------------------------------------------------
  # File-in / file-out. Returns a summary hash.
  # --------------------------------------------------------------------------
  def embed_mesh_policy_file(source_path:, dest_path:, msh:, random_policy: false, force: false, platform: 'win32')
    raise "destination exists (use --force to overwrite): #{dest_path}" if !force && File.exist?(dest_path)

    source = read_binary(source_path)
    msh = msh.dup.force_encoding(Encoding::BINARY)
    raise 'msh content is empty' if msh.bytesize.zero?

    pe = platform == 'win32' ? parse_windows_executable(source_path) : nil
    out = build_embedded_buffer(source, msh, platform: platform, random_policy: random_policy, peinfo: pe)

    # Write atomically: temp file in the same directory, then rename.
    tmp = "#{dest_path}.tmp-#{Process.pid}"
    File.binwrite(tmp, out)
    File.rename(tmp, dest_path)

    {
      signed: !!(pe && pe[:CertificateTableAddress] != 0),
      format: pe ? pe[:format] : platform,
      source_size: source.bytesize,
      output_size: out.bytesize,
      msh_size: msh.bytesize,
      random_policy: random_policy
    }
  end

  # --------------------------------------------------------------------------
  # Authenticode-stable hash (sha384, matching MeshCentral). Zeroes the
  # checksum (4 bytes) and the certificate-table directory entry (8 bytes), and
  # stops before the certificate table -- so signing, or embedding an MSH, does
  # not change the hash. Returns hex. Faithful to hashExecutableFile.
  # --------------------------------------------------------------------------
  def hash_executable_file(source_path:, algorithm: 'SHA384', platform: nil)
    peinfo = nil
    if platform.nil?
      begin
        peinfo = parse_windows_executable(source_path)
        platform = 'win32'
      rescue StandardError
        platform = 'other'
      end
    elsif platform == 'win32'
      peinfo = parse_windows_executable(source_path)
    end

    buf = read_binary(source_path)
    digest = Digest.const_get(algorithm).new

    end_index = 0
    check_sum_index = 0
    table_index = 0
    if platform == 'win32'
      end_index = peinfo[:CertificateTableAddress] if peinfo[:CertificateTableAddress] != 0
      table_index = peinfo[:CertificateTableSizePos] - 4 # start of the 8-byte cert-table directory entry
      check_sum_index = peinfo[:CheckSumPos]
    end

    if end_index == 0
      # Unsigned: trim a trailing mesh-policy MSH so the base hash is stable
      # whether or not a .msh has been embedded. Two deliberate corrections vs
      # the reference (whose trim never fires): it compares a lowercase hex
      # string to an UPPERCASE GUID (dead branch) and reads the trailer length
      # little-endian though it is written big-endian. We lowercase the GUID
      # and read the length big-endian. Only mesh-policy (not null-policy) is
      # trimmed, matching the reference's choice.
      if buf.bytesize >= TRAILER_OVERHEAD && trailing_guid_hex(buf) == EXE_MESH_POLICY_GUID
        msh_len = buf.byteslice(buf.bytesize - TRAILER_OVERHEAD, 4).unpack1('N')
        end_index = buf.bytesize - TRAILER_OVERHEAD - msh_len
      else
        end_index = buf.bytesize
      end
    end

    if check_sum_index != 0
      digest.update(buf.byteslice(0, check_sum_index))
      digest.update("\x00".b * 4)                                               # zeroed checksum
      digest.update(buf.byteslice(check_sum_index + 4, table_index - (check_sum_index + 4)))
      digest.update("\x00".b * 8)                                               # zeroed cert-table directory entry
      digest.update(buf.byteslice(table_index + 8, end_index - (table_index + 8)))
    else
      digest.update(buf.byteslice(0, end_index))
    end
    digest.hexdigest
  end

  # --------------------------------------------------------------------------
  # Read back an embedded MSH, if present. Returns {policy:, msh:} or nil.
  # --------------------------------------------------------------------------
  def extract_mesh_policy(exe_path)
    buf = read_binary(exe_path)
    return nil if buf.bytesize < TRAILER_OVERHEAD

    policy = case trailing_guid_hex(buf)
             when EXE_MESH_POLICY_GUID then 'mesh'
             when EXE_NULL_POLICY_GUID then 'null'
             end
    return nil if policy.nil?

    msh_len = buf.byteslice(buf.bytesize - TRAILER_OVERHEAD, 4).unpack1('N')
    start = buf.bytesize - TRAILER_OVERHEAD - msh_len
    return nil if start.negative?

    { policy: policy, msh: buf.byteslice(start, buf.bytesize - TRAILER_OVERHEAD - start) }
  end

  # ------------------------------------------------------------------------
  # CLI
  # ------------------------------------------------------------------------
  HELP = <<~TXT
    Embed a tenant .msh into a Windows MeshAgent .exe (signature-preserving).

    Usage:
      ruby embed_msh_windows.rb <signed-agent.exe> <tenant.msh> <output.exe> [options]

    Options:
      --random-policy   Tag with the null-policy GUID (fixed-length filler case)
      --force           Overwrite <output.exe> if it already exists
      --verify          Re-read the output and confirm the MSH round-trips and,
                        for signed input, the Authenticode hash is unchanged

    Inspect an existing binary instead of embedding:
      ruby embed_msh_windows.rb --info    <agent.exe>
      ruby embed_msh_windows.rb --extract <agent.exe> [out.msh]
      ruby embed_msh_windows.rb --hash    <agent.exe>

    The .exe is signed + timestamped ONCE per release; this stamps each tenant
    .msh in afterwards with no re-signing (the MSH lands in the Authenticode
    certificate table, which the signature does not cover).
  TXT

  def main(argv)
    if argv.empty? || argv[0] == '-h' || argv[0] == '--help'
      puts HELP
      exit(argv.empty? ? 1 : 0)
    end

    case argv[0]
    when '--info'
      pe = parse_windows_executable(argv[1])
      embedded = extract_mesh_policy(argv[1])
      puts "format:                #{pe[:format]}"
      puts "signed:                #{pe[:CertificateTableAddress] != 0 ? 'yes' : 'no'}"
      puts "CertificateTableAddr:  #{pe[:CertificateTableAddress]}"
      puts "CertificateTableSize:  #{pe[:CertificateTableSize]}"
      puts "certificate dwLength:  #{pe[:certificateDwLength]}" if pe[:CertificateTableAddress] != 0
      puts "authenticode sha384:   #{hash_executable_file(source_path: argv[1])}"
      puts "embedded MSH:          #{embedded ? "#{embedded[:policy]}-policy, #{embedded[:msh].bytesize} bytes" : 'none'}"
      return
    when '--extract'
      embedded = extract_mesh_policy(argv[1])
      if embedded.nil?
        warn "No embedded MSH found in #{argv[1]}"
        exit 1
      end
      if argv[2]
        File.binwrite(argv[2], embedded[:msh])
        puts "Wrote #{argv[2]} (#{embedded[:msh].bytesize} bytes, #{embedded[:policy]}-policy)"
      else
        $stdout.binmode
        $stdout.write(embedded[:msh])
      end
      return
    when '--hash'
      puts hash_executable_file(source_path: argv[1])
      return
    end

    positional = []
    opts = { random_policy: false, force: false, verify: false }
    argv.each do |a|
      case a
      when '--random-policy' then opts[:random_policy] = true
      when '--force' then opts[:force] = true
      when '--verify' then opts[:verify] = true
      else positional << a
      end
    end
    if positional.length < 3
      warn 'Expected: <agent.exe> <tenant.msh> <output.exe>'
      exit 1
    end

    source_path, msh_path, dest_path = positional
    msh = read_binary(msh_path)

    unless opts[:random_policy]
      text = msh.dup.force_encoding(Encoding::UTF_8)
      missing = %w[MeshServer MeshID ServerID].reject { |k| text =~ /^[ \t]*#{k}=/ }
      warn "WARNING: .msh has no #{missing.join(', ')} line(s); the agent may not connect." unless missing.empty?
      warn 'WARNING: .msh is not CRLF; MeshCentral-generated files are.' unless text.include?("\r\n")
    end

    before_hash = begin
      hash_executable_file(source_path: source_path)
    rescue StandardError
      nil
    end

    res = embed_mesh_policy_file(
      source_path: source_path, dest_path: dest_path, msh: msh,
      random_policy: opts[:random_policy], force: opts[:force]
    )

    puts "Wrote #{dest_path}"
    puts "  input:  #{File.basename(source_path)} (#{res[:format]}, #{res[:signed] ? 'signed' : 'unsigned'}, #{res[:source_size]} bytes)"
    puts "  msh:    #{File.basename(msh_path)} (#{res[:msh_size]} bytes#{res[:random_policy] ? ', null-policy' : ''})"
    puts "  output: #{res[:output_size]} bytes"

    if opts[:verify]
      embedded = extract_mesh_policy(dest_path)
      if embedded.nil? || embedded[:msh] != msh.dup.force_encoding(Encoding::BINARY)
        warn 'VERIFY FAILED: embedded MSH does not match source .msh'
        exit 2
      end
      if res[:signed]
        after_hash = hash_executable_file(source_path: dest_path)
        if before_hash && after_hash != before_hash
          warn "VERIFY FAILED: Authenticode hash changed (#{before_hash} -> #{after_hash})"
          exit 2
        end
        puts '  verify: MSH round-trips; Authenticode hash unchanged (signature preserved)'
      else
        puts '  verify: MSH round-trips (unsigned input; hash intentionally changes)'
      end
    elsif res[:signed]
      puts '  (signed input: the Authenticode signature is preserved -- no re-signing needed)'
    end
  end
end

if __FILE__ == $PROGRAM_NAME
  begin
    EmbedMshWindows.main(ARGV)
  rescue StandardError => e
    warn(e.message)
    exit 1
  end
end
