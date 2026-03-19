'use strict';

const { Worker } = require('worker_threads');
const http = require('http');
const fs   = require('fs');
const path = require('path');

let config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const RAM_MB = 6144;
const PORT   = config.dashboard?.port || 3000;

const bots       = {};
let workers      = [];
let usernames    = [];
let launched     = false;
const globalLogs = [];

function saveConfig() {
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
}
function generateUsernames(prefix, count) {
  const used = new Set(), names = [];
  while (names.length < count) {
    const n = prefix + Math.floor(10000 + Math.random() * 90000);
    if (!used.has(n)) { used.add(n); names.push(n); }
  }
  return names;
}
function broadcast(msg) { for (const w of workers) { try { w.postMessage(msg); } catch(_){} } }
function sendTo(name, msg) { const b = bots[name]; if (b?.worker) { try { b.worker.postMessage(msg); } catch(_){} } }
function gl(msg) { globalLogs.push('['+new Date().toLocaleTimeString()+'] '+msg); if (globalLogs.length > 400) globalLogs.shift(); }

function handleMsg(msg, username) {
  const b = bots[username]; if (!b) return;
  switch (msg.type) {
    case 'log': {
      const line = '['+new Date().toLocaleTimeString()+'] ['+msg.tag+'] '+msg.msg;
      b.logs.push(line); if (b.logs.length > 150) b.logs.shift();
      if (['WARN','ERROR','ERR','CRIT'].includes(msg.tag)) { console.log('['+username+'] '+line); gl('['+username+'] '+line); }
      break;
    }
    case 'status':
      Object.assign(b, { status:msg.status, mode:msg.mode, registered:msg.registered, pos:msg.pos, health:msg.health, food:msg.food });
      break;
    case 'registered':
      b.registered = true;
      b.logs.push('['+new Date().toLocaleTimeString()+'] [REG] registered');
      gl('['+username+'] Registered');
      break;
    case 'found': {
      const line = 'FOUND: '+msg.target+' at X='+msg.x+' Y='+msg.y+' Z='+msg.z+' (by '+msg.finder+')';
      console.log(line); gl(line);
      for (const n of Object.keys(bots)) bots[n].logs.push('['+new Date().toLocaleTimeString()+'] '+line);
      break;
    }
    case 'arrived': {
      b.arrivedAt = Date.now();
      if (Object.values(bots).every(x => x.arrivedAt && Date.now()-x.arrivedAt < 6000)) {
        broadcast({ type:'mode', mode:'idle' }); gl('All bots arrived.');
      }
      break;
    }
    case 'command':    parseCommand(msg.message); break;
    case 'chat_event': gl('<'+msg.sender+'> '+msg.message); break;
  }
}

function parseCommand(message, targets) {
  const msg  = message.trim();
  const send = targets?.length ? m => targets.forEach(u => sendTo(u, m)) : broadcast;
  if (msg.startsWith('-follow ')) {
    const arg = msg.slice(8).trim();
    send(arg==='off'||arg==='none'
      ? { type:'mode', mode:'idle', followName:null }
      : { type:'mode', mode:'follow', followName: arg==='me' ? config.owner : arg });
    return;
  }
  if (msg==='-bodyguard')     { send({ type:'mode', mode:'bodyguard' }); return; }
  if (msg==='-bodyguard off') { send({ type:'mode', mode:'idle' });      return; }
  if (msg==='-search')        { send({ type:'mode', mode:'search' });    return; }
  if (msg==='-search off')    { send({ type:'abort_search' });            return; }
  if (msg.startsWith('-say ')) { send({ type:'say', text:msg.slice(5).trim() }); return; }
  if (msg.startsWith('-go ')) {
    const [x,y,z] = msg.slice(4).trim().split(/\s+/).map(Number);
    if (![x,y,z].some(isNaN)) send({ type:'go', pos:{x,y,z} }); return;
  }
  if (msg.startsWith('-train ')) {
    const tgt  = msg.slice(7).trim()==='me' ? config.owner : msg.slice(7).trim();
    const tgts = targets?.length ? targets : usernames;
    tgts.forEach((u,i) => sendTo(u, { type:'train', trainTarget: i===0 ? tgt : tgts[i-1] })); return;
  }
  if (msg==='-train off') { send({ type:'mode', mode:'idle' }); return; }
  if (msg.startsWith('-circle ')) {
    const parts = msg.slice(8).trim().split(/\s+/);
    const tgt   = parts[0]==='me' ? config.owner : parts[0];
    const cmode = parseInt(parts[1])===2 ? 2 : 1;
    const tgts  = targets?.length ? targets : usernames;
    tgts.forEach(u => sendTo(u, { type:'circle', target:tgt, circleMode:cmode })); return;
  }
  if (msg==='-circle off') { send({ type:'mode', mode:'idle' }); return; }
}

