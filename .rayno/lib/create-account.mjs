#!/usr/bin/env node
// Create a Happy account on a server and sign the Happy CLI in to it.
//
//   create-account.mjs <server url> <access.key path>
//   create-account.mjs --print <access.key path>
//
// The account is a random 32-byte secret, the same as "Create account" in
// the app. The secret is the seed of an Ed25519 key pair. The server gets
// only the public key and a signed challenge, and returns a token.
//
// The secret and the token go into <access.key path> in the CLI's legacy
// format. The recovery key goes to stdout: base32 in groups of 5, the same
// text that the app shows under Settings > Account > Secret Key.
//
// The script refuses to run when <access.key path> exists already.
//
// --print shows the recovery key of an existing legacy access.key. A newer
// login keeps only a public key and a machine key, so it has no recovery key.
// In that case the script prints nothing and exits 1.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function recoveryKey(bytes) {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let base32 = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            base32 += ALPHABET[(value >> bits) & 31];
        }
    }
    if (bits > 0) base32 += ALPHABET[(value << (5 - bits)) & 31];
    return base32.match(/.{1,5}/g).join('-');
}

if (process.argv[2] === '--print') {
    const file = process.argv[3];
    let secret;
    try {
        secret = Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).secret || '', 'base64');
    } catch {
        process.exit(1);
    }
    if (secret.length !== 32) process.exit(1);
    console.log(recoveryKey(secret));
    process.exit(0);
}

const [serverUrl, accessKeyFile] = process.argv.slice(2);
if (!serverUrl || !accessKeyFile) {
    console.error('usage: create-account.mjs <server url> <access.key path>');
    process.exit(2);
}
if (fs.existsSync(accessKeyFile)) {
    console.error(`create-account: ${accessKeyFile} exists already`);
    process.exit(1);
}

// PKCS#8 header for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

const secret = crypto.randomBytes(32);
const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, secret]),
    format: 'der',
    type: 'pkcs8',
});
const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const challenge = crypto.randomBytes(32);
const signature = crypto.sign(null, challenge, privateKey);

const response = await fetch(new URL('/v1/auth', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
        publicKey: publicKey.toString('base64'),
        challenge: challenge.toString('base64'),
        signature: signature.toString('base64'),
    }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok || typeof body.token !== 'string') {
    console.error(`create-account: the server refused the account (HTTP ${response.status})`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(accessKeyFile), { recursive: true, mode: 0o700 });
fs.writeFileSync(
    accessKeyFile,
    JSON.stringify({ secret: secret.toString('base64'), token: body.token }, null, 2),
    { mode: 0o600, flag: 'wx' },
);

console.log(recoveryKey(secret));
