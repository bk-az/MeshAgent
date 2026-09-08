#!/usr/bin/env ruby
# frozen_string_literal: true
#
# embed_msh_windows_test.rb
#
# Locks embed_msh_windows.rb to the exact byte format of the MeshCentral
# server's ../../../MeshCentral/exeHandler.js. The guarantee is that the bytes
# this Ruby tool writes are IDENTICAL to what the server (and the sibling
# embed-msh-windows.js) produces, so an agent embedded here is
# indistinguishable from one embedded there.
#
# Run:  ruby embed_msh_windows_test.rb
# Exits non-zero on any failure.
#
# It needs Windows PE specimens (signed and unsigned) to compare against, and
# node (with the sibling embed-msh-windows.js) as the byte-equivalence oracle.
# By default specimens come from ../../../MeshCentral/agents; override with
# MESHCENTRAL_AGENTS=/path. If node or the specimens are absent, the
# byte-equivalence cases SKIP (not fail); the self-contained checks still run.

require 'digest'
require 'open3'
require 'tmpdir'

$LOAD_PATH.unshift(__dir__)
require 'embed_msh_windows'
M = EmbedMshWindows

PASS = [0]
FAIL = [0]
SKIP = [0]
def ok(name, cond)
  if cond
    PASS[0] += 1
    puts "  ok   #{name}"
  else
    FAIL[0] += 1
    puts "  FAIL #{name}"
  end
end
def skipp(name, why)
  SKIP[0] += 1
  puts "  skip #{name}  (#{why})"
end

MSH = "MeshName=Acme Corp\r\nMeshType=2\r\nMeshID=0xDEADBEEF1234\r\n" \
      "ServerID=ABC123DEF456\r\nMeshServer=wss://mesh.example.com:443/agent.ashx\r\n".b

AGENTS_DIR = ENV['MESHCENTRAL_AGENTS'] ||
             File.expand_path(File.join(__dir__, '..', '..', '..', 'MeshCentral', 'agents'))
JS_TOOL = File.join(__dir__, 'embed-msh-windows.js')

def find_specimens
  out = { signed: nil, unsigned: nil }
  return out unless Dir.exist?(AGENTS_DIR)

  Dir.glob(File.join(AGENTS_DIR, '*.exe')).sort.each do |p|
    begin
      pe = M.parse_windows_executable(p)
    rescue StandardError
      next
    end
    out[:signed] ||= p if pe[:CertificateTableAddress] != 0
    out[:unsigned] ||= p if pe[:CertificateTableAddress] == 0
    break if out[:signed] && out[:unsigned]
  end
  out
end

def node_available?
  return false unless File.exist?(JS_TOOL)

  _o, _e, s = Open3.capture3('node', '-v')
  s.success?
rescue StandardError
  false
end

# Ask the JS oracle for its exact output bytes for a given exe + policy.
def js_embed_bytes(exe, random_policy)
  script = <<~JS
    const m = require(#{JS_TOOL.inspect});
    const fs = require('fs');
    const msh = fs.readFileSync(#{tmp_msh.inspect});
    const out = m.buildEmbeddedBuffer(fs.readFileSync(#{exe.inspect}), msh, {platform:'win32', randomPolicy:#{random_policy}});
    process.stdout.write(out);
  JS
  out, err, st = Open3.capture3('node', '-e', script)
  raise "node oracle failed: #{err}" unless st.success?

  out.b
end

def tmp_msh
  @tmp_msh ||= begin
    f = File.join(Dir.tmpdir, "embedtest-#{Process.pid}.msh")
    File.binwrite(f, MSH)
    at_exit { File.delete(f) if File.exist?(f) }
    f
  end
end

puts 'embed_msh_windows_test.rb'

# ---- Self-contained checks (no oracle / specimens needed) ----
fake = 'hello-not-a-real-binary'.b
emb = M.build_embedded_buffer(fake, MSH, platform: 'linux')
ok('linux/unsigned: layout = bin + msh + len(BE) + guid',
   emb.bytesize == fake.bytesize + MSH.bytesize + 20 &&
   emb.byteslice(0, fake.bytesize) == fake &&
   emb.byteslice(emb.bytesize - 20, 4).unpack1('N') == MSH.bytesize &&
   emb.byteslice(emb.bytesize - 16, 16).unpack1('H*').upcase == M::EXE_MESH_POLICY_GUID)

ok('null-policy tag selected by random_policy',
   M.build_embedded_buffer(fake, MSH, platform: 'linux', random_policy: true)
    .byteslice(-16, 16).unpack1('H*').upcase == M::EXE_NULL_POLICY_GUID)

# round-trip through extract (self-contained, via a temp file)
Dir.mktmpdir do |d|
  p = File.join(d, 'rt.bin')
  File.binwrite(p, emb)
  ex = M.extract_mesh_policy(p)
  ok('extract round-trips the embedded MSH', ex && ex[:msh] == MSH && ex[:policy] == 'mesh')
end

# ---- Byte-equivalence against the JS/reference oracle ----
unless node_available?
  skipp('byte-equivalence to reference', 'node or embed-msh-windows.js not available')
  puts "\n#{PASS[0]} passed, #{FAIL[0]} failed, #{SKIP[0]} skipped"
  exit(FAIL[0].zero? ? 0 : 1)
end

spec = find_specimens
cases = []
if spec[:signed]
  cases << ['signed', spec[:signed], false]
  cases << ['signed+randomPolicy', spec[:signed], true]
else
  skipp('signed byte-equivalence', 'no signed PE specimen')
end
if spec[:unsigned]
  cases << ['unsigned', spec[:unsigned], false]
else
  skipp('unsigned byte-equivalence', 'no unsigned PE specimen')
end

cases.each do |label, exe, rnd|
  mine = M.build_embedded_buffer(File.binread(exe), MSH, platform: 'win32', random_policy: rnd)
  theirs = js_embed_bytes(exe, rnd)
  ok("#{label}: output byte-identical to reference", mine == theirs)

  next if rnd

  Dir.mktmpdir do |d|
    out = File.join(d, 'out.exe')
    File.binwrite(out, mine)
    ex = M.extract_mesh_policy(out)
    ok("#{label}: embedded MSH round-trips", ex && ex[:msh] == MSH)

    before = M.hash_executable_file(source_path: exe)
    after = M.hash_executable_file(source_path: out)
    ok("#{label}: Authenticode sha384 stable across embed", before == after)

    # parity with the JS hashExecutableFile
    js_hash_script = "const m=require(#{JS_TOOL.inspect});process.stdout.write(m.hashExecutableFile({sourcePath:#{exe.inspect}}))"
    jh, = Open3.capture2('node', '-e', js_hash_script)
    ok("#{label}: my hash == reference hashExecutableFile", jh.strip == before)
  end
end

puts "\n#{PASS[0]} passed, #{FAIL[0]} failed, #{SKIP[0]} skipped"
exit(FAIL[0].zero? ? 0 : 1)
