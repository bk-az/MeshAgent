#!/usr/bin/env node
/*
 * embed-msh-windows.js
 *
 * Embeds a tenant ".msh" settings file into a Windows MeshAgent ".exe",
 * file-in / file-out, for the "sign once, provision per tenant" model.
 *
 * Why this exists / how it differs from ../MeshCentral/exeHandler.js:
 *   exeHandler.js implements the same byte format but STREAMS the result into
 *   an HTTP response inside the MeshCentral server (one download per browser
 *   request). This is the packaging-side counterpart: it takes a signed .exe
 *   plus a .msh on disk and writes a new .exe on disk, so a build/deployment
 *   pipeline can stamp each tenant's configuration into an already-signed,
 *   already-notarized binary without ever re-signing it. The macOS story in
 *   ../macos keeps the .msh outside the package; on Windows the equivalent is
 *   to place it INSIDE the Authenticode certificate table, where it does not
 *   affect the signature (see below).
 *
 * The load-bearing trick (signed binaries):
 *   An Authenticode signature does NOT cover three regions of a PE file: the
 *   optional-header CheckSum (4 bytes), the certificate-table data directory
 *   entry (8 bytes), and the attribute certificate table itself. This tool
 *   appends the MSH at the very end of the file but accounts for it by
 *   GROWING the certificate table (both the data-directory size field and the
 *   WIN_CERTIFICATE dwLength). Because that region is excluded from the
 *   Authenticode hash, the Microsoft signature stays valid -- so you sign +
 *   timestamp the .exe once per release and stamp every tenant's .msh in
 *   afterwards with no certificate involved.
 *
 *   For an UNSIGNED binary (or a non-PE file) there is no certificate table,
 *   so the MSH is simply appended. The agent finds it either way by reading
 *   the trailing GUID + length.
 *
 * Trailer layout (what the agent looks for at end-of-file):
 *   [ ...msh bytes... ][ msh length, 4 bytes BIG-endian ][ 16-byte GUID ]
 *   The GUID is exeMeshPolicyGuid for a real tenant config, or
 *   exeNullPolicyGuid when --random-policy is used (fixed-length filler, so the
 *   output length is identical regardless of the tenant -- see that flag).
 *
 * This output is byte-for-byte identical to what exeHandler.js's
 * streamExeWithMeshPolicy() produces; that equivalence is checked in
 * embed-msh-windows.test.js against the real reference module.
 *
 * Usage:
 *   node embed-msh-windows.js <signed-agent.exe> <tenant.msh> <output.exe> [options]
 *
 * Options:
 *   --random-policy   Tag with the null-policy GUID (fixed-length filler case)
 *   --force           Overwrite <output.exe> if it exists
 *   --verify          After writing, re-read <output.exe> and confirm the MSH
 *                     round-trips and (for signed input) the Authenticode hash
 *                     is unchanged from the source
 *
 * Inspecting / verifying an existing binary instead of embedding:
 *   node embed-msh-windows.js --info    <agent.exe>          PE + embedded-MSH summary
 *   node embed-msh-windows.js --extract <agent.exe> [out.msh]  dump the embedded .msh
 *   node embed-msh-windows.js --hash    <agent.exe>          Authenticode-stable sha384
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 16-byte markers written as the final bytes of the file. Identical to the
// values in ../MeshCentral/exeHandler.js -- the agent recognizes these exact
// GUIDs, so they must never be changed here.
const exeJavaScriptGuid = 'B996015880544A19B7F7E9BE44914C18';
const exeMeshPolicyGuid = 'B996015880544A19B7F7E9BE44914C19';
const exeNullPolicyGuid = 'B996015880544A19B7F7E9BE44914C20';

// Bytes appended after the MSH content: 4-byte length + 16-byte GUID.
const TRAILER_OVERHEAD = 20;

// --------------------------------------------------------------------------
// PE parsing -- returns the offsets the embed/hash logic depends on.
// Faithful to exeHandler.js.parseWindowsExecutable, with arm64 machine
// recognition added (it already parsed as PE32+, only the format label was
// missing). Throws on anything that is not a PE.
// --------------------------------------------------------------------------
function parseWindowsExecutable(exePath) {
    const retVal = {};
    const fd = fs.openSync(exePath, 'r');
    try {
        const dosHeader = Buffer.alloc(64);
        const ntHeader = Buffer.alloc(24);

        // DOS header -- "MZ"
        fs.readSync(fd, dosHeader, 0, 64, 0);
        if (dosHeader.readUInt16LE(0).toString(16).toUpperCase() !== '5A4D') { throw new Error('unrecognized binary format (no MZ signature)'); }

        const ntOffset = dosHeader.readUInt32LE(60);

        // NT header -- "PE\0\0"
        fs.readSync(fd, ntHeader, 0, ntHeader.length, ntOffset);
        if (ntHeader.slice(0, 4).toString('hex') !== '50450000') { throw new Error('not a PE file (no PE signature)'); }

        switch (ntHeader.readUInt16LE(4).toString(16)) {
            case '14c': retVal.format = 'x86'; break;   // IMAGE_FILE_MACHINE_I386
            case '8664': retVal.format = 'x64'; break;  // IMAGE_FILE_MACHINE_AMD64
            case 'aa64': retVal.format = 'arm64'; break;// IMAGE_FILE_MACHINE_ARM64
            case '1c0': retVal.format = 'arm'; break;   // IMAGE_FILE_MACHINE_ARM
            default: retVal.format = undefined; break;
        }

        retVal.optionalHeaderSize = ntHeader.readUInt16LE(20);
        retVal.optionalHeaderSizeAddress = ntOffset + 20;

        const optHeader = Buffer.alloc(ntHeader.readUInt16LE(20));
        fs.readSync(fd, optHeader, 0, optHeader.length, ntOffset + 24);

        retVal.CheckSumPos = ntOffset + 24 + 64;
        retVal.SizeOfCode = optHeader.readUInt32LE(4);
        retVal.SizeOfInitializedData = optHeader.readUInt32LE(8);
        retVal.SizeOfUnInitializedData = optHeader.readUInt32LE(12);

        let numRVA;
        switch (optHeader.readUInt16LE(0).toString(16).toUpperCase()) {
            case '10B': // PE32 (32-bit)
                numRVA = optHeader.readUInt32LE(92);
                retVal.CertificateTableAddress = optHeader.readUInt32LE(128);
                retVal.CertificateTableSize = optHeader.readUInt32LE(132);
                retVal.CertificateTableSizePos = ntOffset + 24 + 132;
                retVal.rvaStartAddress = ntOffset + 24 + 96;
                break;
            case '20B': // PE32+ (64-bit, incl. arm64)
                numRVA = optHeader.readUInt32LE(108);
                retVal.CertificateTableAddress = optHeader.readUInt32LE(144);
                retVal.CertificateTableSize = optHeader.readUInt32LE(148);
                retVal.CertificateTableSizePos = ntOffset + 24 + 148;
                retVal.rvaStartAddress = ntOffset + 24 + 112;
                break;
            default:
                throw new Error('unknown optional-header magic: 0x' + optHeader.readUInt16LE(0).toString(16));
        }
        retVal.rvaCount = numRVA;

        if (retVal.CertificateTableAddress) {
            // Read the first (only) WIN_CERTIFICATE header: dwLength (4) + revision (2) + type (2)
            const hdr = Buffer.alloc(8);
            fs.readSync(fd, hdr, 0, hdr.length, retVal.CertificateTableAddress);
            retVal.certificateDwLength = hdr.readUInt32LE(0);
            const cert = Buffer.alloc(retVal.certificateDwLength);
            fs.readSync(fd, cert, 0, cert.length, retVal.CertificateTableAddress + hdr.length);
            retVal.certificate = cert.toString('base64');
        }
        return retVal;
    } finally {
        fs.closeSync(fd);
    }
}

// --------------------------------------------------------------------------
// Core: build the output buffer with the MSH embedded. Buffer-in / buffer-out
// so it is trivially testable; the CLI and file helper wrap it. The byte
// layout mirrors exeHandler.js exactly for both branches.
// --------------------------------------------------------------------------
function buildEmbeddedBuffer(sourceBuf, mshBuf, opts) {
    opts = opts || {};
    const platform = opts.platform || 'win32';
    const guid = Buffer.from(opts.randomPolicy === true ? exeNullPolicyGuid : exeMeshPolicyGuid, 'hex');

    const lenBE = Buffer.alloc(4);
    lenBE.writeUInt32BE(mshBuf.length, 0);

    const peinfo = opts.peinfo || ((platform === 'win32') ? parseWindowsExecutable_fromBuffer(sourceBuf) : null);

    // Unsigned Windows, or non-Windows: plain append, no header patching.
    if (platform !== 'win32' || peinfo.CertificateTableAddress === 0) {
        return Buffer.concat([sourceBuf, mshBuf, lenBE, guid]);
    }

    // Signed Windows: grow the certificate table so the appended MSH sits
    // inside the (unsigned) certificate region.
    const dwLen = peinfo.certificateDwLength;
    const padding = (8 - ((dwLen + mshBuf.length + TRAILER_OVERHEAD) % 8)) % 8; // quad-align
    const delta = mshBuf.length + TRAILER_OVERHEAD + padding;

    const newCertTableSize = Buffer.alloc(4);
    newCertTableSize.writeUInt32LE(peinfo.CertificateTableSize + delta, 0);
    const newDwLength = Buffer.alloc(4);
    newDwLength.writeUInt32LE(peinfo.certificateDwLength + delta, 0);

    const seg1 = sourceBuf.slice(0, peinfo.CertificateTableSizePos);                              // up to & incl. cert-table SIZE field start
    const seg2 = sourceBuf.slice(peinfo.CertificateTableSizePos + 4, peinfo.CertificateTableAddress); // gap up to WIN_CERTIFICATE dwLength
    const seg3 = sourceBuf.slice(peinfo.CertificateTableAddress + 4);                             // rest of the file after dwLength

    const parts = [seg1, newCertTableSize, seg2, newDwLength, seg3];
    if (padding > 0) { parts.push(Buffer.alloc(padding)); }
    parts.push(mshBuf, lenBE, guid);
    return Buffer.concat(parts);
}

// Same parse as parseWindowsExecutable but from an in-memory buffer, so the
// core does not re-read the file it was already handed.
function parseWindowsExecutable_fromBuffer(buf) {
    if (buf.readUInt16LE(0).toString(16).toUpperCase() !== '5A4D') { throw new Error('unrecognized binary format (no MZ signature)'); }
    const ntOffset = buf.readUInt32LE(60);
    if (buf.slice(ntOffset, ntOffset + 4).toString('hex') !== '50450000') { throw new Error('not a PE file (no PE signature)'); }
    const retVal = { CheckSumPos: ntOffset + 24 + 64 };
    const optOffset = ntOffset + 24;
    switch (buf.readUInt16LE(optOffset).toString(16).toUpperCase()) {
        case '10B':
            retVal.CertificateTableAddress = buf.readUInt32LE(optOffset + 128);
            retVal.CertificateTableSize = buf.readUInt32LE(optOffset + 132);
            retVal.CertificateTableSizePos = optOffset + 132;
            break;
        case '20B':
            retVal.CertificateTableAddress = buf.readUInt32LE(optOffset + 144);
            retVal.CertificateTableSize = buf.readUInt32LE(optOffset + 148);
            retVal.CertificateTableSizePos = optOffset + 148;
            break;
        default:
            throw new Error('unknown optional-header magic: 0x' + buf.readUInt16LE(optOffset).toString(16));
    }
    if (retVal.CertificateTableAddress) {
        retVal.certificateDwLength = buf.readUInt32LE(retVal.CertificateTableAddress);
    }
    return retVal;
}

// --------------------------------------------------------------------------
// File-in / file-out entry point. Returns a small summary object.
// --------------------------------------------------------------------------
function embedMeshPolicyFile(opts) {
    if (!opts.sourcePath) { throw new Error('sourcePath is required'); }
    if (!opts.destPath) { throw new Error('destPath is required'); }
    if (opts.msh == null) { throw new Error('msh content is required'); }

    if (!opts.force && fs.existsSync(opts.destPath)) {
        throw new Error('destination exists (use force to overwrite): ' + opts.destPath);
    }

    const sourceBuf = fs.readFileSync(opts.sourcePath);
    const mshBuf = Buffer.isBuffer(opts.msh) ? opts.msh : Buffer.from(opts.msh, 'utf8');
    if (mshBuf.length === 0) { throw new Error('msh content is empty'); }

    const platform = opts.platform || 'win32';
    let peinfo = null;
    if (platform === 'win32') { peinfo = parseWindowsExecutable(opts.sourcePath); }

    const out = buildEmbeddedBuffer(sourceBuf, mshBuf, {
        platform: platform, randomPolicy: opts.randomPolicy, peinfo: peinfo
    });

    // Write atomically: temp file in the same directory, then rename.
    const tmp = opts.destPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, opts.destPath);

    return {
        signed: !!(peinfo && peinfo.CertificateTableAddress),
        format: peinfo ? peinfo.format : platform,
        sourceSize: sourceBuf.length,
        outputSize: out.length,
        mshSize: mshBuf.length,
        randomPolicy: opts.randomPolicy === true
    };
}

// --------------------------------------------------------------------------
// Authenticode-stable hash (sha384, matching MeshCentral). Zeroes the
// checksum (4 bytes) and the certificate-table directory entry (8 bytes), and
// stops before the certificate table -- so signing, or embedding an MSH,
// does not change the hash. Sync, returns hex. Faithful to
// exeHandler.js.hashExecutableFile's byte selection.
// --------------------------------------------------------------------------
function hashExecutableFile(opts) {
    if (!opts.sourcePath) { throw new Error('sourcePath is required'); }
    const algo = opts.algorithm || 'sha384';
    let platform = opts.platform;
    let peinfo = null;
    if (!platform) {
        try { peinfo = parseWindowsExecutable(opts.sourcePath); platform = 'win32'; }
        catch (e) { platform = 'other'; }
    } else if (platform === 'win32') {
        peinfo = parseWindowsExecutable(opts.sourcePath);
    }

    const buf = fs.readFileSync(opts.sourcePath);
    const hash = crypto.createHash(algo);

    let endIndex = 0, checkSumIndex = 0, tableIndex = 0;
    if (platform === 'win32') {
        if (peinfo.CertificateTableAddress !== 0) { endIndex = peinfo.CertificateTableAddress; }
        tableIndex = peinfo.CertificateTableSizePos - 4; // start of the 8-byte cert-table directory entry
        checkSumIndex = peinfo.CheckSumPos;
    }

    if (endIndex === 0) {
        // Unsigned: trim a trailing mesh-policy MSH so the base hash is stable
        // whether or not a .msh has been embedded -- this is the documented
        // intent ("a .msh addition will not change the hash"). Two deliberate
        // corrections vs ../MeshCentral/exeHandler.js, whose trim never fires:
        //   - it compares a lowercase hex string to an UPPERCASE GUID constant
        //     (so the branch is dead); we lowercase the constant.
        //   - the trailer length is written big-endian (writeUInt32BE) but the
        //     reference reads it little-endian; we read it big-endian to match
        //     what was actually written.
        // Only a mesh-policy trailer is trimmed (matching the reference's
        // choice not to trim the null-policy filler case).
        if (buf.length >= TRAILER_OVERHEAD && buf.slice(buf.length - 16).toString('hex') === exeMeshPolicyGuid.toLowerCase()) {
            const mshLen = buf.readUInt32BE(buf.length - TRAILER_OVERHEAD);
            endIndex = buf.length - TRAILER_OVERHEAD - mshLen;
        } else {
            endIndex = buf.length;
        }
    }

    if (checkSumIndex !== 0) {
        hash.update(buf.slice(0, checkSumIndex));
        hash.update(Buffer.alloc(4));                             // zeroed checksum
        hash.update(buf.slice(checkSumIndex + 4, tableIndex));
        hash.update(Buffer.alloc(8));                             // zeroed cert-table directory entry
        hash.update(buf.slice(tableIndex + 8, endIndex));
    } else {
        hash.update(buf.slice(0, endIndex));
    }
    return hash.digest('hex');
}

// --------------------------------------------------------------------------
// Read back an embedded MSH, if present. Returns { policy, msh } or null.
// --------------------------------------------------------------------------
function extractMeshPolicy(exePath) {
    const buf = fs.readFileSync(exePath);
    if (buf.length < TRAILER_OVERHEAD) { return null; }
    const guid = buf.slice(buf.length - 16).toString('hex').toUpperCase();
    let policy;
    if (guid === exeMeshPolicyGuid) { policy = 'mesh'; }
    else if (guid === exeNullPolicyGuid) { policy = 'null'; }
    else { return null; }
    const mshLen = buf.readUInt32BE(buf.length - TRAILER_OVERHEAD);
    const start = buf.length - TRAILER_OVERHEAD - mshLen;
    if (start < 0) { return null; }
    return { policy: policy, msh: buf.slice(start, buf.length - TRAILER_OVERHEAD) };
}

// --------------------------------------------------------------------------
// Streaming variant, for API-parity with ../MeshCentral/exeHandler.js. Writes
// the (identical) bytes to a destination stream and ends it. Provided so this
// module can also serve server-style callers; the packaging path uses
// embedMeshPolicyFile.
// --------------------------------------------------------------------------
function streamExeWithMeshPolicy(options) {
    if (!options.platform) { throw new Error('platform not specified'); }
    if (!options.destinationStream) { throw new Error('destination stream was not specified'); }
    if (!options.sourceFileName) { throw new Error('source file not specified'); }
    if (!options.msh) { throw new Error('msh content not specified'); }
    const sourceBuf = fs.readFileSync(options.sourceFileName);
    const mshBuf = Buffer.from(options.msh, 'utf8');
    const peinfo = (options.platform === 'win32') ? (options.peinfo || parseWindowsExecutable(options.sourceFileName)) : null;
    const out = buildEmbeddedBuffer(sourceBuf, mshBuf, { platform: options.platform, randomPolicy: options.randomPolicy, peinfo: peinfo });
    options.destinationStream.end(out);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function printHelp() {
    console.log([
        'Embed a tenant .msh into a Windows MeshAgent .exe (signature-preserving).',
        '',
        'Usage:',
        '  node embed-msh-windows.js <signed-agent.exe> <tenant.msh> <output.exe> [options]',
        '',
        'Options:',
        '  --random-policy   Tag with the null-policy GUID (fixed-length filler case)',
        '  --force           Overwrite <output.exe> if it already exists',
        '  --verify          Re-read the output and confirm the MSH round-trips and,',
        '                    for signed input, the Authenticode hash is unchanged',
        '',
        'Inspect an existing binary instead of embedding:',
        '  node embed-msh-windows.js --info    <agent.exe>',
        '  node embed-msh-windows.js --extract <agent.exe> [out.msh]',
        '  node embed-msh-windows.js --hash    <agent.exe>',
        '',
        'The .exe is signed + timestamped ONCE per release; this stamps each',
        'tenant .msh in afterwards with no re-signing (the MSH lands in the',
        "Authenticode certificate table, which the signature does not cover)."
    ].join('\n'));
}

function main(argv) {
    const args = argv.slice(2);
    if (args.length === 0 || args[0] === '-h' || args[0] === '--help') { printHelp(); process.exit(args.length === 0 ? 1 : 0); }

    // Inspection sub-commands
    if (args[0] === '--info') {
        const pe = parseWindowsExecutable(args[1]);
        const embedded = extractMeshPolicy(args[1]);
        console.log('format:                ' + pe.format);
        console.log('signed:                ' + (pe.CertificateTableAddress ? 'yes' : 'no'));
        console.log('CertificateTableAddr:  ' + pe.CertificateTableAddress);
        console.log('CertificateTableSize:  ' + pe.CertificateTableSize);
        if (pe.CertificateTableAddress) { console.log('certificate dwLength:  ' + pe.certificateDwLength); }
        console.log('authenticode sha384:   ' + hashExecutableFile({ sourcePath: args[1] }));
        console.log('embedded MSH:          ' + (embedded ? (embedded.policy + '-policy, ' + embedded.msh.length + ' bytes') : 'none'));
        return;
    }
    if (args[0] === '--extract') {
        const embedded = extractMeshPolicy(args[1]);
        if (!embedded) { console.error('No embedded MSH found in ' + args[1]); process.exit(1); }
        if (args[2]) { fs.writeFileSync(args[2], embedded.msh); console.log('Wrote ' + args[2] + ' (' + embedded.msh.length + ' bytes, ' + embedded.policy + '-policy)'); }
        else { process.stdout.write(embedded.msh); }
        return;
    }
    if (args[0] === '--hash') {
        console.log(hashExecutableFile({ sourcePath: args[1] }));
        return;
    }

    // Embed: <exe> <msh> <out> [flags]
    const positional = [];
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--random-policy') { opts.randomPolicy = true; }
        else if (args[i] === '--force') { opts.force = true; }
        else if (args[i] === '--verify') { opts.verify = true; }
        else { positional.push(args[i]); }
    }
    if (positional.length < 3) { console.error('Expected: <agent.exe> <tenant.msh> <output.exe>'); process.exit(1); }

    const [sourcePath, mshPath, destPath] = positional;
    const msh = fs.readFileSync(mshPath);

    // Warn about likely-wrong configs before shipping to a fleet.
    const text = msh.toString('utf8');
    if (opts.randomPolicy !== true) {
        const missing = ['MeshServer', 'MeshID', 'ServerID'].filter(function (k) { return !(new RegExp('^[ \\t]*' + k + '=', 'm')).test(text); });
        if (missing.length) { console.warn('WARNING: .msh has no ' + missing.join(', ') + ' line(s); the agent may not connect.'); }
        if (text.indexOf('\r\n') === -1) { console.warn('WARNING: .msh is not CRLF; MeshCentral-generated files are.'); }
    }

    const beforeHash = (function () { try { return hashExecutableFile({ sourcePath: sourcePath }); } catch (e) { return null; } })();
    const res = embedMeshPolicyFile({ sourcePath: sourcePath, destPath: destPath, msh: msh, randomPolicy: opts.randomPolicy, force: opts.force });

    console.log('Wrote ' + destPath);
    console.log('  input:  ' + path.basename(sourcePath) + ' (' + res.format + ', ' + (res.signed ? 'signed' : 'unsigned') + ', ' + res.sourceSize + ' bytes)');
    console.log('  msh:    ' + path.basename(mshPath) + ' (' + res.mshSize + ' bytes' + (res.randomPolicy ? ', null-policy' : '') + ')');
    console.log('  output: ' + res.outputSize + ' bytes');

    if (opts.verify) {
        const embedded = extractMeshPolicy(destPath);
        if (!embedded || Buffer.compare(embedded.msh, msh) !== 0) { console.error('VERIFY FAILED: embedded MSH does not match source .msh'); process.exit(2); }
        if (res.signed) {
            const afterHash = hashExecutableFile({ sourcePath: destPath });
            if (beforeHash && afterHash !== beforeHash) { console.error('VERIFY FAILED: Authenticode hash changed (' + beforeHash + ' -> ' + afterHash + ')'); process.exit(2); }
            console.log('  verify: MSH round-trips; Authenticode hash unchanged (signature preserved)');
        } else {
            console.log('  verify: MSH round-trips (unsigned input; hash intentionally changes)');
        }
    } else if (res.signed) {
        console.log('  (signed input: the Authenticode signature is preserved -- no re-signing needed)');
    }
}

if (require.main === module) {
    try { main(process.argv); }
    catch (e) { console.error(e.message || e); process.exit(1); }
}

module.exports = {
    parseWindowsExecutable: parseWindowsExecutable,
    embedMeshPolicyFile: embedMeshPolicyFile,
    buildEmbeddedBuffer: buildEmbeddedBuffer,
    hashExecutableFile: hashExecutableFile,
    extractMeshPolicy: extractMeshPolicy,
    streamExeWithMeshPolicy: streamExeWithMeshPolicy,
    exeJavaScriptGuid: exeJavaScriptGuid,
    exeMeshPolicyGuid: exeMeshPolicyGuid,
    exeNullPolicyGuid: exeNullPolicyGuid
};
