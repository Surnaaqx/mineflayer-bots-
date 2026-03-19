'use strict';

// bot_worker.js — runs ONE bot in its own Worker thread
const { workerData, parentPort } = require('worker_threads');
const mineflayer  = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear, GoalXZ } = goals;

const { username, botIndex, config, totalBots, botUsernames } = workerData;

let sharedMode   = 'idle';
let followName   = null;
let gotoPos      = null;
let searchAbort  = false;
let searchHome   = null;
let trainTarget  = null;
let circleTarget = null;
let circleMode   = 1;
let autoRegister = false;
let regPassword  = 'password123';
let registered   = false;
let botStatus    = 'offline';
let botPos       = null;

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'mode':
      sharedMode  = msg.mode;
      followName  = msg.followName  ?? followName;
      gotoPos     = msg.gotoPos     ?? null;
      searchAbort = msg.searchAbort ?? false;
      if (msg.mode === 'search') { searchHome = null; searchAbort = false; }
      break;
    case 'abort_search':
      searchAbort = true; sharedMode = 'idle'; safeStop(); break;
    case 'say':
      if (bot) { try { bot.chat(msg.text); } catch(_){} } break;
    case 'go':
      gotoPos        = msg.pos;
      _bot_goActive  = true;
      _bot_goGoalSet = false;
      sharedMode     = 'go';
      bot && bot.setControlState('sprint', true);
      break;
    case 'set_owner': break;
    case 'circle':
      circleTarget = msg.target;
      circleMode   = msg.circleMode || 1;
      sharedMode   = 'circle';
      break;
    case 'train':
      trainTarget = msg.trainTarget;
      sharedMode  = 'train';
      break;
    case 'set_autoregister':
      autoRegister = msg.enabled;
      regPassword  = msg.password || regPassword;
      break;
    case 'ping':
      send('status', {
        username, botIndex, status: botStatus, mode: sharedMode,
        trainTarget, registered, pos: botPos,
        health: bot && bot.health != null ? Math.round(bot.health) : null,
        food:   bot && bot.food   != null ? Math.round(bot.food)   : null,
      });
      break;
  }
});

function send(type, data) {
  try { parentPort.postMessage({ type, ...data }); } catch(_){}
}

const OWNER           = config.owner;
const TICK_MS         = 600;
const FOLLOW_SLOT_R   = 0.7;
const BODYGUARD_R     = 3.5;
const ATTACK_RANGE    = 3.8;
const ATTACK_COOLDOWN = 500;
const CRIT_CHANCE     = 0.55;
const CRIT_JUMP_DELAY = 220;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(tag, msg) { send('log', { username, tag, msg }); }

let bot         = null;
let mcData      = null;
let loopRunning = false;
let lastAttackAt  = 0;
let isCritting    = false;

function connect() {
  botStatus = 'connecting';
  log('INFO', 'Connecting...');
  bot = mineflayer.createBot({
    host    : config.server.host,
    port    : config.server.port,
    username,
    version : config.server.version,
    auth    : config.bots.auth,
  });
  bot.loadPlugin(pathfinder);
  bot.once('spawn',  onSpawn);
  bot.on('chat',     onChat);
  bot.on('kicked',   () => { loopRunning = false; });
  bot.on('error',    e  => log('ERROR', String(e.message)));
  bot.on('end', reason => {
    botStatus  = 'offline';
    registered = false;
    log('WARN', 'Ended: ' + reason);
    loopRunning = false;
    if (bot._afkInterval)   { clearInterval(bot._afkInterval);   bot._afkInterval   = null; }
    if (bot._waterInterval) { clearInterval(bot._waterInterval);  bot._waterInterval = null; }
    setTimeout(connect, config.behavior.reconnectDelay);
  });
}

async function onSpawn() {
  botStatus  = 'online';
  registered = false;
  log('INFO', 'Spawned!');
  mcData = require('minecraft-data')(bot.version);

  if (autoRegister) { await sleep(2000); tryAutoRegister(); }

  applyMovements(false);
  bot.setControlState('sprint', true);
  await sleep(1500);
  loopRunning = true;

  if (bot._afkInterval)   clearInterval(bot._afkInterval);
  if (bot._waterInterval) clearInterval(bot._waterInterval);

  let _afkTick = 0;
  bot._afkInterval = setInterval(() => {
    if (!bot || !bot.entity || !loopRunning) return;
    _afkTick++;
    try { bot.look((_afkTick * 0.3) % (2 * Math.PI), 0, false); } catch(_){}
  }, 20000);

  bot._waterInterval = setInterval(() => {
    if (!bot || !bot.entity || !loopRunning) return;
    try {
      const b = bot.blockAt(bot.entity.position);
      if (b && b.name === 'water') {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch(_){} }, 250);
      }
    } catch(_){}
  }, 2000);

  setInterval(() => {
    if (!bot || !bot.entity) return;
    const p = bot.entity.position;
    botPos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }, 3000);

  mainLoop();
}

