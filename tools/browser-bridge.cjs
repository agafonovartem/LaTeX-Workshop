'use strict';
// Keep one loopback port for VS Code's private tunnel; extension sessions use port 0.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const logRoot = process.env.LW_LOG_ROOT || path.join(os.homedir(), '.vscode-server/data/logs');
const listenPort = Number(process.env.LW_BRIDGE_PORT || 34567);
let cached;
let lastTarget;
let originConfig;
function externalOrigin() {
    if (!originConfig || Date.now() > originConfig.expires) {
        try {
            const settingsPath = process.env.LW_MACHINE_SETTINGS || path.join(os.homedir(), '.vscode-server/data/Machine/settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const url = new URL(settings['latex-workshop.view.pdf.internal.urlPrefix']);
            originConfig = {expires:Date.now()+2000, origin:url.origin, host:url.host, protocol:url.protocol.slice(0,-1)};
        } catch { originConfig = {expires:Date.now()+2000}; }
    }
    return originConfig;
}
function forwardHeaders(req, port) {
    const headers = {...req.headers, host:'127.0.0.1:'+port};
    const external = externalOrigin();
    // Dev Tunnels rewrites browser Origin to its local forwarding destination.
    // Restore only our configured tunnel origin, with matching proxy metadata.
    if ((headers.origin === 'http://localhost:'+listenPort || headers.origin === 'http://127.0.0.1:'+listenPort)
        && external.origin && headers['x-forwarded-host'] === external.host
        && headers['x-forwarded-proto'] === external.protocol) {
        headers.origin = external.origin;
    }
    return headers;
}
function requestKind(req) {
    const route = (req.url || '').split('?')[0];
    return route.startsWith('/pdf..') ? 'PDF' : ['/viewer.html','/build/pdf.mjs','/out/viewer/latexworkshop.js','/config.json'].includes(route) ? route : undefined;
}
function browserKind(req) {
    const ua = req.headers['user-agent'] || '';
    return ua.includes('Chrome/') ? 'Chrome' : ua.includes('Safari/') ? 'Safari' : 'other';
}
function dirs(dir) {
    try { return fs.readdirSync(dir, {withFileTypes:true}).filter(e => e.isDirectory()).map(e => e.name); }
    catch { return []; }
}
function candidates() {
    const found = [];
    for (const run of dirs(logRoot).sort().reverse().slice(0, 3)) {
        for (const host of dirs(path.join(logRoot, run)).filter(n => /^exthost\d+$/.test(n))) {
            const hostDir = path.join(logRoot, run, host);
            for (const output of dirs(hostDir).filter(n => n.startsWith('output_logging_'))) {
                const outputDir = path.join(hostDir, output);
                let names;
                try { names = fs.readdirSync(outputDir).filter(n => /LaTeX Workshop.*\.log$/.test(n)); }
                catch { continue; }
                for (const name of names) {
                    let fd;
                    try {
                        fd = fs.openSync(path.join(outputDir, name), 'r');
                        const buf = Buffer.alloc(65536);
                        const text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString();
                        for (const m of text.matchAll(/Server successfully started: (\{[^\n]+?\})/g)) {
                            const address = JSON.parse(m[1]);
                            if (address.address === '127.0.0.1' && Number.isInteger(address.port) && address.port > 0 && address.port < 65536 && address.port !== listenPort) {
                                found.push({port:address.port, order:run + '/' + output});
                            }
                        }
                    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
                }
            }
        }
    }
    found.sort((a,b) => b.order.localeCompare(a.order));
    return [...new Set(found.map(v => v.port))].slice(0, 10);
}
function isViewer(port) {
    return new Promise(resolve => {
        let done = false;
        const finish = value => { if (!done) { done = true; resolve(value); } };
        const req = http.get({hostname:'127.0.0.1', port, path:'/config.json', timeout:600}, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; if (data.length > 16384) req.destroy(); });
            res.on('end', () => {
                try { const c = JSON.parse(data); finish(res.statusCode === 200 && !!c.sidebar && !!c.keybindings); }
                catch { finish(false); }
            });
            res.on('error', () => finish(false));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => finish(false));
    });
}
async function target() {
    if (!cached || Date.now() > cached.expires) {
        const promise = (async () => {
            for (const port of candidates()) {
                if (await isViewer(port)) {
                    if (lastTarget !== port) { console.log(new Date().toISOString(), 'PDF session port', port); lastTarget = port; }
                    return port;
                }
            }
            throw new Error('No active LaTeX Workshop viewer');
        })();
        cached = {expires:Date.now()+1500, promise};
    }
    return cached.promise;
}
const server = http.createServer(async (req,res) => {
    try {
        const port = await target();
        const headers = forwardHeaders(req, port);
        const upstream = http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers}, remote => {
            const kind = requestKind(req);
            if (kind) console.log(new Date().toISOString(), browserKind(req), kind, remote.statusCode, 'origin-restored', headers.origin !== req.headers.origin);
            res.writeHead(remote.statusCode, remote.headers);
            remote.pipe(res);
        });
        upstream.on('error', () => { cached = undefined; if (!res.headersSent) res.writeHead(502); res.end('PDF session changed; reopen the viewer.'); });
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
    } catch {
        res.writeHead(503, {'Content-Type':'text/plain; charset=utf-8','Retry-After':'2'});
        res.end('Open a PDF with LaTeX Workshop in VS Code, then refresh this viewer.');
    }
});
server.on('upgrade', async (req,socket,head) => {
    try {
        const port = await target();
        const upstream = http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:forwardHeaders(req, port)});
        upstream.on('upgrade', (res,remote,remoteHead) => {
            console.log(new Date().toISOString(), browserKind(req), 'WebSocket', res.statusCode);
            const headers = res.rawHeaders.reduce((s,v,i,a) => i % 2 ? s : s + v + ': ' + a[i+1] + '\r\n','');
            socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${headers}\r\n`);
            if (remoteHead.length) socket.write(remoteHead);
            if (head.length) remote.write(head);
            socket.pipe(remote); remote.pipe(socket);
            socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
            socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
        });
        upstream.on('response', res => { res.resume(); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
        upstream.on('error', () => { cached = undefined; socket.destroy(); });
        socket.on('error', () => upstream.destroy());
        upstream.end();
    } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
});
server.on('error', err => { console.error(new Date().toISOString(), err.code); process.exit(1); });
server.listen(listenPort,'127.0.0.1', () => console.log(new Date().toISOString(),'PDF bridge on loopback port',listenPort));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
