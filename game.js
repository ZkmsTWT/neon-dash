/* ============================================================
   NEON DASH — 类矢量跑酷 (pseud0-3D lane runner)
   Pure canvas, no dependencies.
   ============================================================ */
'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

/* ---------- sizing ---------- */
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/* ---------- helpers ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------- game constants ---------- */
const LANES = [-1, 0, 1];
const SPACING = 2.6;            // lane width in world units
const CAM_H = 4.2;              // camera height
const FOV = 42;                // degrees
const HORIZON = 0.42;          // horizon at 42% of screen height
const Z_NEAR = 0.4;
const Z_FAR = 140;
const TUBE_R = 4.4;            // side "city" wall distance
const GRAVITY = -38;
const JUMP_V = 15.5;
const DASH_MAX = 1.0;
const DASH_DRAIN = 0.9;       // per second while holding
const DASH_RECHARGE = 0.35;   // per second otherwise

/* ---------- state ---------- */
const G = {
  state: 'menu',               // menu | play | over
  t: 0,
  speed: 18,                   // world units / sec
  dist: 0,
  score: 0,
  best: +(localStorage.getItem('neondash_best') || 0),
  gems: 0,
  combo: 0,
  comboTimer: 0,
  shake: 0,
  flash: 0,
  dash: DASH_MAX,
  dashHeld: false,
  playerLane: 0,
  playerLaneX: 0,             // smoothed x (world units)
  y: 0,                       // jump height
  vy: 0,
  onGround: true,
  airT: 0,
  invuln: 0,
  crash: null,
  obstacles: [],
  gemsArr: [],
  particles: [],
  gridPhase: 0,
  hue: 0,
  spawnTimer: 0,
  gemTimer: 0,
};

function worldX(lane) { return lane * SPACING; }

/* perspective projection: world (x, y, z) -> screen */
function project(x, y, z) {
  const f = H * (FOV * 0.011);
  const zc = Math.max(z, Z_NEAR);
  const scale = f / zc;
  const horizonY = H * HORIZON;
  return {
    x: W / 2 + x * scale,
    y: horizonY + (CAM_H - y) * scale,
    s: scale,
  };
}

/* ============================================================
   INPUT
   ============================================================ */
const keys = {};
window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (['ArrowLeft','ArrowRight',' ','Shift','Enter'].includes(k)) e.preventDefault();
  if (keys[k]) return; // ignore auto-repeat
  keys[k] = true;
  if (G.state === 'menu' || G.state === 'over') {
    if (k === 'Enter') startGame();
    return;
  }
  if (G.state !== 'play') return;
  if (k === 'ArrowLeft') moveLane(-1);
  if (k === 'ArrowRight') moveLane(1);
  if (k === ' ' || k === 'ArrowUp') jump();
  if (k === 'Shift') G.dashHeld = true;
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  if (e.key === 'Shift') G.dashHeld = false;
});

function moveLane(dir) {
  G.playerLane = clamp(G.playerLane + dir, -1, 1);
}
function jump() {
  if (G.onGround) {
    G.vy = JUMP_V;
    G.onGround = false;
    G.airT = 0;
    spawnRing('jump');
  }
}

/* touch buttons */
document.querySelectorAll('#touch .kbd').forEach(btn => {
  const act = btn.dataset.a;
  const press = (e) => {
    e.preventDefault();
    if (G.state !== 'play') { startGame(); return; }
    if (act === 'left') moveLane(-1);
    else if (act === 'right') moveLane(1);
    else if (act === 'jump') jump();
    else if (act === 'boost') G.dashHeld = true;
  };
  const release = () => { if (act === 'boost') G.dashHeld = false; };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
});

document.getElementById('play').addEventListener('click', startGame);
document.getElementById('retry').addEventListener('click', startGame);

/* ============================================================
   SPAWNING
   ============================================================ */
