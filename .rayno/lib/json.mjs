#!/usr/bin/env node
// Small JSON file helper for the install scripts. Bash 3.2 on macOS has no
// good way to edit JSON, and Node is a requirement anyway.
//
//   json.mjs get  <file> <key>            Print the value ("" when absent).
//   json.mjs has  <file> <key>            Exit 0 when the key exists.
//   json.mjs set  <file> <key> <value>    Set a string value.
//   json.mjs setjson <file> <key> <json>  Set a JSON value (true, 3, {...}).
//   json.mjs init <file> <key> <value>    Set a string value only when absent.
//   json.mjs del  <file> <key>            Remove the key.
//   json.mjs keys <file> <key>            Print the child keys, one per line.
//
// <key> is a dot path, for example "tailscale.3007.added". The file is
// written with mode 600 through a temp file and a rename.

import fs from 'node:fs';
import path from 'node:path';

const [cmd, file, key, value] = process.argv.slice(2);
if (!cmd || !file || key === undefined) {
    console.error('usage: json.mjs <get|has|set|setjson|init|del|keys> <file> <key> [value]');
    process.exit(2);
}

function load() {
    if (!fs.existsSync(file)) return {};
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
}

function save(data) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
}

const parts = key.split('.');

function lookup(data) {
    let node = data;
    for (const p of parts) {
        if (node === null || typeof node !== 'object' || !(p in node)) return undefined;
        node = node[p];
    }
    return node;
}

function parentOf(data, create) {
    let node = data;
    for (const p of parts.slice(0, -1)) {
        if (node[p] === undefined || node[p] === null || typeof node[p] !== 'object') {
            if (!create) return undefined;
            node[p] = {};
        }
        node = node[p];
    }
    return node;
}

const data = load();
const last = parts[parts.length - 1];

switch (cmd) {
    case 'get': {
        const v = lookup(data);
        if (v === undefined || v === null) break;
        process.stdout.write(typeof v === 'object' ? JSON.stringify(v) : String(v));
        break;
    }
    case 'has':
        process.exit(lookup(data) === undefined ? 1 : 0);
    case 'set':
    case 'setjson':
    case 'init': {
        if (value === undefined) {
            console.error(`json.mjs ${cmd}: missing value`);
            process.exit(2);
        }
        if (cmd === 'init' && lookup(data) !== undefined) break;
        parentOf(data, true)[last] = cmd === 'setjson' ? JSON.parse(value) : value;
        save(data);
        break;
    }
    case 'del': {
        const parent = parentOf(data, false);
        if (parent && last in parent) {
            delete parent[last];
            save(data);
        }
        break;
    }
    case 'keys': {
        const v = key === '' ? data : lookup(data);
        if (v && typeof v === 'object') process.stdout.write(Object.keys(v).map(k => k + '\n').join(''));
        break;
    }
    default:
        console.error(`json.mjs: unknown command ${cmd}`);
        process.exit(2);
}
