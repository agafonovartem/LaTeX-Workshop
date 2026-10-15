'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Module=require('node:module');
const http=require('node:http');
const {pathToFileURL}=require('node:url');
const WS=require('ws');
const root=path.resolve(__dirname,'..');
class Uri {
 constructor(p){this.path=p;this.fsPath=p;this.scheme='file';}
 with(c){return new Uri(c.path??this.path);}
 toString(){return 'file://'+encodeURI(this.path);}
 static file(p){return new Uri(p);}
 static joinPath(u,...parts){return new Uri(path.posix.join(u.path,...parts));}
}
function mockedModule(relative,vscode,lw,extra={}) {
 const filename=path.join(root,relative);const mod=new Module(filename,module);
 mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));
 const original=Module._load;
 Module._load=function(request,...args){
  if(request==='vscode')return vscode;
  if(request==='../../lw'||request==='../lw')return {lw};
  if(request in extra)return extra[request];
  return original.call(this,request,...args);
 };
 try{mod._compile(fs.readFileSync(filename,'utf8'),filename);}finally{Module._load=original;}
 return mod.exports;
}
test('webview uses scoped VS Code resources and bidirectional messages',async t=>{
 const server=http.createServer();const wss=new WS.Server({server});
 wss.on('connection',socket=>socket.on('message',m=>socket.send(JSON.stringify({type:'echo',data:m.toString()}))));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let dispose; t.after(async()=>{dispose?.();wss.close();await new Promise(r=>server.close(r));});
 const lw={extensionRoot:root,server:{getPort:()=>server.address().port},viewer:{getParams:()=>({scale:'page-width'})},log:()=>({log(){}})};
 const native=mockedModule('out/src/preview/viewer/nativewebview.js',{Uri},lw);
 let receive;const posted=[];
 const webview={options:{},cspSource:'https://resources.vscode.example',asWebviewUri:u=>({toString:()=> 'https://resources.vscode.example'+encodeURI(u.path)}),onDidReceiveMessage:cb=>{receive=cb;return {dispose(){}}},postMessage:msg=>{posted.push(msg);return Promise.resolve(true)}};
 const panel={webview,onDidDispose:cb=>{dispose=cb;return {dispose(){}}}};
 const pdf=Uri.file('/workspace/paper/main.pdf');const html=await native.getNativeContent(pdf,panel);
 assert.doesNotMatch(html,/<iframe\b|devtunnels\.ms/i);
 assert.equal((html.match(/http-equiv="Content-Security-Policy"/g)||[]).length,1);
 assert.equal(webview.options.localResourceRoots[1].path,'/workspace/paper');
 for(const match of html.matchAll(/<script[^>]+src="([^"]+)"/g))assert.ok(match[1].startsWith('https://resources.vscode.example/'));
 assert.ok(html.includes('/node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
 new vm.Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
 receive({type:'lw-native-packet',data:JSON.stringify({type:'ping'})});
 for(let i=0;i<100&&!posted.length;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(JSON.parse(posted[0].data).type,'echo');
});
test('View in web browser accepts the focused PDF without an active text editor',async()=>{
 const pdf=Uri.file('/workspace/paper/main.pdf');class TabInputCustom {constructor(uri){this.uri=uri;}}
 const calls=[];const vscode={Uri,TabInputCustom,window:{activeTextEditor:undefined,tabGroups:{activeTabGroup:{activeTab:{input:new TabInputCustom(pdf)}}}}};
 const lw={log:()=>({log(){}}),viewer:{view:async(...args)=>calls.push(args)}};
 const commands=mockedModule('out/src/core/commands.js',vscode,lw,{'../utils/utils':{}});
 await commands.view('browser');assert.deepEqual(calls,[[pdf,'browser']]);
 await commands.view(pdf);assert.deepEqual(calls[1],[pdf,undefined]);
});
test('native worker is the complete bundled source in a blob URI; SyncTeX keeps original URI',async()=>{
 const native=await import(pathToFileURL(path.join(root,'out/viewer/components/nativeview.js')));
 const actual=fs.readFileSync(path.join(root,'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'));
 const previousFetch=globalThis.fetch;const urls=[];const originalCreate=URL.createObjectURL;
 let captured;
 globalThis.lwNativeView={pdfFileUri:'file:///workspace/paper/main.pdf',workerSrc:'https://resources.test/worker.mjs',ready:Promise.resolve()};
 globalThis.fetch=async()=>new Response(actual);
 URL.createObjectURL=blob=>{captured=blob;const value=originalCreate(blob);urls.push(value);return value;};
 try{
  await native.prepareNativeWorker();assert.match(globalThis.lwNativeView.workerSrc,/^blob:/);assert.deepEqual(Buffer.from(await captured.arrayBuffer()),actual);
  globalThis.window={btoa:s=>Buffer.from(s,'binary').toString('base64')};
  const utils=await import(pathToFileURL(path.join(root,'out/viewer/components/utils.js')));
  assert.equal(utils.parseURL().pdfFileUri,'file:///workspace/paper/main.pdf');
 }finally{globalThis.fetch=previousFetch;URL.createObjectURL=originalCreate;for(const url of urls)URL.revokeObjectURL(url);delete globalThis.lwNativeView;delete globalThis.window;}
});
test('iPad wheel scrolls the PDF and preserves zoom gestures',async()=>{
 const native=await import(pathToFileURL(path.join(root,'out/viewer/components/nativeinput.js')));
 let listener;const container={scrollTop:100,scrollLeft:0,clientHeight:500,addEventListener(name,fn,opts){assert.equal(name,'wheel');assert.equal(opts.passive,false);listener=fn;},scrollBy({left,top}){this.scrollLeft+=left;this.scrollTop+=top;}};
 globalThis.Element=class {};
 native.installNativeWheelScrolling(container);
 function wheel(props={}){const e={deltaX:0,deltaY:25,deltaMode:0,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...props};listener(e);return e;}
 assert.ok(wheel().prevented);assert.equal(container.scrollTop,125);
 wheel({deltaY:-50});assert.equal(container.scrollTop,75);
 wheel({deltaMode:1,deltaY:2});assert.equal(container.scrollTop,107);
 wheel({deltaMode:2,deltaY:1});assert.equal(container.scrollTop,607);
 for(const key of ['ctrlKey','metaKey','altKey'])assert.ok(!wheel({[key]:true}).prevented);
 class OutputScale {}native.configureNativeResolution(OutputScale,()=>2);assert.equal(OutputScale.pixelRatio,3);
 delete globalThis.Element;
});
