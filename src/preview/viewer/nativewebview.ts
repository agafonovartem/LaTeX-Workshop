import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { lw } from '../../lw'

const logger = lw.log('Viewer', 'Native')
const active = new WeakMap<vscode.Webview,() => void>()
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** Serve web clients through VS Code's authenticated resource and message channels. */
export async function getNativeContent(pdfUri: vscode.Uri, panel: vscode.WebviewPanel): Promise<string> {
    const webview = panel.webview
    active.get(webview)?.()
    const root = vscode.Uri.file(lw.extensionRoot)
    const parent = pdfUri.with({ path: path.posix.dirname(pdfUri.path) })
    webview.options = { ...webview.options, enableScripts: true, localResourceRoots: [root, parent] }
    const resource = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...parts)).toString()
    const directory = (...parts: string[]) => resource(...parts).replace(/\/$/, '') + '/'
    const port = lw.server.getPort()
    const options = {
        pdfFileUri: pdfUri.toString(true),
        pdfResource: webview.asWebviewUri(pdfUri).toString(),
        workerSrc: resource('node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
        cMapUrl: directory('node_modules', 'pdfjs-dist', 'cmaps'),
        standardFontDataUrl: directory('node_modules', 'pdfjs-dist', 'standard_fonts'),
        wasmUrl: directory('node_modules', 'pdfjs-dist', 'wasm'),
        imageResourcesPath: directory('viewer', 'images')
    }
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: `http://127.0.0.1:${port}` })
    let queue: string[] = []
    let disposed = false
    socket.on('open', () => {
        for (const packet of queue) { socket.send(packet) }
        queue = []
    })
    socket.on('message', data => { void webview.postMessage({ type: 'lw-native-packet', data: data.toString() }) })
    socket.on('error', error => logger.log('Native transport: ' + error.message))
    socket.on('close', () => {
        if (!disposed) { void webview.postMessage({ type: 'lw-native-disconnected' }) }
    })
    const messages = webview.onDidReceiveMessage((message: unknown) => {
        const msg = message as { type?: string, data?: unknown, message?: unknown } | undefined
        if (msg?.type === 'lw-native-packet' && typeof msg.data === 'string' && msg.data.length < 1048576) {
            if (socket.readyState === WebSocket.OPEN) { socket.send(msg.data) }
            else if (socket.readyState === WebSocket.CONNECTING && queue.length < 50) { queue.push(msg.data) }
        } else if (msg?.type === 'lw-native-error') {
            logger.log('Webview error: ' + String(msg.message).slice(0, 500))
        }
    })
    const dispose = () => { disposed = true; messages.dispose(); socket.close(); active.delete(webview) }
    active.set(webview, dispose)
    panel.onDidDispose(dispose)
    let html = await fs.readFile(path.join(lw.extensionRoot, 'viewer', 'viewer.html'), 'utf8')
    html = html.replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '')
    html = html.replace(/\b(src|href)="([^"#][^"]*)"/g, (whole: string, key: string, url: string) => {
        if (/^[a-z]+:/i.test(url)) { return whole }
        const clean = url.replace(/^\.\//, '').split('?')[0]
        const target = clean.startsWith('build/') ? resource('node_modules', 'pdfjs-dist', 'legacy', clean)
            : clean.startsWith('out/') ? resource(clean) : resource('viewer', clean)
        return key + '="' + attribute(target) + '"'
    })
    const nonce = randomBytes(18).toString('base64')
    const source = webview.cspSource
    const policy = `default-src 'none'; script-src ${source} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${source} blob:; style-src ${source} 'unsafe-inline'; img-src ${source} blob: data:; font-src ${source} blob: data:; connect-src ${source} blob: data:; media-src blob:; base-uri 'none'; form-action 'none';`
    const bootstrap = `<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">
<script nonce="${nonce}">
(()=>{
 const api=acquireVsCodeApi();
 globalThis.lwParams=${json(lw.viewer.getParams())};
 const native=globalThis.lwNativeView=${json(options)};
 native.packet=data=>api.postMessage({type:'lw-native-packet',data});
 native.panel=msg=>{
   if(msg.type==='initialized')setTimeout(()=>window.postMessage({type:'restore_state',state:api.getState()?.state||{kind:'not_stored'}},location.origin),0);
   else if(msg.type==='state'){api.setState(msg);api.postMessage(msg);}
   else api.postMessage(msg);
 };
 native.reloadPDF=async()=>{
   const response=await fetch(native.pdfResource,{cache:'no-store'});
   if(!response.ok)throw new Error('PDF resource HTTP '+response.status);
   const old=native.pdfUrl;
   native.pdfUrl=URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:'application/pdf'}));
   if(old)setTimeout(()=>URL.revokeObjectURL(old),10000);
   return native.pdfUrl;
 };
 native.ready=native.reloadPDF();
 native.ready.catch(error=>api.postMessage({type:'lw-native-error',message:error.message}));
 window.addEventListener('error',e=>api.postMessage({type:'lw-native-error',message:e.message}));
 window.addEventListener('unhandledrejection',e=>api.postMessage({type:'lw-native-error',message:String(e.reason?.message||e.reason)}));
})();
</script>`
    html = html.replace(/<head>/i, '<head>' + bootstrap)
    // Workshop appends CSS rules to the last sheet; keep that sheet same-origin.
    html = html.replace(/<\/head>/i, '<style id="lw-native-rules"></style></head>')
    logger.log('Using VS Code resource URIs, bundled blob worker and native messages.')
    return html
}