async function launchBots() {
  if (launched) return { ok:false, error:'Already launched' };
  launched = true;
  const { count, spawnDelay, usernamePrefix } = config.bots;
  const total  = Math.min(count, 200);
  const prefix = usernamePrefix || 'Bot';
  usernames    = generateUsernames(prefix, total);
  for (const n of usernames) bots[n] = { status:'offline', mode:'idle', registered:false, pos:null, health:null, food:null, logs:[] };
  gl('Launching '+total+' bots to '+config.server.host+':'+config.server.port);
  const mem = Math.max(128, Math.floor(RAM_MB / total));
  ;(async () => {
    for (let i = 0; i < total; i++) {
      const name = usernames[i];
      const w = new Worker(path.join(__dirname, 'bot_worker.js'), {
        workerData: { username:name, botIndex:i, config, totalBots:total, botUsernames:usernames },
        resourceLimits: { maxOldGenerationSizeMb:mem, maxYoungGenerationSizeMb:32 },
      });
      w.on('message', msg => handleMsg(msg, name));
      w.on('error',   e   => { console.log('['+name+'] '+e.message); gl('['+name+'] ERR: '+e.message); });
      bots[name].worker = w;
      workers.push(w);
      gl('[SPAWN] '+(i+1)+'/'+total+' -- '+name);
      if (i < total-1) await sleep(spawnDelay);
    }
    setInterval(() => broadcast({ type:'ping' }), 2500);
  })();
  return { ok:true, total };
}

function body(req, cb) { let d=''; req.on('data',c=>d+=c); req.on('end',()=>cb(d)); }

function startServer() {
  const srv = http.createServer((req, res) => {
    const url  = new URL(req.url, 'http://localhost');
    const cors = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' };
    if (req.method==='OPTIONS') { res.writeHead(204,cors); res.end(); return; }

    if (req.method==='GET' && url.pathname==='/api/status') {
      res.writeHead(200, cors);
      res.end(JSON.stringify({
        launched,
        bots: Object.entries(bots).map(([n,b])=>({ username:n, status:b.status, mode:b.mode, registered:b.registered, pos:b.pos, health:b.health, food:b.food })),
        globalLogs: globalLogs.slice(-120),
        config: { owner:config.owner, host:config.server.host, port:config.server.port, version:config.server.version, count:config.bots.count, prefix:config.bots.usernamePrefix||'Bot', spawnDelay:config.bots.spawnDelay },
      }));
      return;
    }
    if (req.method==='GET' && url.pathname==='/api/logs') {
      const b = bots[url.searchParams.get('bot')];
      res.writeHead(200,cors); res.end(JSON.stringify({ logs: b?b.logs.slice(-150):[] })); return;
    }
    if (req.method==='POST' && url.pathname==='/api/launch') {
      launchBots().then(r=>{ res.writeHead(200,cors); res.end(JSON.stringify(r)); }); return;
    }
    if (req.method==='POST' && url.pathname==='/api/command') {
      body(req, d=>{ try { const {command,targets}=JSON.parse(d); parseCommand(command, targets?.length?targets:null); res.writeHead(200,cors); res.end(JSON.stringify({ok:true})); } catch(e){ res.writeHead(400,cors); res.end(JSON.stringify({error:e.message})); } }); return;
    }
    if (req.method==='POST' && url.pathname==='/api/train') {
      body(req, d=>{ try { const {target,targets}=JSON.parse(d); const nm=(!target||target==='me')?config.owner:target; const tgts=targets?.length?targets:usernames; tgts.forEach((u,i)=>sendTo(u,{type:'train',trainTarget:i===0?nm:tgts[i-1]})); res.writeHead(200,cors); res.end(JSON.stringify({ok:true})); } catch(e){ res.writeHead(400,cors); res.end(JSON.stringify({error:e.message})); } }); return;
    }
    if (req.method==='POST' && url.pathname==='/api/circle') {
      body(req, d=>{ try { const {target,mode,targets}=JSON.parse(d); const nm=(!target||target==='me')?config.owner:target; const cmode=parseInt(mode)===2?2:1; const tgts=targets?.length?targets:usernames; tgts.forEach(u=>sendTo(u,{type:'circle',target:nm,circleMode:cmode})); res.writeHead(200,cors); res.end(JSON.stringify({ok:true})); } catch(e){ res.writeHead(400,cors); res.end(JSON.stringify({error:e.message})); } }); return;
    }
    if (req.method==='POST' && url.pathname==='/api/autoregister') {
      body(req, d=>{ try { const {enabled,password,targets}=JSON.parse(d); const m={type:'set_autoregister',enabled:!!enabled,password:password||'password123'}; targets?.length?targets.forEach(u=>sendTo(u,m)):broadcast(m); res.writeHead(200,cors); res.end(JSON.stringify({ok:true})); } catch(e){ res.writeHead(400,cors); res.end(JSON.stringify({error:e.message})); } }); return;
    }
    if (req.method==='POST' && url.pathname==='/api/settings') {
      body(req, d=>{ try {
        const s=JSON.parse(d);
        if(s.owner)      config.owner=s.owner;
        if(s.host)       config.server.host=s.host;
        if(s.port)       config.server.port=parseInt(s.port);
        if(s.version)    config.server.version=s.version;
        if(s.count)      config.bots.count=parseInt(s.count);
        if(s.prefix)     config.bots.usernamePrefix=s.prefix;
        if(s.spawnDelay) config.bots.spawnDelay=parseInt(s.spawnDelay);
        saveConfig();
        if(s.owner) broadcast({type:'set_owner',owner:s.owner});
        res.writeHead(200,cors); res.end(JSON.stringify({ok:true,note:'host/port/count/prefix need restart'}));
      } catch(e){ res.writeHead(400,cors); res.end(JSON.stringify({error:e.message})); } }); return;
    }
    if (req.method==='GET' && (url.pathname==='/'||url.pathname==='/index.html')) {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(HTML); return;
    }
    res.writeHead(404); res.end('Not found');
  });
  srv.listen(PORT, () => console.log('\n  Dashboard  http://localhost:'+PORT+'\n'));
}