function spawnObstacle() {
  const typeRoll = Math.random();
  let type;
  if (typeRoll < 0.42) type = 'low';      // ground barrier (jump over)
  else if (typeRoll < 0.70) type = 'high'; // overhead bar (stay low / don't jump)
  else if (typeRoll < 0.86) type = 'wall'; // full lane wall (switch lane)
  else type = 'gate';     // slalom: two short walls with one open lane
  const lanePick = LANES[Math.floor(Math.random() * 3)];
  const o = { type, z: Z_FAR, dead: false, hit: false, phase: rand(0, Math.PI * 2) };
  if (type === 'wall') o.lanes = [lanePick];
  else if (type === 'gate') {
    const open = lanePick;
    o.lanes = LANES.filter(l => l !== open); // walls on the two closed lanes
  } else o.lane = lanePick;
  G.obstacles.push(o);
  // occasional double wall at higher difficulty — never in the open lane of a gate
  if (type === 'wall' && G.speed > 26 && Math.random() < 0.28) {
    let pick = LANES[Math.floor(Math.random()*3)];
    // avoid stacking two walls on top of a gate's open lane right ahead
    const nearGate = G.obstacles.find(x => x.type === 'gate' && Math.abs(x.z - o.z) < 12);
    if (nearGate && nearGate.lanes.includes(pick)) pick = LANES.find(l => l !== nearGate.lanes[0] && l !== nearGate.lanes[1]) ?? pick;
    const o2 = { type: 'wall', z: o.z + 7, lanes: [pick], dead:false, hit:false, phase: o.phase };
    G.obstacles.push(o2);
  }
}

function spawnGemLine() {
  const lane = LANES[Math.floor(Math.random() * 3)];
  const count = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    G.gemsArr.push({ lane, z: Z_FAR + i * 2.4, y: 0, phase: rand(0, Math.PI*2), got: false });
  }
}

/* ============================================================
   PARTICLES
   ============================================================ */
function spawnRing(kind) {
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    G.particles.push({
      kind: 'ring', x: worldX(G.playerLane), y: G.onGround ? 0.05 : G.y, z: Z_NEAR + 0.5,
      vx: Math.cos(a) * 2.4, vy: Math.sin(a) * 1.2 + (kind === 'jump' ? 1.5 : 0),
      life: 0.5, t: 0, hue: 190,
    });
  }
}
function spawnBurst(x, y, z, hue) {
  for (let i = 0; i < 26; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(2, 9);
    G.particles.push({
      kind: 'spark', x, y, z,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(2, 8),
      life: rand(0.4, 0.9), t: 0, hue,
    });
  }
}
function spawnTrail() {
  G.particles.push({
    kind: 'trail', x: worldX(G.playerLane), y: G.y + 0.9, z: Z_NEAR + 0.3,
    vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), vz: 6,
    life: 0.35, t: 0, hue: G.dashHeld ? 300 : 190,
  });
}

/* ============================================================
   COLLISION
   ============================================================ */
function laneAtObstacle(o) {
  if (o.type === 'wall' || o.type === 'gate') return o.lanes;
  return [o.lane];
}
function inPlayerLane(o) {
  const diff = Math.abs(G.playerLaneX - worldX(o.lane !== undefined ? o.lane : 0));
  if (o.type === 'wall' || o.type === 'gate') {
    return o.lanes.some(l => Math.abs(G.playerLaneX - worldX(l)) < SPACING * 0.52);
  }
  return diff < SPACING * 0.5;
}

function checkCollisions() {
  const pz = G.playerLaneX;
  for (const o of G.obstacles) {
    if (o.dead || o.hit) continue;
    if (o.z > 6 || o.z < -1) continue;
    if (!inPlayerLane(o)) continue;
    if (o.type === 'low') {
      // must be above the barrier height
      if (G.y < 1.1) crash();
    } else if (o.type === 'high') {
      // must stay grounded (don't jump into it)
      if (G.y > 1.4) crash();
    } else {
      // wall / gate: any contact in that lane
      crash();
    }
  }
}

