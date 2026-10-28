#!/usr/bin/env node
// Serve the exported happy-app web bundle on its own port.
//
//   web-serve.mjs --root <dir> --port <n> --server-url <url> [--host 127.0.0.1]
//
// The bundle is a single-page app, so an unknown path gets index.html. The
// server address goes into index.html as window.__HAPPY_CONFIG__, which the
// app reads at run time (sources/sync/serverConfig.ts). One build therefore
// works for any host name.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(arg('root', ''));
const port = parseInt(arg('port', '3008'), 10);
const host = arg('host', '127.0.0.1');
const serverUrl = arg('server-url', '');

if (!root || !fs.existsSync(path.join(root, 'index.html'))) {
    console.error(`web-serve: no index.html in ${root}`);
    process.exit(1);
}
if (!serverUrl) {
    console.error('web-serve: --server-url is required');
    process.exit(1);
}

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
};

// JSON.stringify does not escape "<", so a "</script>" in the URL could end
// the tag early. Escape it.
const config = JSON.stringify({ serverUrl }).replace(/</g, '\\u003c');
const indexHtml = fs
    .readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('<head>', `<head><script>window.__HAPPY_CONFIG__ = ${config};</script>`);

function sendIndex(res) {
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
    res.end(indexHtml);
}

const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
    }
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
        res.writeHead(400);
        res.end();
        return;
    }
    const file = path.join(root, pathname);
    // Refuse anything that resolves outside the bundle.
    if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
    }
    if (pathname === '/' || pathname === '/index.html') {
        sendIndex(res);
        return;
    }
    fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) {
            // A path with a file extension is a missing asset, not an app route.
            if (path.extname(pathname)) {
                res.writeHead(404);
                res.end();
            } else {
                sendIndex(res);
            }
            return;
        }
        // Expo puts a content hash in the bundle file names, so they can be cached.
        const immutable = pathname.startsWith('/_expo/') || pathname.startsWith('/assets/');
        res.writeHead(200, {
            'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'content-length': stat.size,
            'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        fs.createReadStream(file).pipe(res);
    });
});

server.listen(port, host, () => {
    console.log(`web-serve: ${root} on http://${host}:${port} (server ${serverUrl})`);
});
