#!/usr/bin/env python3
"""Install the loopback-only companion for a private VS Code Remote Tunnel."""
import argparse,json,os,plistlib,shutil,subprocess,sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
parser=argparse.ArgumentParser()
parser.add_argument('--external-url',required=True,help='Private forwarded URL shown in VS Code Ports for port 34567')
args=parser.parse_args()
url=urlsplit(args.external_url)
if sys.platform!='darwin':parser.error('This LaunchAgent installer is for macOS only; browser-bridge.cjs itself is portable.')
if url.scheme!='https' or not url.netloc or url.username or url.password or url.query or url.fragment:parser.error('Expected an HTTPS forwarded URL without credentials, query or fragment.')
node=shutil.which('node')
if not node:parser.error('Node.js is required.')
home=Path.home();base=home/'.local/share/vscode-latex-pdf-bridge';base.mkdir(parents=True,exist_ok=True)
source=Path(__file__).with_name('browser-bridge.cjs');shutil.copy2(source,base/'bridge.cjs')
settings=home/'.vscode-server/data/Machine/settings.json'
config=json.loads(settings.read_text()) if settings.exists() else {}
if settings.exists():shutil.copy2(settings,base/('settings-before-bridge-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'.json'))
config['latex-workshop.view.pdf.internal.urlPrefix']=args.external_url.rstrip('/')
config.setdefault('remote.portsAttributes',{})['34567']={'label':'LaTeX PDF','protocol':'http','onAutoForward':'silent'}
config['remote.restoreForwardedPorts']=True
settings.parent.mkdir(parents=True,exist_ok=True);settings.write_text(json.dumps(config,indent=4)+'\n')
label='local.vscode.latex-pdf-bridge'
plist=home/'Library/LaunchAgents'/f'{label}.plist';plist.parent.mkdir(parents=True,exist_ok=True)
data={'Label':label,'ProgramArguments':[node,str(base/'bridge.cjs')],'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':5,'StandardOutPath':str(base/'bridge.log'),'StandardErrorPath':str(base/'bridge-error.log')}
plist.write_bytes(plistlib.dumps(data))
subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}/{label}'],capture_output=True)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
print('Browser companion installed on 127.0.0.1:34567. Keep its forwarded port Private in VS Code.')