startServer();

// ─────────────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Control</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:    #080808;
  --s1:    #0f0f0f;
  --s2:    #141414;
  --s3:    #1a1a1a;
  --s4:    #222;
  --b1:    #1e1e1e;
  --b2:    #2a2a2a;
  --b3:    #363636;
  --t1:    #f2f2f2;
  --t2:    #888;
  --t3:    #444;
  --g:     #34d27b;
  --r:     #f05050;
  --y:     #f0b429;
  --bl:    #5b9eff;
  --mono:  'JetBrains Mono', monospace;
  --ui:    'Outfit', sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font-family:var(--ui);background:var(--bg);color:var(--t1);font-size:13px}
::-webkit-scrollbar{width:3px;height:3px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}

/* ── APP SHELL ── */
.app{display:flex;flex-direction:column;height:100vh}

/* ── TOPBAR ── */
.topbar{
  display:flex;align-items:center;gap:14px;
  height:52px;padding:0 20px;flex-shrink:0;
  background:var(--s1);
  border-bottom:1px solid var(--b1);
}
.brand{
  font-family:var(--mono);font-size:12px;font-weight:700;
  letter-spacing:.1em;display:flex;align-items:center;gap:9px;
}
.brand-mark{
  width:28px;height:28px;border:1px solid var(--b3);border-radius:4px;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;color:var(--t2);font-weight:700;
}
.topstats{display:flex;gap:5px;margin-left:auto}
.tstat{
  font-family:var(--mono);font-size:10px;
  padding:4px 11px;border-radius:3px;
  border:1px solid var(--b1);color:var(--t3);
  transition:all .2s;
}
.tstat.live{color:var(--g);border-color:rgba(52,210,123,.2);background:rgba(52,210,123,.05)}

/* ── CONTENT ── */
.content{display:grid;grid-template-columns:270px 1fr 296px;flex:1;overflow:hidden}

/* ── SIDEBAR L/R ── */
.sl,.sr{
  overflow-y:auto;
  border-right:1px solid var(--b1);
  background:var(--s1);
}
.sr{border-right:none;border-left:1px solid var(--b1)}

/* ── MAIN CENTER ── */
.mc{overflow-y:auto;background:var(--bg)}

/* ── SECTION ── */
.sec{border-bottom:1px solid var(--b1);padding:13px 15px}
.sh{
  font-family:var(--mono);font-size:9px;font-weight:700;
  text-transform:uppercase;letter-spacing:.14em;color:var(--t3);
  margin-bottom:11px;display:flex;align-items:center;gap:7px;
}
.sh::after{content:'';flex:1;height:1px;background:var(--b1)}

/* ── FORM GRID ── */
.fg{display:grid;grid-template-columns:72px 1fr;gap:7px 8px;align-items:center}
.fg label{font-family:var(--mono);font-size:10px;color:var(--t2)}

/* ── INPUTS ── */
input,select{
  background:var(--s2);color:var(--t1);
  border:1px solid var(--b1);
  padding:7px 9px;border-radius:4px;
  font-family:var(--mono);font-size:11px;
  outline:none;width:100%;
  transition:border-color .14s;
}
input:focus,select:focus{border-color:var(--b3)}
input::placeholder{color:var(--t3)}
input[type=number]{-moz-appearance:textfield}
input[type=number]::-webkit-outer-spin-button,
input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
input[type=checkbox]{width:auto;accent-color:var(--t2);cursor:pointer}
.xs{max-width:58px}