async function tryAutoRegister() {
  const regHandler = (jsonMsg) => {
    const txt   = typeof jsonMsg === 'string' ? jsonMsg : (jsonMsg.toString ? jsonMsg.toString() : '');
    const lower = txt.toLowerCase();
    if (lower.includes('register') || lower.includes('/reg') || lower.includes('\u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440')) {
      bot.removeListener('message', regHandler);
      setTimeout(async () => {
        try {
          bot.chat('/register ' + regPassword + ' ' + regPassword);
          await sleep(1200);
          registered = true;
          log('REGISTER', 'Registered successfully');
          send('registered', { username });
        } catch(e) { log('REGISTER_ERR', e.message); }
      }, 800);
    }
    if (lower.includes('login') || lower.includes('/l ') || lower.includes('\u0432\u043e\u0439\u0434\u0438\u0442\u0435')) {
      bot.removeListener('message', regHandler);
      setTimeout(() => {
        try {
          bot.chat('/login ' + regPassword);
          log('REGISTER', 'Logged in');
          send('registered', { username });
        } catch(e) {}
      }, 800);
    }
  };
  bot.on('message', regHandler);
  await sleep(3000);
  if (!registered && autoRegister) {
    try {
      bot.chat('/register ' + regPassword + ' ' + regPassword);
      await sleep(1000);
      registered = true;
      send('registered', { username });
    } catch(_){}
  }
}

function onChat(sender, message) {
  send('chat_event', { sender, message, username });
  if (sender === username) return;
  if (sender !== OWNER)    return;
  if (botIndex === 0) send('command', { sender, message });
}

function applyMovements(canDig) {
  const m = new Movements(bot);
  m.canDig = canDig; m.allowSprinting = true; m.sprint = true;
  m.liquidCost = 1;  m.canSwim = true;
  bot.pathfinder.setMovements(m);
}

function safeStop() { try { bot.pathfinder.stop(); } catch(_){} }

function getPlayer(name) {
  if (!name) return null;
  const p = bot.players[name];
  return (p && p.entity) ? p.entity : null;
}

function distToPos(pos) {
  if (!pos) return Infinity;
  return bot.entity.position.distanceTo(pos.position || pos);
}

function slotPos(targetPos) {
  const total = Math.max(totalBots, 1);
  const angle = (2 * Math.PI / total) * botIndex;
  return { x: targetPos.x + Math.cos(angle) * FOLLOW_SLOT_R, z: targetPos.z + Math.sin(angle) * FOLLOW_SLOT_R };
}

let _lastGoalX, _lastGoalZ;
function moveToXZ(tx, tz, ty) {
  const dx = bot.entity.position.x - tx, dz = bot.entity.position.z - tz;
  if (Math.sqrt(dx*dx + dz*dz) < 0.5) { safeStop(); return; }
  if (_lastGoalX !== undefined && Math.sqrt((tx-_lastGoalX)**2 + (tz-_lastGoalZ)**2) < 3) return;
  _lastGoalX = tx; _lastGoalZ = tz;
  const y = ty ?? bot.entity.position.y;
  bot.pathfinder.setGoal(new GoalNear(tx, y, tz, 0.5), true);
}

function isFriendly(e) {
  if (!e) return true;
  if (e.type === 'player' && e.username === OWNER) return true;
  if (e.type === 'player' && botUsernames.includes(e.username)) return true;
  return false;
}

function getBestWeapon() {
  const prio = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe',
  ];
  for (const name of prio) {
    const it = bot.inventory.items().find(i => i.name === name);
    if (it) return it;
  }
  return null;
}

const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','witch','pillager',
  'vindicator','ravager','evoker','vex','blaze','ghast','wither_skeleton',
  'enderman','slime','magma_cube','drowned','husk','stray','phantom',
  'guardian','elder_guardian','hoglin','piglin_brute','warden','breeze',
  'zombie_villager','zombified_piglin','bogged',
]);

