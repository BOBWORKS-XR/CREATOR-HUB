// Local UI preview only. Never installs software, imports packages or invokes native commands.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../src');
const entry = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../tests/fixtures/community/start-location.json')));
const injected = `<script>window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(command,args)=>{
if(command==='get_launch_request')return {view:'hub',revision:0};
if(command==='app_inventory')return {supported:false,apps:[]};
if(command==='hub_update_status')return {currentVersion:'Local community preview'};
if(command==='community_catalogue')return {entries:[${JSON.stringify(entry).replaceAll('<', '\\u003c')}],warnings:['Local preview catalogue. Not published; no Unity imports are enabled.'],stale:false};
if(command==='open_community_link'){const urls={submit:'https://github.com/SideQuestVR/Creator-Community/issues/new?template=contribution.yml',catalogue:'https://github.com/SideQuestVR/Creator-Community'}; if(urls[args.kind]){window.open(urls[args.kind],'_blank','noopener');return;}throw 'These listing files are local and not published yet.';}
throw 'Native app actions are unavailable in this browser preview.';
}}};window.addEventListener('load',()=>document.querySelector('.app-row[data-view="plugins"]').click());</script>`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer((req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep)) throw Error('outside root');
    let bytes = fs.readFileSync(file); if (file.endsWith('index.html')) bytes = bytes.toString().replace('<script src="native.js">', injected + '<script src="native.js">');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.env.PORT || 4190), '127.0.0.1', () => console.log(`Community preview: http://127.0.0.1:${process.env.PORT || 4190}`));