function crash() {
  if (G.invuln > 0) return;
  G.state = 'over';
  G.shake = 1;
  G.flash = 1;
  G.crash = { x: G.playerLaneX, y: G.y, z: Z_NEAR + 0.5 };
  spawnBurst(G.playerLaneX, G.y + 0.8, Z_NEAR + 0.5, 0);
  G.best = Math.max(G.best, Math.floor(G.score));
  localStorage.setItem('neondash_best', G.best);
  showOver();
}

/* ============================================================
   FLOW
   ============================================================ */
function startGame() {
  G.state = 'play';
  G.t = 0; G.dist = 0; G.score = 0; G.gems = 0;
  G.combo = 0; G.comboTimer = 0;
  G.speed = 16;
  G.playerLane = 0; G.playerLaneX = 0;
  G.y = 0; G.vy = 0; G.onGround = true;
  G.invuln = 0; G.dash = DASH_MAX; G.dashHeld = false;
  G.obstacles = []; G.gemsArr = []; G.particles = [];
  G.spawnTimer = 0.9; G.gemTimer = 2.2;
  G.hue = 180;
  document.getElementById('start').classList.add('hidden');
  document.getElementById('over').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
}
function showOver() {
  document.getElementById('final').textContent = Math.floor(G.score);
  document.getElementById('best2').textContent = G.best;
  document.getElementById('best').textContent = G.best;
  document.getElementById('over').classList.remove('hidden');
  document.getElementById('hud').classList.add('hidden');
}

/* ============================================================
   UPDATE
   ============================================================ */
function update(dt) {
  G.t += dt;
  G.hue = (180 + G.dist * 0.12) % 360;

  if (G.state === 'menu') {
    G.gridPhase += dt * 4;
    updateParticles(dt);
    return;
  }
  if (G.state === 'over') {
    G.shake = Math.max(0, G.shake - dt * 1.6);
    G.flash = Math.max(0, G.flash - dt * 1.4);
    G.gridPhase += dt * 2;
    updateParticles(dt);
    return;
  }

  /* --- speed & dash --- */
  const speedCap = 16 + G.dist * 0.012;
  let targetSpeed = Math.min(speedCap, 16 + G.dist * 0.012);
  let dashMul = 1;
  if (G.dashHeld && G.dash > 0.02) {
    G.dash = Math.max(0, G.dash - DASH_DRAIN * dt);
    dashMul = 1.75;
    targetSpeed = Math.min(52, targetSpeed * 1.55);
    if (Math.random() < 0.7) spawnTrail();
  } else {
    G.dash = Math.min(DASH_MAX, G.dash + DASH_RECHARGE * dt);
  }
  G.speed = lerp(G.speed, targetSpeed * dashMul, 1 - Math.exp(-3 * dt));
  G.dist += G.speed * dt;
  G.score += G.speed * dt * 0.12 * (dashMul > 1 ? 1.6 : 1);

  /* --- lane smoothing --- */
  G.playerLaneX = lerp(G.playerLaneX, worldX(G.playerLane), 1 - Math.exp(-14 * dt));

  /* --- jump physics --- */
  if (!G.onGround) {
    G.airT += dt;
    G.vy += GRAVITY * dt;
    G.y += G.vy * dt;
    if (G.y <= 0) { G.y = 0; G.vy = 0; G.onGround = true; spawnRing('land'); }
  }
  G.invuln = Math.max(0, G.invuln - dt);

  /* --- spawn --- */
  G.spawnTimer -= dt * (dashMul > 1 ? 1.4 : 1);
  if (G.spawnTimer <= 0) {
    spawnObstacle();
    const base = clamp(1.55 - G.dist * 0.0004, 0.62, 1.55);
    G.spawnTimer = base * rand(0.8, 1.25);
  }
  G.gemTimer -= dt;
  if (G.gemTimer <= 0) { spawnGemLine(); G.gemTimer = rand(2.5, 4.5); }

  /* --- advance world objects --- */
  const step = G.speed * dt;
  for (const o of G.obstacles) { o.z -= step; o.phase += dt * 4; }
  for (const g of G.gemsArr) { g.z -= step; g.phase += dt * 5; }
  G.obstacles = G.obstacles.filter(o => o.z > -8);
  G.gemsArr = G.gemsArr.filter(g => !g.got && g.z > -4);

  /* --- gems --- */
  for (const g of G.gemsArr) {
    if (g.z < 1.4 && g.z > -0.8 && Math.abs(G.playerLaneX - worldX(g.lane)) < SPACING * 0.5 && g.y === 0) {
      g.got = true;
      G.gems++;
      G.combo++;
      G.comboTimer = 2.2;
      G.score += 15 * Math.min(G.combo, 10);
      spawnBurst(G.playerLaneX, 0.6, 1.2, 55);
    }
  }
  if (G.comboTimer > 0) {
    G.comboTimer -= dt;
    if (G.comboTimer <= 0) G.combo = 0;
  }

  checkCollisions();
  updateParticles(dt);

  /* HUD */
  document.getElementById('score').textContent = Math.floor(G.score);
  document.getElementById('best').textContent = G.best;
  document.getElementById('boostbar').style.width = (G.dash * 100) + '%';
  document.getElementById('combo').textContent = G.combo >= 2 ? `COMBO x${G.combo}` : '';
}

