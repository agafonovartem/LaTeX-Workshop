'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const WS=require('ws');
const root=path.resolve(__dirname,'..');
const origin='https://test-private-34567.euw.devtunnels.ms';
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
async function bridge(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lw-bridge-test-'));
 const settings=path.join(dir,'settings.json');
 fs.writeFileSync(settings,JSON.stringify({'latex-workshop.view.pdf.internal.urlPrefix':origin}));
 const reservation=http.createServer();const port=await listen(reservation);
 await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,[path.join(root,'tools/browser-bridge.cjs')],{env:{...process.env,LW_LOG_ROOT:dir,LW_MACHINE_SETTINGS:settings,LW_BRIDGE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',chunk=>{output+=chunk;});
 t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Bridge did not start: '+output)),5000);
  child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Bridge exited: '+code+' '+output));});
  child.stdout.on('data',chunk=>{if(chunk.toString().includes('PDF bridge on loopback port')){clearTimeout(timeout);resolve();}});
 });
 return {dir,port};
}
function logSession(dir,stamp,port){
 const output=path.join(dir,'20261016T010000','exthost1','output_logging_'+stamp);
 fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'1-LaTeX Workshop.log'),'Server successfully started: '+JSON.stringify({address:'127.0.0.1',port}));
}
async function viewer(t,label){
 const seen=[];const server=http.createServer((req,res)=>{
  seen.push(req.headers);
  if(req.url==='/config.json'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({sidebar:{},keybindings:{}}));}
  else {res.writeHead(200,{'Content-Type':'text/html'});res.end(label);}
 });
 const wss=new WS.Server({server});wss.on('connection',socket=>socket.on('message',m=>socket.send(label+':'+m)));
 const port=await listen(server);
 t.after(async()=>{for(const socket of wss.clients)socket.terminate();wss.close();await new Promise(r=>server.close(r));});
 return {port,seen};
}
test('browser bridge reports a missing extension session with a retryable text response',{timeout:10000},async t=>{
 const b=await bridge(t);const response=await fetch('http://127.0.0.1:'+b.port+'/viewer.html');
 assert.equal(response.status,503);assert.match(response.headers.get('Content-Type'),/^text\/plain/);
 assert.equal(response.headers.get('Retry-After'),'2');assert.match(await response.text(),/Open a PDF/);
});
test('browser bridge preserves HTML, restricts Origin restoration and follows new viewer sessions',{timeout:15000},async t=>{
 const first=await viewer(t,'first');const second=await viewer(t,'second');const b=await bridge(t);
 logSession(b.dir,'20261016T010001',first.port);
 const url='http://127.0.0.1:'+b.port+'/viewer.html';
 let response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'text/html');assert.equal(await response.text(),'first');
 const headers={Origin:'http://localhost:'+b.port,'x-forwarded-host':new URL(origin).host,'x-forwarded-proto':'https'};
 await (await fetch(url,{headers})).text();assert.equal(first.seen.at(-1).origin,origin);
 await (await fetch(url,{headers:{...headers,'x-forwarded-host':'unrelated.example'}})).text();assert.equal(first.seen.at(-1).origin,headers.Origin);
 await (await fetch(url,{headers:{...headers,Origin:'https://unrelated.example'}})).text();assert.equal(first.seen.at(-1).origin,'https://unrelated.example');
 logSession(b.dir,'20261016T010002',second.port);
 await new Promise(r=>setTimeout(r,1600));
 response=await fetch(url);assert.equal(await response.text(),'second');
 const socket=new WS('ws://127.0.0.1:'+b.port,{headers});
 t.after(()=>socket.terminate());await once(socket,'open');const reply=once(socket,'message');socket.send('ping');assert.equal((await reply)[0].toString(),'second:ping');socket.close();
});