/* ── BUTTONS ── */
button{
  display:inline-flex;align-items:center;justify-content:center;gap:5px;
  padding:7px 13px;border-radius:4px;
  font-family:var(--ui);font-size:11px;font-weight:600;
  cursor:pointer;border:1px solid var(--b2);
  background:var(--s3);color:var(--t2);
  transition:all .14s;white-space:nowrap;
}
button:hover{background:var(--s4);border-color:var(--b3);color:var(--t1)}
button:active{transform:scale(.97)}
button:disabled{opacity:.3;cursor:not-allowed;transform:none}

.primary{background:var(--t1);color:#080808;border-color:var(--t1);font-weight:700;font-size:12px}
.primary:hover{background:#d8d8d8;border-color:#d8d8d8;color:#000}
.primary:disabled{background:var(--s4);color:var(--t2);border-color:var(--b2)}

.g-btn{border-color:rgba(52,210,123,.3);color:var(--g)}
.g-btn:hover{background:rgba(52,210,123,.08);border-color:var(--g);color:var(--g)}
.r-btn{border-color:rgba(240,80,80,.3);color:var(--r)}
.r-btn:hover{background:rgba(240,80,80,.08);border-color:var(--r);color:var(--r)}
.b-btn{border-color:rgba(91,158,255,.3);color:var(--bl)}
.b-btn:hover{background:rgba(91,158,255,.08);border-color:var(--bl);color:var(--bl)}
.sm{padding:4px 9px;font-size:10px}
.w{width:100%}

/* ── ROW ── */
.row{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.row:last-child{margin-bottom:0}
.f1{flex:1 1 0;min-width:0}
.hint{font-family:var(--mono);font-size:9px;color:var(--t3);margin-top:5px;line-height:1.75}

/* ── LAUNCH STATUS ── */
#launch-status{
  font-family:var(--mono);font-size:10px;line-height:1.6;
  padding:8px 10px;border-radius:4px;margin-top:8px;
  background:var(--s2);border:1px solid var(--b1);color:var(--t2);
}

/* ── STATS ROW ── */
.statrow{
  display:grid;grid-template-columns:repeat(4,1fr);
  border-bottom:1px solid var(--b1);
  background:var(--s1);flex-shrink:0;
}
.sc{padding:13px 15px;border-right:1px solid var(--b1)}
.sc:last-child{border-right:none}
.sv{font-family:var(--mono);font-size:24px;font-weight:700;line-height:1;margin-bottom:3px}
.sl2{font-family:var(--mono);font-size:8px;color:var(--t3);text-transform:uppercase;letter-spacing:.1em}
.sv-g{color:var(--g)}.sv-w{color:var(--t1)}.sv-m{color:var(--t2)}.sv-y{color:var(--y)}

/* ── MODULE GRID ── */
.modgrid{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding:14px}
.mod{
  background:var(--s1);border:1px solid var(--b1);
  border-radius:5px;overflow:hidden;
}
.mod-wide{grid-column:span 2}
.mh{
  padding:7px 12px;background:var(--s2);
  border-bottom:1px solid var(--b1);
  font-family:var(--mono);font-size:9px;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;color:var(--t2);
}
.mb{padding:11px 12px}

/* ── SELBAR ── */
.selbar{
  display:flex;align-items:center;gap:6px;
  padding:8px 14px;
  border-bottom:1px solid var(--b1);
  background:var(--s1);
}
.selbar-lbl{font-family:var(--mono);font-size:9px;color:var(--t2);margin-right:auto}

/* ── BOT GRID ── */
.botgrid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(140px,1fr));
  gap:5px;padding:11px;
}
.bc{
  background:var(--s1);border:1px solid var(--b1);
  border-left:2px solid var(--b2);border-radius:4px;
  padding:9px 10px;cursor:pointer;
  transition:background .12s,border-color .12s;
}
.bc:hover{background:var(--s2);border-color:var(--b2)}
.bc.sel{background:var(--s2);border-color:var(--b3)}
.bc.on {border-left-color:var(--g)}
.bc.con{border-left-color:var(--y)}
.bc.off{border-left-color:var(--b2)}
.bc-n{
  font-family:var(--mono);font-size:10px;font-weight:700;
  display:flex;align-items:center;gap:5px;
  margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
.dot-g{background:var(--g)}.dot-y{background:var(--y)}.dot-x{background:var(--b3)}
.bc-p{font-family:var(--mono);font-size:9px;color:var(--t3);line-height:1.7}
.bc-t{display:flex;gap:3px;flex-wrap:wrap;margin-top:4px}
.tag{
  padding:1px 5px;border-radius:2px;
  font-family:var(--mono);font-size:8px;font-weight:700;
  text-transform:uppercase;letter-spacing:.05em;
  border:1px solid var(--b2);color:var(--t2);
}
.tag-reg{border-color:rgba(52,210,123,.3);color:var(--g)}

/* ── LOG PANEL ── */
.logwrap{display:flex;flex-direction:column;height:100%}
.logtop{
  display:flex;align-items:center;gap:8px;
  padding:9px 13px;border-bottom:1px solid var(--b1);
  background:var(--s1);flex-shrink:0;
}
.logtitle{
  font-family:var(--mono);font-size:9px;font-weight:700;
  letter-spacing:.14em;text-transform:uppercase;color:var(--t2);flex:1;
}
.logtop select{
  background:transparent;border:1px solid var(--b1);color:var(--t2);
  font-size:9px;padding:2px 6px;border-radius:3px;
  max-width:130px;width:auto;font-family:var(--mono);
}
.logbody{
  flex:1;overflow-y:auto;
  padding:5px 11px;
  font-family:var(--mono);font-size:9px;line-height:1.9;
}
.ll{color:var(--t3);border-bottom:1px solid rgba(255,255,255,.02);padding:1px 0}
.ll.w{color:var(--y)}.ll.e{color:var(--r)}.ll.s{color:var(--g)}.ll.i{color:var(--t2)}

/* ── CHECKBOX ── */
.chkrow{
  display:flex;align-items:center;gap:7px;cursor:pointer;
  font-family:var(--mono);font-size:10px;color:var(--t2);
  user-select:none;
}
</style>
</head>
<body>
<div class="app">

<!-- ═══════════════════════════ TOPBAR ═══════════════════════════ -->
<div class="topbar">
  <div class="brand">
    <div class="brand-mark">BC</div>
    BOT CONTROL
  </div>
  <div class="topstats">
    <div class="tstat live" id="h-on">0 online</div>
    <div class="tstat"      id="h-reg">0 reg</div>
    <div class="tstat"      id="h-tot">0 bots</div>
    <div class="tstat"      id="h-modes">idle</div>
  </div>
</div>

<div class="content">

<!-- ═══════════════════════════ LEFT — CONFIG ═══════════════════════════ -->
<div class="sl">

  <div class="sec">
    <div class="sh">Server</div>
    <div class="fg">
      <label>Owner</label>   <input id="cfg-owner" placeholder="your username">
      <label>Host</label>    <input id="cfg-host"  placeholder="play.server.net">
      <label>Port</label>    <input id="cfg-port"  placeholder="25565" type="number">
      <label>Version</label> <input id="cfg-ver"   placeholder="1.21.6">
    </div>
  </div>

  <div class="sec">
    <div class="sh">Bots</div>
    <div class="fg">
      <label>Count</label>    <input id="cfg-cnt"   placeholder="20" type="number">
      <label>Prefix</label>   <input id="cfg-pfx"   placeholder="Bot">
      <label>Delay ms</label> <input id="cfg-delay" placeholder="1200" type="number">
    </div>
    <div class="row" style="margin-top:10px">
      <button class="w" onclick="saveSettings()">Save Settings</button>
    </div>
    <div id="cfg-msg" class="hint"></div>
  </div>

  <div class="sec">
    <div class="sh">Auto Login</div>
    <div class="row">
      <input id="reg-p" placeholder="Password for /register and /login" class="f1">
    </div>
    <div class="row">
      <label class="chkrow f1">
        <input id="reg-on" type="checkbox">
        Enable auto-register / login
      </label>
    </div>
    <div class="row">
      <button class="g-btn w" onclick="autoregApply()">Apply</button>
    </div>
    <div class="hint">Watches server messages for registration and login prompts.</div>
  </div>

  <div class="sec">
    <div class="sh">Launch</div>
    <div class="row">
      <button class="primary w" id="launch-btn" onclick="doLaunch()">Launch Bots</button>
    </div>
    <div class="row" style="margin-top:4px">
      <button class="r-btn w" onclick="stopAll()">Stop All Modes</button>
    </div>
    <div id="launch-status" style="display:none"></div>
  </div>

  <div class="sec">
    <div class="sh">Selection</div>
    <div class="row">
      <button class="f1" onclick="selAll()">Select All</button>
      <button class="f1" onclick="selNone()">Clear</button>
    </div>
    <div id="sel-lbl" class="hint">Targeting all bots</div>
  </div>

</div><!-- /sl -->

<!-- ═══════════════════════════ CENTER — MODULES + BOTS ═══════════════════════════ -->
<div class="mc">

  <div class="statrow">
    <div class="sc"><div class="sv sv-g" id="s0">0</div><div class="sl2">Online</div></div>
    <div class="sc"><div class="sv sv-w" id="s1">0</div><div class="sl2">Registered</div></div>
    <div class="sc"><div class="sv sv-m" id="s2">0</div><div class="sl2">Idle</div></div>
    <div class="sc"><div class="sv sv-y" id="s7">0</div><div class="sl2">Total</div></div>
  </div>

  <div class="modgrid">

    <!-- Follow -->
    <div class="mod">
      <div class="mh">Follow</div>
      <div class="mb">
        <div class="row">
          <input id="f-name" value="me" placeholder="player / me" class="f1">
        </div>
        <div class="row">
          <button class="f1" onclick="cmd('-follow '+g('f-name'))">Follow</button>
          <button class="g-btn" onclick="cmd('-follow me')">Me</button>
          <button class="r-btn sm" onclick="cmd('-follow off')">Stop</button>
        </div>
      </div>
    </div>

    <!-- Go To -->
    <div class="mod">
      <div class="mh">Go To</div>
      <div class="mb">
        <div class="row">
          <input id="gx" placeholder="X" class="xs">
          <input id="gy" placeholder="Y" class="xs">
          <input id="gz" placeholder="Z" class="xs">
          <button class="f1" onclick="goCmd()">Go to Coords</button>
        </div>
        <div class="row">
          <button class="g-btn w" onclick="gotoMeCmd()">Go to Me</button>
        </div>
        <div class="hint">Go to Me — bots follow your position via pathfinder.</div>
      </div>
    </div>

    <!-- Circle / Trap -->
    <div class="mod">
      <div class="mh">Circle / Trap</div>
      <div class="mb">
        <div class="row">
          <input id="ci-name" value="me" placeholder="target / me" class="f1">
          <button class="r-btn sm" onclick="cmd('-circle off')">Stop</button>
        </div>
        <div class="row">
          <button class="f1" onclick="circleCmd(1)">Orbit</button>
          <button class="f1" onclick="circleCmd(2)">Trap</button>
        </div>
        <div class="row">
          <button class="g-btn f1" onclick="circleMeCmd(1)">Orbit Me</button>
          <button class="r-btn f1" onclick="circleMeCmd(2)">Trap Me</button>
        </div>
        <div class="hint">Trap: 65% bots inner ring (1.3 blk), 35% outer ring (2.8 blk).</div>
      </div>
    </div>

    <!-- Train -->
    <div class="mod">
      <div class="mh">Train</div>
      <div class="mb">
        <div class="row">
          <input id="t-name" value="me" placeholder="leader" class="f1">
        </div>
        <div class="row">
          <button class="f1" onclick="trainCmd()">Train</button>
          <button class="g-btn" onclick="trainMe()">Me</button>
          <button class="r-btn sm" onclick="cmd('-train off')">Stop</button>
        </div>
        <div class="hint">Each bot follows the one ahead — chain behind the leader.</div>
      </div>
    </div>

    <!-- Bodyguard -->
    <div class="mod">
      <div class="mh">Bodyguard</div>
      <div class="mb">
        <div class="row">
          <button class="g-btn f1" onclick="cmd('-bodyguard')">Enable</button>
          <button class="r-btn f1" onclick="cmd('-bodyguard off')">Disable</button>
        </div>
        <div class="hint">Bots attack nearby mobs and hostile players. Auto-equips best weapon.</div>
      </div>
    </div>

    <!-- Search -->
    <div class="mod">
      <div class="mh">Search Players</div>
      <div class="mb">
        <div class="row">
          <button class="g-btn f1" onclick="cmd('-search')">Start</button>
          <button class="r-btn f1" onclick="cmd('-search off')">Stop</button>
        </div>
        <div class="hint">Bots fan out in all directions to find players on the server.</div>
      </div>
    </div>

    <!-- Chat -->
    <div class="mod mod-wide">
      <div class="mh">Chat</div>
      <div class="mb">
        <div class="row">
          <input id="say-t" placeholder="type a message to send in-game chat..." class="f1"
            onkeydown="if(event.key==='Enter')sayCmd()">
          <button onclick="sayCmd()">Send</button>
        </div>
        <div class="hint">Sends from all selected bots (or all bots when none selected).</div>
      </div>
    </div>

  </div><!-- /modgrid -->

  <!-- Selection bar + bot grid -->
  <div class="selbar">
    <button class="sm" onclick="selAll()">All</button>
    <button class="sm" onclick="selNone()">None</button>
    <span class="selbar-lbl" id="sel-lbl2">All bots targeted</span>
    <span class="hint" style="margin:0">Click cards to target individual bots</span>
  </div>

  <div class="botgrid" id="grid"></div>

</div><!-- /mc -->

<!-- ═══════════════════════════ RIGHT — LOG ═══════════════════════════ -->
<div class="sr">
  <div class="logwrap">
    <div class="logtop">
      <div class="logtitle" id="log-title">Global Log</div>
      <select id="log-sel" onchange="switchLog()">
        <option value="__g__">Global</option>
      </select>
    </div>
    <div class="logbody" id="log-body"></div>
  </div>
</div>

</div><!-- /content -->
</div><!-- /app -->

<script>
// ── State ──────────────────────────────────────────────────────
let all=[], sel=new Set(), curLog='__g__', cfg={}, isLaunched=false;

// ── Main poll ──────────────────────────────────────────────────
async function refresh(){
  try{
    const d = await (await fetch('/api/status')).json();
    all = d.bots; cfg = d.config || {};
    if(d.launched && !isLaunched){ isLaunched=true; setLaunchedUI(); }
    updStats(d.bots);
    renderGrid(d.bots);
    if(curLog==='__g__') renderLog(d.globalLogs||[]);
    updDropdown(d.bots);
    loadCfg();
  }catch(_){}
}
setInterval(refresh, 2000);
setInterval(()=>{ if(curLog!=='__g__') fetchBotLog(curLog); }, 3000);
refresh();

// ── Launch ─────────────────────────────────────────────────────
async function doLaunch(){
  const btn = document.getElementById('launch-btn');
  const st  = document.getElementById('launch-status');
  st.style.display = 'block';
  st.style.color   = 'var(--t2)';
  st.textContent   = 'Contacting server...';
  btn.disabled = true;
  btn.textContent = 'Launching...';
  try{
    const r = await (await fetch('/api/launch',{method:'POST'})).json();
    if(r.ok){
      isLaunched = true;
      setLaunchedUI();
      st.style.color = 'var(--g)';
      st.textContent = 'Launched ' + r.total + ' bots. Connecting...';
    } else {
      st.style.color   = 'var(--r)';
      st.textContent   = 'Error: ' + (r.error||'unknown');
      btn.disabled = false;
      btn.textContent  = 'Launch Bots';
    }
  } catch(e){
    st.style.color = 'var(--r)';
    st.textContent = 'Fetch error: ' + e.message;
    btn.disabled = false;
    btn.textContent  = 'Launch Bots';
  }
}

function setLaunchedUI(){
  const btn = document.getElementById('launch-btn');
  btn.disabled    = false;
  btn.textContent = 'Already Launched';
  btn.className   = 'g-btn w';
}

function stopAll(){
  ['follow off','circle off','train off','bodyguard off'].forEach(s=>cmd('-'+s));
  cmd('-search off');
}

// ── Settings ───────────────────────────────────────────────────
function loadCfg(){
  const m=(id,v)=>{ const el=document.getElementById(id); if(el&&!el.matches(':focus')&&v!=null) el.value=v; };
  m('cfg-owner',cfg.owner); m('cfg-host',cfg.host); m('cfg-port',cfg.port);
  m('cfg-ver',cfg.version); m('cfg-cnt',cfg.count);
  m('cfg-pfx',cfg.prefix);  m('cfg-delay',cfg.spawnDelay);
}

async function saveSettings(){
  const s={
    owner:g('cfg-owner'), host:g('cfg-host'), port:g('cfg-port'),
    version:g('cfg-ver'), count:g('cfg-cnt'), prefix:g('cfg-pfx'),
    spawnDelay:g('cfg-delay'),
  };
  try{
    const r=await(await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)})).json();
    const el=document.getElementById('cfg-msg');
    el.textContent = r.error ? 'Error: '+r.error : 'Saved. '+(r.note||'');
    el.style.color = r.error ? 'var(--r)' : 'var(--t2)';
  } catch(e){ document.getElementById('cfg-msg').textContent='Error: '+e.message; }
}