let _lastThreatScan = 0, _cachedThreat = null;
function getNearestThreat(radius) {
  const now = Date.now();
  if (now - _lastThreatScan < 1000) return _cachedThreat;
  _lastThreatScan = now;
  const myPos = bot.entity.position, rSq = radius * radius;
  let best = null, bestD = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (!e || !e.position || e.id === bot.entity.id) continue;
    const dx = e.position.x - myPos.x, dz = e.position.z - myPos.z;
    if (dx*dx + dz*dz > rSq) continue;
    if (isFriendly(e)) continue;
    const isHostile = (e.type === 'mob' || e.type === 'hostile') && HOSTILE_MOBS.has(e.name);
    if (!isHostile && e.type !== 'player') continue;
    const d = Math.sqrt(dx*dx + dz*dz);
    if (d < bestD) { bestD = d; best = e; }
  }
  _cachedThreat = best;
  return best;
}

async function doAttack(target) {
  if (isFriendly(target)) return;
  if (Date.now() - lastAttackAt < ATTACK_COOLDOWN) return;
  try { await bot.lookAt(target.position.offset(0, 1.62, 0)); } catch(_){}
  if (!isCritting && Math.random() < CRIT_CHANCE) {
    isCritting = true;
    try {
      bot.setControlState('sprint', false);
      await sleep(30);
      bot.setControlState('jump', true);
      await sleep(CRIT_JUMP_DELAY);
      bot.setControlState('jump', false);
      bot.setControlState('sprint', true);
      await sleep(60);
      if (isFriendly(target)) { isCritting = false; return; }
      await bot.lookAt(target.position.offset(0, 1.62, 0));
      bot.attack(target); lastAttackAt = Date.now();
    } catch(_){}
    isCritting = false;
  } else {
    try { bot.setControlState('sprint', true); bot.attack(target); lastAttackAt = Date.now(); } catch(_){}
  }
}

async function mainLoop() {
  while (loopRunning) {
    try { await tick(); } catch(e) { log('ERR', e.message); }
    await sleep(TICK_MS);
  }
}

let _bot_goActive = false, _bot_goGoalSet = false;
let _platformRunning = false, _searchRunning = false;
let _lastEquip = 0;

