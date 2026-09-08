#!/usr/bin/env node
/*
 * embed-msh-windows.test.js
 *
 * Locks embed-msh-windows.js to the byte format of the MeshCentral server's
 * ../../../MeshCentral/exeHandler.js. The load-bearing guarantee is that the
 * bytes this packaging tool writes are IDENTICAL to what the server streams,
 * so an agent embedded here is indistinguishable from one embedded there.
 *
 * Run:  node embed-msh-windows.test.js
 * Exits non-zero on any failure.
 *
 * It needs Windows PE specimens (signed and unsigned) to compare against.
 * By default it looks in ../../../MeshCentral/agents; override with
 * MESHCENTRAL_AGENTS=/path/to/agents. If neither the reference module nor the
 * specimens are present, byte-equivalence cases are SKIPPED (not failed), so
 * the self-contained checks still run in isolation.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const mine = require('./embed-msh-windows.js');

let pass = 0, fail = 0, skip = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } }
function skipped(name, why) { skip++; console.log('  skip ' + name + '  (' + why + ')'); }

const MSH = Buffer.from('MeshName=Acme Corp\r\nMeshType=2\r\nMeshID=0xDEADBEEF1234\r\nServerID=ABC123DEF456\r\nMeshServer=wss://mesh.example.com:443/agent.ashx\r\n', 'utf8');

// Locate the reference module and the agent specimens (best-effort).
const refPath = path.resolve(__dirname, '..', '..', '..', 'MeshCentral', 'exeHandler.js');
let ref = null;
try { ref = require(refPath); } catch (e) { /* optional */ }
const agentsDir = process.env.MESHCENTRAL_AGENTS || path.resolve(__dirname, '..', '..', '..', 'MeshCentral', 'agents');

function findSpecimens() {
    const out = { signed: null, unsigned: null };
    let names = [];
    try { names = fs.readdirSync(agentsDir).filter(function (f) { return f.toLowerCase().endsWith('.exe'); }); } catch (e) { return out; }
    for (const n of names) {
        const p = path.join(agentsDir, n);
        try {
            const pe = mine.parseWindowsExecutable(p);
            if (pe.CertificateTableAddress && !out.signed) { out.signed = p; }
            if (pe.CertificateTableAddress === 0 && !out.unsigned) { out.unsigned = p; }
        } catch (e) { /* skip non-PE */ }
        if (out.signed && out.unsigned) { break; }
    }
    return out;
}

function refStream(exe, randomPolicy, cb) {
    const chunks = [];
    const w = new Writable({ write: function (c, e, n) { chunks.push(Buffer.from(c)); n(); } });
    w.on('finish', function () { cb(Buffer.concat(chunks)); });
    ref.streamExeWithMeshPolicy({ platform: 'win32', sourceFileName: exe, destinationStream: w, msh: MSH.toString('utf8'), randomPolicy: randomPolicy });
}

function run() {
    console.log('embed-msh-windows.test.js');

    // ---- Self-contained checks (no reference / specimens needed) ----
    // The unsigned branch is platform-agnostic, so exercise it via
    // platform:'linux' where no PE parse happens.
    const fakeBin = Buffer.from('hello-not-a-real-binary');
    const emb = mine.buildEmbeddedBuffer(fakeBin, MSH, { platform: 'linux' });
    ok('linux/unsigned: layout = bin + msh + len(BE) + guid',
        emb.length === fakeBin.length + MSH.length + 20
        && emb.slice(0, fakeBin.length).equals(fakeBin)
        && emb.readUInt32BE(emb.length - 20) === MSH.length
        && emb.slice(emb.length - 16).toString('hex').toUpperCase() === mine.exeMeshPolicyGuid);

    ok('null-policy tag selected by randomPolicy',
        mine.buildEmbeddedBuffer(fakeBin, MSH, { platform: 'linux', randomPolicy: true })
            .slice(-16).toString('hex').toUpperCase() === mine.exeNullPolicyGuid);

    // ---- Reference byte-equivalence + signature preservation ----
    const spec = findSpecimens();
    if (!ref) { skipped('reference byte-equivalence', 'MeshCentral/exeHandler.js not found'); finish(); return; }

    const cases = [];
    if (spec.signed) { cases.push(['signed', spec.signed, false]); cases.push(['signed+randomPolicy', spec.signed, true]); }
    else { skipped('signed byte-equivalence', 'no signed PE specimen'); }
    if (spec.unsigned) { cases.push(['unsigned', spec.unsigned, false]); }
    else { skipped('unsigned byte-equivalence', 'no unsigned PE specimen'); }

    let i = 0;
    (function next() {
        if (i >= cases.length) { finish(); return; }
        const [label, exe, rnd] = cases[i++];
        refStream(exe, rnd, function (refOut) {
            const myOut = mine.buildEmbeddedBuffer(fs.readFileSync(exe), MSH, { platform: 'win32', randomPolicy: rnd });
            ok(label + ': output byte-identical to reference', Buffer.compare(refOut, myOut) === 0);

            if (!rnd) {
                // round-trip
                const tmp = path.join(require('os').tmpdir(), 'embedtest-' + process.pid + '-' + i + '.exe');
                fs.writeFileSync(tmp, myOut);
                const ex = mine.extractMeshPolicy(tmp);
                ok(label + ': embedded MSH round-trips', ex && Buffer.compare(ex.msh, MSH) === 0);

                // Authenticode hash stability + parity with reference hash
                const before = mine.hashExecutableFile({ sourcePath: exe });
                const after = mine.hashExecutableFile({ sourcePath: tmp });
                ok(label + ': Authenticode sha384 stable across embed', before === after);

                const h = crypto.createHash('sha384');
                const w = new Writable({ write: function (c, e, n) { h.update(c); n(); } });
                w.on('finish', function () {
                    ok(label + ': my hash == reference hashExecutableFile', h.digest('hex') === before);
                    try { fs.unlinkSync(tmp); } catch (e) {}
                    next();
                });
                ref.hashExecutableFile({ sourcePath: exe, targetStream: w });
            } else {
                next();
            }
        });
    })();
}

function finish() {
    console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped');
    process.exit(fail === 0 ? 0 : 1);
}

run();