async function autoregApply(){
  const enabled  = document.getElementById('reg-on').checked;
  const password = g('reg-p') || 'StrongPass123';
  await post('/api/autoregister',{enabled,password,targets:sel.size?[...sel]:null});
}

// ── Stats ──────────────────────────────────────────────────────
function updStats(bots){
  const v=[
    bots.filter(b=>b.status==='online').length,
    bots.filter(b=>b.registered).length,
    bots.filter(b=>b.mode==='idle').length,
    bots.filter(b=>b.mode==='follow').length,
    bots.filter(b=>b.mode==='bodyguard').length,
    bots.filter(b=>b.mode==='train').length,
    bots.filter(b=>b.mode==='circle').length,
    bots.length,
  ];
  for(let i=0;i<8;i++){ const el=document.getElementById('s'+i); if(el) el.textContent=v[i]; }
  document.getElementById('h-on').textContent  = v[0]+' online';
  document.getElementById('h-reg').textContent = v[1]+' reg';
  document.getElementById('h-tot').textContent = v[7]+' bots';
  const mc={}; bots.map(b=>b.mode).filter(m=>m!=='idle').forEach(m=>mc[m]=(mc[m]||0)+1);
  const ms=Object.entries(mc).map(([m,c])=>c+' '+m).join(' / ')||'all idle';
  document.getElementById('h-modes').textContent = ms;
}