function updateParticles(dt) {
  for (const p of G.particles) {
    p.t += dt;
    p.x += p.vx * dt;
    p.y += (p.vy || 0) * dt;
    if (p.kind === 'spark' || p.kind === 'trail') p.z += (p.vz || 0) * dt;
    if (p.kind === 'spark') p.vy -= 22 * dt;
  }
  G.particles = G.particles.filter(p => p.t < p.life);
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  ctx.clearRect(0, 0, W, H);

  /* camera shake */
  ctx.save();
  if (G.shake > 0) {
    ctx.translate(rand(-1, 1) * G.shake * 22, rand(-1, 1) * G.shake * 22);
  }

  drawBackground();
  drawGrid();
  drawCity();

  // collect drawables by depth for correct order
  const items = [];
  for (const o of G.obstacles) items.push({ z: o.z, f: () => drawObstacle(o) });
  for (const g of G.gemsArr) if (!g.got) items.push({ z: g.z, f: () => drawGem(g) });
  items.sort((a, b) => b.z - a.z);
  for (const it of items) it.f();

  if (G.state !== 'over') drawPlayer();
  drawParticles();
  ctx.restore();

  /* crash flash */
  if (G.flash > 0) {
    ctx.fillStyle = `rgba(255,60,120,${G.flash * 0.45})`;
    ctx.fillRect(0, 0, W, H);
  }

  /* subtle vignette */
  const vg = ctx.createRadialGradient(W/2, H/2, H*0.35, W/2, H/2, H*0.85);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,10,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, H * HORIZON);
  g.addColorStop(0, '#040413');
  g.addColorStop(1, '#12082a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * HORIZON + 2);

  /* sun / planet */
  const cx = W * 0.5, cy = H * HORIZON - 14;
  const sun = ctx.createRadialGradient(cx, cy, 4, cx, cy, H * 0.16);
  sun.addColorStop(0, `hsla(${(G.hue + 120) % 360},100%,72%,.95)`);
  sun.addColorStop(0.5, `hsla(${(G.hue + 90) % 360},90%,55%,.35)`);
  sun.addColorStop(1, 'transparent');
  ctx.fillStyle = sun;
  ctx.beginPath(); ctx.arc(cx, cy, H * 0.16, 0, Math.PI * 2); ctx.fill();

  /* stars */
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  for (let i = 0; i < 60; i++) {
    const sx = ((i * 137.5 + G.gridPhase * 2) % (W + 40)) - 20;
    const sy = (i * 91.7) % (H * HORIZON * 0.95);
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(G.t * 2 + i));
    ctx.globalAlpha = tw * 0.5;
    ctx.fillRect(sx, sy, 1.6, 1.6);
  }
  ctx.globalAlpha = 1;
}