async function tick() {
  const mode = sharedMode;

  if (mode === 'follow') {
    const t = getPlayer(followName);
    if (!t) { safeStop(); return; }
    bot.setControlState('sprint', true);
    const s = slotPos(t.position);
    moveToXZ(s.x, s.z, t.position.y);
    return;
  }

  if (mode === 'bodyguard') {
    if (Date.now() - _lastEquip > 10000) {
      _lastEquip = Date.now();
      const w = getBestWeapon();
      if (w) { try { await bot.equip(w, 'hand'); } catch(_){} }
    }
    const threat = getNearestThreat(BODYGUARD_R + 10);
    if (threat) {
      const d = distToPos(threat);
      if (d > ATTACK_RANGE) {
        bot.setControlState('sprint', true);
        bot.pathfinder.setGoal(new GoalFollow(threat, 1.5), true);
      } else { safeStop(); await doAttack(threat); }
    } else {
      const owner = getPlayer(OWNER);
      if (owner) { bot.setControlState('sprint', true); const s = slotPos(owner.position); moveToXZ(s.x, s.z, owner.position.y); }
    }
    return;
  }

  if (mode === 'train') {
    if (!trainTarget) { safeStop(); return; }
    const t = getPlayer(trainTarget);
    if (!t) { safeStop(); return; }
    bot.setControlState('sprint', true);
    const currentGoal = bot.pathfinder.goal;
    if (!currentGoal || currentGoal.entity !== t) bot.pathfinder.setGoal(new GoalFollow(t, 0.8), true);
    return;
  }

  // ── CIRCLE ───────────────────────────────────────────────────────────────────
  if (mode === 'circle') {
    if (!circleTarget) { safeStop(); return; }
    const t = getPlayer(circleTarget);
    if (!t) { safeStop(); return; }
    bot.setControlState('sprint', true);

    const total = Math.max(totalBots, 1);

    if (circleMode === 1) {
      // ── Mode 1: calm orbit ────────────────────────────────────────────────
      const ORBIT_R   = 2.2;
      const ROT_SPEED = 0.0006;
      const angle = (2 * Math.PI / total) * botIndex + Date.now() * ROT_SPEED;
      const tx = t.position.x + Math.cos(angle) * ORBIT_R;
      const tz = t.position.z + Math.sin(angle) * ORBIT_R;
      bot.pathfinder.setGoal(new GoalNear(tx, t.position.y, tz, 0.3), true);

    } else {
      // ── Mode 2: concentrated trap — 65% of bots on inner ring ────────────
      // Inner ring: ~65% of bots at 1.3 blocks — maximum cage pressure
      // Outer ring: remaining ~35% at 2.8 blocks — second containment layer
      const INNER_COUNT = Math.max(1, Math.ceil(total * 0.65));
      const isInner     = botIndex < INNER_COUNT;
      const ringIndex   = isInner ? botIndex : botIndex - INNER_COUNT;
      const ringTotal   = isInner ? INNER_COUNT : (total - INNER_COUNT) || 1;
      const RING_R      = isInner ? 1.3 : 2.8;
      const ROT_SPEED   = isInner ? 0.0015 : -0.0008; // inner CW, outer CCW

      const angle = (2 * Math.PI / Math.max(ringTotal, 1)) * ringIndex + Date.now() * ROT_SPEED;
      const tx = t.position.x + Math.cos(angle) * RING_R;
      const tz = t.position.z + Math.sin(angle) * RING_R;

      bot.pathfinder.setGoal(new GoalNear(tx, t.position.y, tz, 0.2), true);

      // If target drifted far from ring center, all bots sprint to close gap fast
      const distToTarget = bot.entity.position.distanceTo(t.position);
      if (distToTarget > RING_R + 4) {
        bot.setControlState('sprint', true);
        bot.pathfinder.setGoal(new GoalNear(tx, t.position.y, tz, 0.2), true);
      }
    }
    return;
  }

  if (mode === 'go') {
    if (!_bot_goActive || !gotoPos) return;
    bot.setControlState('sprint', true);
    if (distToPos(gotoPos) > 1.5) {
      if (!_bot_goGoalSet) {
        _bot_goGoalSet = true;
        bot.pathfinder.setGoal(new GoalNear(gotoPos.x, gotoPos.y, gotoPos.z, 0.5), true);
      }
    } else {
      _bot_goGoalSet = false; _bot_goActive = false;
      safeStop(); send('arrived', { username });
    }
    return;
  }

  if (mode === 'search') {
    if (!_searchRunning) {
      _searchRunning = true;
      searchHome = bot.entity.position.clone();
      runSearch().catch(e => { log('SEARCH_ERR', e.message); _searchRunning = false; });
    }
    return;
  }
}

async function runSearch() {
  applyMovements(false);
  searchAbort = false;
  const home  = searchHome.clone();
  const total = Math.max(totalBots, 1);
  const angle = (2 * Math.PI / total) * botIndex;
  const dx    = Math.cos(angle), dz = Math.sin(angle);
  const STEP  = 30, MAX_LEGS = 14, SCAN_R = 48;
  let cx = home.x, cz = home.z;

  async function walkTo(x, y, z, range) {
    bot.setControlState('sprint', true);
    bot.pathfinder.setGoal(new GoalNear(x, y, z, range), true);
    while (true) {
      if (searchAbort || sharedMode !== 'search') { safeStop(); return false; }
      if (bot.entity.position.distanceTo({ x, y: bot.entity.position.y, z }) <= range + 1) return true;
      await sleep(200);
    }
  }

  for (let leg = 0; leg < MAX_LEGS; leg++) {
    if (searchAbort || sharedMode !== 'search') break;
    cx += dx * STEP; cz += dz * STEP;
    const ok = await walkTo(Math.floor(cx), Math.floor(bot.entity.position.y), Math.floor(cz), 2);
    if (!ok) break;

    let best = null, bestD = Infinity;
    for (const [name, p] of Object.entries(bot.players)) {
      if (!p.entity || !p.entity.position) continue;
      if (name === OWNER || name === username || botUsernames.includes(name)) continue;
      const d = bot.entity.position.distanceTo(p.entity.position);
      if (d < SCAN_R && d < bestD) { bestD = d; best = { name, pos: p.entity.position }; }
    }

    if (best) {
      send('found', { finder: username, target: best.name, x: best.pos.x.toFixed(1), y: best.pos.y.toFixed(1), z: best.pos.z.toFixed(1) });
      await walkTo(Math.floor(home.x), Math.floor(home.y), Math.floor(home.z), 2);
      sharedMode = 'idle'; _searchRunning = false; return;
    }
  }

  await walkTo(Math.floor(home.x), Math.floor(home.y), Math.floor(home.z), 2);
  sharedMode = 'idle'; _searchRunning = false;
}

connect();