// ── Dropdown ───────────────────────────────────────────────────
function updDropdown(bots){
  const s=document.getElementById('log-sel');
  const ex=new Set([...s.options].map(o=>o.value));
  for(const b of bots) if(!ex.has(b.username)){
    const o=document.createElement('option'); o.value=b.username; o.textContent=b.username; s.appendChild(o);
  }
}

// ── Bot grid ───────────────────────────────────────────────────
function renderGrid(bots){
  const grid=document.getElementById('grid'); if(!grid) return;
  const ex={};
  for(const c of grid.querySelectorAll('.bc')) ex[c.dataset.n]=c;
  for(const b of bots){
    let c=ex[b.username];
    if(!c){
      c=document.createElement('div');
      c.dataset.n=b.username;
      c.onclick=()=>toggleSel(b.username);
      grid.appendChild(c);
    }
    const stCls = b.status==='online'?'on': b.status==='connecting'?'con':'off';
    c.className = 'bc '+stCls+(sel.has(b.username)?' sel':'');
    const pos  = b.pos ? b.pos.x+' '+b.pos.y+' '+b.pos.z : '--';
    const hp   = b.health!=null ? 'hp:'+b.health : '';
    const fd   = b.food!=null   ? ' fd:'+b.food  : '';
    const dotC = stCls==='on'?'dot-g': stCls==='con'?'dot-y':'dot-x';
    let tags='<span class="tag">'+esc(b.mode)+'</span>';
    if(b.registered) tags+=' <span class="tag tag-reg">reg</span>';
    c.innerHTML=
      '<div class="bc-n"><div class="dot '+dotC+'"></div>'+esc(b.username)+'</div>'+
      '<div class="bc-p">'+esc(pos)+(hp||fd?'<br>'+esc(hp+fd):'')+'</div>'+
      '<div class="bc-t">'+tags+'</div>';
  }
}