function drawGrid() {
  const step = 4;
  const startOff = G.state === 'play' ? (G.dist % step) : (G.gridPhase * 0.5) % step;
  const horizonY = H * HORIZON;

  ctx.lineWidth = 1;
  // longitudinal lines (running toward viewer)
  for (let x = -8; x <= 8; x++) {
    const a = project(x * step * 0.55, 0, Z_NEAR);
    const b = project(x * step * 0.55, 0, Z_FAR);
    ctx.strokeStyle = `hsla(${(G.hue + 180) % 360},80%,60%,${0.06 + (Math.abs(x) < 2 ? 0.1 : 0)})`;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // transverse lines (receding)
  for (let i = 0; i < 40; i++) {
    const z = Z_NEAR + ((i * step + step - startOff) % (Z_FAR - Z_NEAR));
    const p = project(0, 0, z);
    if (p.s < 1.2) continue;
    const alpha = clamp((p.s - 1) / 60, 0, 1) * 0.5;
    ctx.strokeStyle = `hsla(${(G.hue) % 360},90%,65%,${alpha})`;
    ctx.beginPath();
    const l = project(-TUBE_R * 3, 0, z), r = project(TUBE_R * 3, 0, z);
    ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
  }

  // lane center guide glow (track floor)
  const fl = project(-SPACING * 1.5, 0, Z_NEAR), fr = project(SPACING * 1.5, 0, Z_NEAR);
  const bl = project(-SPACING * 1.5, 0, Z_FAR), br = project(SPACING * 1.5, 0, Z_FAR);
  const floorGrad = ctx.createLinearGradient(0, bl.y, 0, fl.y);
  floorGrad.addColorStop(0, `hsla(${(G.hue+180)%360},70%,40%,0)`);
  floorGrad.addColorStop(1, `hsla(${(G.hue+180)%360},70%,45%,.16)`);
  ctx.fillStyle = floorGrad;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y); ctx.lineTo(fr.x, fr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
  ctx.closePath(); ctx.fill();

  // lane divider dashes
  ctx.setLineDash([10, 14]);
  for (const lx of [-SPACING/2, SPACING/2]) {
    const a = project(lx, 0.02, Z_NEAR), b = project(lx, 0.02, Z_FAR * 0.8);
    ctx.strokeStyle = `hsla(${G.hue % 360},80%,70%,.5)`;
    ctx.lineWidth = 2;
    ctx.lineDashOffset = -G.dist * 4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

function drawCity() {
  // receding light pillars on both sides
  for (const side of [-1, 1]) {
    for (let i = 0; i < 14; i++) {
      const z = Z_NEAR + 2 + i * 8;
      const jitter = Math.sin(i * 7 + G.t * 0.6) * 0.8;
      const x = side * (TUBE_R + 1.5 + jitter);
      const h = 2.5 + Math.abs(Math.sin(i * 3.1)) * 5;
      const a = project(x, 0, z), b = project(x, h, z);
      const alpha = clamp((a.s - 0.5) / 50, 0.05, 0.4);
      ctx.strokeStyle = `hsla(${(G.hue + side * 60) % 360},95%,65%,${alpha})`;
      ctx.lineWidth = Math.max(1.5, a.s * 0.5);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      // cap dot
      ctx.fillStyle = `hsla(${(G.hue + 180 + side * 60) % 360},100%,75%,${alpha})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(1, a.s * 0.6), 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawObstacle(o) {
  const p = project(0, 0, o.z);
  if (p.s < 1.5) return;
  const glow = `hsl(${(G.hue + 300) % 360},100%,60%)`;

  if (o.type === 'low') {
    const cx = project(worldX(o.lane), 0, o.z);
    const w = cx.s * SPACING * 0.72, hgt = cx.s * 1.0;
    ctx.strokeStyle = glow; ctx.lineWidth = Math.max(1.5, cx.s * 0.16);
    ctx.shadowColor = glow; ctx.shadowBlur = cx.s * 1.6;
    ctx.strokeRect(cx.x - w/2, cx.y - hgt, w, hgt * 0.92);
    ctx.shadowBlur = 0;
    // inner hatch
    ctx.strokeStyle = `hsla(${(G.hue+300)%360},100%,70%,.35)`;
    ctx.lineWidth = Math.max(1, cx.s * 0.06);
    for (let i = 1; i < 4; i++) {
      const yy = cx.y - hgt + (hgt * 0.92 * i) / 4;
      ctx.beginPath(); ctx.moveTo(cx.x - w/2 + 3, yy); ctx.lineTo(cx.x + w/2 - 3, yy); ctx.stroke();
    }
  } else if (o.type === 'high') {
    const yTop = 1.4;
    const cx = project(worldX(o.lane), yTop, o.z);
    const w = cx.s * SPACING * 0.86, hgt = cx.s * 0.6;
    ctx.strokeStyle = `hsl(${(G.hue + 40) % 360},100%,62%)`;
    ctx.lineWidth = Math.max(1.5, cx.s * 0.18);
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = cx.s * 1.4;
    ctx.strokeRect(cx.x - w/2, cx.y - hgt, w, hgt);
    ctx.shadowBlur = 0;
    // hang lines
    ctx.strokeStyle = `hsla(${(G.hue+40)%360},80%,70%,.5)`;
    ctx.lineWidth = Math.max(1, cx.s * 0.05);
    ctx.beginPath(); ctx.moveTo(cx.x - w/2, cx.y - hgt); ctx.lineTo(cx.x - w/2, project(worldX(o.lane), 3.2, o.z).y);
    ctx.moveTo(cx.x + w/2, cx.y - hgt); ctx.lineTo(cx.x + w/2, project(worldX(o.lane), 3.2, o.z).y);
    ctx.stroke();
  } else {
    // wall / gate
    for (const ln of o.lanes) {
      const cx = project(worldX(ln), 0, o.z);
      const w = cx.s * SPACING * 0.8, hgt = cx.s * 2.6;
      const grad = ctx.createLinearGradient(cx.x, cx.y - hgt, cx.x, cx.y);
      grad.addColorStop(0, `hsla(${(G.hue + 280) % 360},100%,65%,.85)`);
      grad.addColorStop(1, `hsla(${(G.hue + 320) % 360},100%,55%,.85)`);
      ctx.fillStyle = grad;
      ctx.shadowColor = glow; ctx.shadowBlur = cx.s * 2;
      ctx.fillRect(cx.x - w/2, cx.y - hgt, w, hgt);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `hsla(${(G.hue + 320) % 360},100%,80%,.9)`;
      ctx.lineWidth = Math.max(1.5, cx.s * 0.12);
      ctx.strokeRect(cx.x - w/2, cx.y - hgt, w, hgt);
      // chevron
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = Math.max(1.5, cx.s * 0.1);
      ctx.beginPath();
      ctx.moveTo(cx.x - w*0.28, cx.y - hgt*0.35);
      ctx.lineTo(cx.x, cx.y - hgt*0.55);
      ctx.lineTo(cx.x + w*0.28, cx.y - hgt*0.35);
      ctx.stroke();
    }
  }
}

function drawGem(g) {
  const p = project(worldX(g.lane), g.y + 0.55 + Math.sin(g.phase) * 0.18, g.z);
  if (p.s < 1.5) return;
  const s = p.s * 0.42;
  const bob = Math.sin(g.phase) * p.s * 0.1;
  const cx = p.x, cy = p.y - s + bob;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  const grad = ctx.createLinearGradient(-s, -s, s, s);
  grad.addColorStop(0, '#ffe45e');
  grad.addColorStop(1, '#ff8a3d');
  ctx.fillStyle = grad;
  ctx.shadowColor = '#ffcf4d'; ctx.shadowBlur = s * 2.2;
  ctx.fillRect(-s/2, -s/2, s, s);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = Math.max(1, s * 0.12);
  ctx.strokeRect(-s/2, -s/2, s, s);
  ctx.restore();
}

function drawPlayer() {
  const px = G.playerLaneX;
  const py = G.y;
  const p = project(px, py, Z_NEAR + 0.5);
  const s = p.s;
  const bx = p.x, by = p.y;

  // shadow on ground
  const gs = project(px, 0, Z_NEAR + 0.5);
  const shScale = clamp(1 - py * 0.12, 0.25, 1);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.beginPath();
  ctx.ellipse(gs.x, gs.y, s * 0.55 * shScale, s * 0.18 * shScale, 0, 0, Math.PI * 2);
  ctx.fill();

  // invuln blink
  if (G.invuln > 0 && Math.floor(G.t * 16) % 2 === 0) ctx.globalAlpha = 0.4;

  // body — glowing vector runner (stylized chevron capsule)
  const bodyH = s * 1.7, bodyW = s * 0.95;
  const tilt = clamp((worldX(G.playerLane) - px) * 0.6, -0.5, 0.5); // lean into lane change
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(tilt * 0.25);

  const dashGlow = G.dashHeld && G.dash > 0.02;
  const col = dashGlow ? `hsl(${(G.hue + 300) % 360},100%,65%)` : `hsl(${G.hue % 360},100%,65%)`;
  ctx.shadowColor = col; ctx.shadowBlur = s * 1.8;

  // torso
  const grad = ctx.createLinearGradient(0, -bodyH, 0, 0);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, col);
  ctx.fillStyle = grad;
  roundRectPath(ctx, -bodyW/2, -bodyH, bodyW, bodyH, bodyW * 0.45);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = Math.max(1.5, s * 0.1);
  roundRectPath(ctx, -bodyW/2, -bodyH, bodyW, bodyH, bodyW * 0.45);
  ctx.stroke();

  // visor
  ctx.fillStyle = 'rgba(10,20,40,.85)';
  roundRectPath(ctx, -bodyW*0.28, -bodyH*0.78, bodyW*0.56, bodyH*0.2, bodyW*0.2);
  ctx.fill();

  // running legs (phase by distance)
  const ph = G.dist * 2.2;
  ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, s * 0.16);
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    const legA = Math.sin(ph + (side === 1 ? Math.PI : 0)) * 0.5;
    const lx = side * bodyW * 0.28;
    ctx.beginPath();
    ctx.moveTo(lx, -bodyH * 0.12);
    ctx.lineTo(lx + Math.sin(legA) * s * 0.5, bodyH * 0.05 + Math.abs(Math.cos(legA)) * s * 0.12);
    ctx.stroke();
  }
  // arms
  for (const side of [-1, 1]) {
    const armA = Math.sin(ph + (side === 1 ? 0 : Math.PI)) * 0.6;
    const ax = side * bodyW * 0.6;
    ctx.beginPath();
    ctx.moveTo(ax, -bodyH * 0.85);
    ctx.lineTo(ax + Math.sin(armA) * s * 0.45, -bodyH * 0.85 + Math.cos(armA) * s * 0.3);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawParticles() {
  for (const p of G.particles) {
    const pr = project(p.x, p.y, p.z);
    if (pr.s < 1.2) continue;
    const k = 1 - p.t / p.life;
    if (p.kind === 'spark') {
      ctx.fillStyle = `hsla(${p.hue},100%,70%,${k})`;
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = pr.s * 1.5;
      const sz = pr.s * 0.22 * k + 1;
      ctx.fillRect(pr.x - sz/2, pr.y - sz/2, sz, sz);
      ctx.shadowBlur = 0;
    } else if (p.kind === 'ring') {
      ctx.strokeStyle = `hsla(${p.hue},100%,75%,${k * 0.8})`;
      ctx.lineWidth = Math.max(1, pr.s * 0.12 * k);
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, pr.s * 0.5 * (0.3 + p.t / p.life), 0, Math.PI * 2);
      ctx.stroke();
    } else { // trail
      ctx.fillStyle = `hsla(${p.hue},100%,75%,${k * 0.7})`;
      const sz = pr.s * 0.16 * k + 1;
      ctx.beginPath(); ctx.arc(pr.x, pr.y, sz, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ============================================================
   LOOP
   ============================================================ */
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.033);
  last = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* seed initial best display */
document.getElementById('best').textContent = G.best;
document.getElementById('best2').textContent = G.best;