// ── Log ────────────────────────────────────────────────────────
async function fetchBotLog(n){
  try{ const d=await(await fetch('/api/logs?bot='+encodeURIComponent(n))).json(); renderLog(d.logs||[]); }catch(_){}
}
function renderLog(lines){
  const el=document.getElementById('log-body'); if(!el) return;
  const atBot=el.scrollHeight-el.clientHeight<=el.scrollTop+50;
  el.innerHTML=lines.map(l=>{
    let c='ll';
    if(/WARN/i.test(l)) c+=' w';
    else if(/ERR|ERROR/i.test(l)) c+=' e';
    else if(/FOUND|SEARCH/i.test(l)) c+=' s';
    else if(/SPAWN|REG/i.test(l)) c+=' i';
    return '<div class="'+c+'">'+esc(l)+'</div>';
  }).join('');
  if(atBot) el.scrollTop=el.scrollHeight;
}
function switchLog(){
  curLog=document.getElementById('log-sel').value;
  document.getElementById('log-title').textContent=curLog==='__g__'?'Global Log':curLog;
  if(curLog!=='__g__') fetchBotLog(curLog);
}

// ── Selection ──────────────────────────────────────────────────
function toggleSel(n){ sel.has(n)?sel.delete(n):sel.add(n); renderGrid(all); updSelLbl(); }
function selAll(){ all.forEach(b=>sel.add(b.username)); renderGrid(all); updSelLbl(); }
function selNone(){ sel.clear(); renderGrid(all); updSelLbl(); }
function updSelLbl(){
  const t=sel.size?sel.size+' bots selected':'All bots targeted';
  ['sel-lbl','sel-lbl2'].forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent=t; });
}

// ── Helpers ────────────────────────────────────────────────────
function g(id){ return document.getElementById(id)?.value||''; }
async function post(url,data){ return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); }
async function cmd(command){ await post('/api/command',{command,targets:sel.size?[...sel]:null}); }
function goCmd(){ const x=g('gx'),y=g('gy'),z=g('gz'); if(x&&y&&z) cmd('-go '+x+' '+y+' '+z); }
function sayCmd(){ const t=g('say-t').trim(); if(t){ cmd('-say '+t); document.getElementById('say-t').value=''; } }
function gotoMeCmd(){ cmd('-follow me'); }
async function trainCmd(){ await post('/api/train',{target:g('t-name').trim()||'me',targets:sel.size?[...sel]:null}); }
async function trainMe() { await post('/api/train',{target:'me',targets:sel.size?[...sel]:null}); }
async function circleCmd(mode){ await post('/api/circle',{target:g('ci-name').trim()||'me',mode,targets:sel.size?[...sel]:null}); }
async function circleMeCmd(mode){ await post('/api/circle',{target:'me',mode,targets:sel.size?[...sel]:null}); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>
</body>
</html>`;
