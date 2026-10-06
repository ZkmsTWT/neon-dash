/* ============================================================
   NEON DASH v2 — 双机位矢量跑酷
   第三人称惯性跟随 / 第一人称胸前视角（摆臂）
   ============================================================ */
'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

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

/* ---------- math helpers ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------- world constants ---------- */
const TUBE_R = 4.4;
const LANES = [-1, 0, 1];
const SPACING = 2.6;
const GRAVITY = -38;
const JUMP_V = 15.5;
const DASH_MAX = 1.0;
const DASH_DRAIN = 0.9;
const DASH_RECHARGE = 0.35;

/* camera: 第三人称惯性参数 */
const CAM3 = {
  dist: 3.4,     // 相机在玩家后方的距离
  height: 2.1,   // 相机高度（跟随玩家跳跃，带阻尼）
  lookAhead: 6.5,// 相机看向玩家前方多远
  followK: 5.2,  // 位置跟随阻尼
  lookK: 3.4,    // 视角惯性阻尼（越小越"飘"）
  shake: 0,
};
/* 第一人称：胸前视角 */
const CAM1 = {
  height: 1.55,  // 胸口高度
  fovMul: 1.15,  // 比第三人称稍宽一点，有"贴脸"感
  bobAmp: 0.07,  // 跑步上下起伏幅度
  swingAmp: 0.9, // 摆臂角度（弧度）
};

const G = {
  state: 'menu',
  t: 0,
  speed: 18,
  dist: 0,
  score: 0,
  best: +(localStorage.getItem('neondash_best') || 0),
  gems: 0,
  combo: 0,
  comboTimer: 0,
  flash: 0,
  dash: DASH_MAX,
  dashHeld: false,
  playerLane: 0,
  playerLaneX: 0,
  y: 0,
  vy: 0,
  onGround: true,
  airT: 0,
  invuln: 0,
  obstacles: [],
  gemsArr: [],
  particles: [],
  spawnTimer: 0,
  gemTimer: 0,
  hue: 180,

  /* 相机运行时状态 */
  camMode: 3,        // 3 = 第三人称, 1 = 第一人称
  camX: 0, camY: CAM3.height, camZ: -CAM3.dist, // 世界 z（第三人称相机在玩家身后）
  lookZ: 0,
  lookX: 0, // 视线目标（玩家前方）
  lookX: 0,
  pitch: 0,          // 第一人称垂直视角
  running: false,
  runPhase: 0,

  /* 道路两侧具象化道具 */
  scenery: [],
};

function worldX(lane) { return lane * SPACING; }

/* ============================================================
   相机：第三人称（惯性跟随）
   ============================================================ */
function camState() {
  if (G.camMode === 1) {
    // 第一人称：固定在玩家胸前
    const bob = G.running ? Math.sin(G.runPhase * 2) * CAM1.bobAmp : 0;
    return {
      x: G.playerLaneX,
      y: G.y + CAM1.height + bob,
      z: G.dist,          // 相机在胸口位置（与玩家同 z）
      lookX: G.playerLaneX,
      lookZ: G.dist + CAM3.lookAhead,
      fovMul: CAM1.fovMul,
      firstPerson: true,
    };
  }
  // 第三人称：平滑位置 + 视角惯性
  const tx = G.playerLaneX;
  const ty = G.y + CAM3.height;
  const tz = G.dist - CAM3.dist;
  const dt = 1 / 60;
  const kPos = 1 - Math.exp(-CAM3.followK * dt);
  const kLook = 1 - Math.exp(-CAM3.lookK * dt);
  G.camX = lerp(G.camX, tx, kPos * 1.6);
  G.camY = lerp(G.camY, ty, kPos * 1.4);
  G.camZ = lerp(G.camZ, tz, kPos * 1.6);

  G.lookZ = lerp(G.lookZ, G.dist + CAM3.lookAhead, kLook);
  G.lookX = lerp(G.lookX, G.playerLaneX, kLook * 1.2);

  return {
    x: G.camX, y: G.camY, z: G.camZ,
    lookX: G.lookX, lookZ: G.lookZ,
    fovMul: 1,
    firstPerson: false,
  };
}

/* 世界坐标 -> 屏幕坐标 在 RENDER 部分的 project() 实现 */
const Z_NEAR = 0.4, Z_FAR = 140;
const FOV_DEG = 42;
const HORIZON = 0.40;

/* ============================================================
   道路两侧具象化道具
   ============================================================ */
/* 类型: tower=霓虹塔楼, arch=拱门, pylon=能量柱, billboard=全息广告屏, streetlight=路灯 */
const SCEN_TYPES = ['tower', 'arch', 'pylon', 'billboard', 'streetlight'];
function spawnScenery() {
  // 在道路两侧生成一批具象化物件，随距离推进
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const z = G.dist + 18 + i * 22 + rand(0, 8);
      const type = SCEN_TYPES[Math.floor(rand(0, SCEN_TYPES.length))];
      const xOff = side * rand(5.5, 11);
      G.scenery.push({
        side, x: xOff, z, type,
        h: rand(3, 9),
        hue: rand(0, 360),
        seed: Math.floor(rand(0, 99999)),
        phase: rand(0, Math.PI * 2),
      });
    }
  }
  G.scenery = G.scenery.filter(s => s.z - G.dist < Z_FAR * 1.3 && s.z - G.dist > -CAM3.dist - 4);
}

/* ============================================================
   INPUT
   ============================================================ */
const keys = {};
window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (['ArrowLeft','ArrowRight',' ','Shift','Enter','c','C','1','2','3'].includes(k)) e.preventDefault();
  if (keys[k]) return;
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
  if (k === 'c' || k === 'C') toggleCamera();
  if (k === '1') setCam(3);
  if (k === '2') setCam(1);
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  if (e.key === 'Shift') G.dashHeld = false;
});

function moveLane(dir) { G.playerLane = clamp(G.playerLane + dir, -1, 1); }
function jump() {
  if (G.onGround) { G.vy = JUMP_V; G.onGround = false; G.airT = 0; spawnRing('jump'); }
}
function setCam(m) { G.camMode = m; updateCamBadge(); }
function toggleCamera() { G.camMode = G.camMode === 1 ? 3 : 1; updateCamBadge(); }
function updateCamBadge() {
  const el = document.getElementById('cambadge');
  if (el) { el.textContent = G.camMode === 1 ? '第一人称 [C]' : '第三人称 [C]'; el.style.display = 'block'; }
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
    else if (act === 'cam') toggleCamera();
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
  if (typeRoll < 0.42) type = 'low';
  else if (typeRoll < 0.70) type = 'high';
  else if (typeRoll < 0.86) type = 'wall';
  else type = 'gate';
  const lanePick = LANES[Math.floor(Math.random() * 3)];
  const o = { type, z: G.dist + Z_FAR, dead: false, hit: false, phase: rand(0, Math.PI * 2) };
  if (type === 'wall') o.lanes = [lanePick];
  else if (type === 'gate') {
    o.lanes = LANES.filter(l => l !== lanePick);
  } else o.lane = lanePick;
  G.obstacles.push(o);
  // 双墙（避免全堵死）
  if (type === 'wall' && G.speed > 26 && Math.random() < 0.28) {
    let pick = LANES[Math.floor(Math.random() * 3)];
    const nearGate = G.obstacles.find(x => x.type === 'gate' && Math.abs(x.z - o.z) < 12);
    if (nearGate && nearGate.lanes.includes(pick)) pick = LANES.find(l => !nearGate.lanes.includes(l)) ?? pick;
    G.obstacles.push({ type: 'wall', z: o.z + 7, lanes: [pick], dead: false, hit: false, phase: o.phase });
  }
}

function spawnGemLine() {
  const lane = LANES[Math.floor(Math.random() * 3)];
  const count = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    G.gemsArr.push({ lane, z: G.dist + Z_FAR + i * 2.4, y: 0, phase: rand(0, Math.PI * 2), got: false });
  }
}

/* ============================================================
   PARTICLES
   ============================================================ */
function spawnRing(kind) {
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    G.particles.push({
      kind: 'ring', x: worldX(G.playerLane), y: G.onGround ? 0.05 : G.y, z: G.dist,
      vx: Math.cos(a) * 2.4, vy: Math.sin(a) * 1.2 + (kind === 'jump' ? 1.5 : 0),
      life: 0.5, t: 0, hue: 190,
    });
  }
}
function spawnBurst(x, y, z, hue) {
  for (let i = 0; i < 26; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(2, 9);
    G.particles.push({ kind: 'spark', x, y, z, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(2, 8), life: rand(0.4, 0.9), t: 0, hue });
  }
}
function spawnTrail() {
  G.particles.push({ kind: 'trail', x: worldX(G.playerLane), y: G.y + 0.9, z: G.dist,
    vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), vz: 6, life: 0.35, t: 0, hue: G.dashHeld ? 300 : 190 });
}

/* ============================================================
   COLLISION
   ============================================================ */
function inPlayerLane(o) {
  if (o.type === 'wall' || o.type === 'gate') {
    return o.lanes.some(l => Math.abs(G.playerLaneX - worldX(l)) < SPACING * 0.52);
  }
  return Math.abs(G.playerLaneX - worldX(o.lane)) < SPACING * 0.5;
}
function checkCollisions() {
  for (const o of G.obstacles) {
    if (o.dead || o.hit) continue;
    if (o.z - G.dist > 6 || o.z - G.dist < -1) continue;
    if (!inPlayerLane(o)) continue;
    if (o.type === 'low') { if (G.y < 1.1) crash(); }
    else if (o.type === 'high') { if (G.y > 1.4) crash(); }
    else crash();
  }
}
function crash() {
  if (G.invuln > 0) return;
  G.state = 'over';
  G.flash = 1;
  G.camShake = 1;
  spawnBurst(G.playerLaneX, G.y + 0.8, G.dist, 0);
  G.best = Math.max(G.best, Math.floor(G.score));
  localStorage.setItem('neondash_best', G.best);
  showOver();
}

/* ============================================================
   FLOW
   ============================================================ */
function startGame() {
  G.state = 'play';
  G.t = 0; G.dist = 0; G.score = 0; G.gems = 0; G.combo = 0; G.comboTimer = 0;
  G.speed = 16;
  G.playerLane = 0; G.playerLaneX = 0;
  G.y = 0; G.vy = 0; G.onGround = true;
  G.invuln = 0; G.dash = DASH_MAX; G.dashHeld = false;
  G.obstacles = []; G.gemsArr = []; G.particles = []; G.scenery = [];
  G.spawnTimer = 0.9; G.gemTimer = 2.2;
  G.hue = 180;
  G.camX = 0; G.camY = CAM3.height; G.camZ = G.dist - CAM3.dist;
  G.lookZ = G.dist + CAM3.lookAhead; G.lookX = 0;
  G.runPhase = 0;
  document.getElementById('start').classList.add('hidden');
  document.getElementById('over').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  updateCamBadge();
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
  G.camShake = Math.max(0, (G.camShake || 0) - dt * 1.6);

  if (G.state === 'menu') {
    G.running = false;
    G.dist += dt * 6;  // 菜单时缓慢自动跑，背景也活
    updateParticles(dt);
    return;
  }
  if (G.state === 'over') {
    G.flash = Math.max(0, G.flash - dt * 1.4);
    G.camShake = Math.max(0, (G.camShake || 0) - dt * 1.2);
    updateParticles(dt);
    return;
  }

  /* --- speed & dash --- */
  let targetSpeed = Math.min(52, 16 + G.dist * 0.012);
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

  G.running = true;
  G.runPhase += dt * (G.speed * 0.9);

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

  /* scenery spawn */
  if (G.scenery.length < 40) spawnScenery();
  G.scenery = G.scenery.filter(s => s.z - G.dist < Z_FAR * 1.3 && s.z - G.dist > -CAM3.dist - 4);

  /* --- advance world objects --- */
  // 障碍与宝石的 z 是绝对世界 z；相机 z = G.dist，所以相对 z = o.z - G.dist
  // 这里不需要手动减 step，因为 G.dist 在增长
  G.obstacles = G.obstacles.filter(o => o.z - G.dist > -8);
  G.gemsArr = G.gemsArr.filter(g => !g.got && g.z - G.dist > -4);

  /* --- gems --- */
  for (const g of G.gemsArr) {
    if (g.z - G.dist < 1.4 && g.z - G.dist > -0.8 && Math.abs(G.playerLaneX - worldX(g.lane)) < SPACING * 0.5 && g.y === 0) {
      g.got = true;
      G.gems++;
      G.combo++;
      G.comboTimer = 2.2;
      G.score += 15 * Math.min(G.combo, 10);
      spawnBurst(G.playerLaneX, 0.6, G.dist, 55);
    }
  }
  if (G.comboTimer > 0) { G.comboTimer -= dt; if (G.comboTimer <= 0) G.combo = 0; }

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
  CAM = camState();
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (G.camShake > 0) ctx.translate(rand(-1, 1) * G.camShake * 20, rand(-1, 1) * G.camShake * 20);

  drawSky();
  drawGround();
  drawGrid();
  drawScenery();
  drawRoad();
  drawObstacles();
  drawGems();
  if (G.camMode === 3 && G.state !== 'over') drawPlayer();
  drawParticles();
  if (G.camMode === 1 && G.state === 'play') drawFirstPersonArms();
  ctx.restore();

  if (G.flash > 0) { ctx.fillStyle = `rgba(255,60,120,${G.flash * 0.4})`; ctx.fillRect(0, 0, W, H); }
  const vg = ctx.createRadialGradient(W/2, H/2, H*0.35, W/2, H/2, H*0.85);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,10,0.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
}

function project(wx, wy, wz) {
  // wz 是绝对世界 z。统一用 CAM.z 作为相机 z。
  const camZ = CAM.z;
  const f = H * (FOV_DEG * 0.011) * CAM.fovMul;
  const relZ = wz - camZ;             // 相对相机的前方距离
  const zc = Math.max(relZ, Z_NEAR);
  const scale = f / zc;
  const horizonY = H * HORIZON;
  const lookShift = (CAM.lookX - CAM.x) * 0.35;
  const x = W / 2 + (wx - CAM.x + lookShift) * scale;
  const y = horizonY + (CAM.y - wy) * scale;
  // 屏幕空间回退：当物体"贴到地平线外"（y 超出 [horizonY, H] 或 x 超出 [0, W]）时，
  // 把它夹回可见的透视梯形内，避免远处网格/道路被画到屏幕外导致黑屏。
  const yTop = horizonY, yBot = H;
  const cy = clamp(y, yTop + 2, yBot - 2);
  // x 也按当前"深度行"的可视宽度夹一下（越远越窄）
  const depthFrac = clamp((cy - yTop) / (yBot - yTop), 0, 1); // 0=地平线,1=底部
  const halfW = (W * 0.5) * (0.06 + 0.94 * depthFrac);
  const cx = clamp(x, W / 2 - halfW, W / 2 + halfW);
  return { x: cx, y: cy, s: scale };
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H * HORIZON);
  // 拉高对比：深蓝夜空 -> 品红地平线
  g.addColorStop(0, '#03030f');
  g.addColorStop(0.55, '#0a0420');
  g.addColorStop(0.85, '#2a0a45');
  g.addColorStop(1, `hsl(${(G.hue + 300) % 360},80%,32%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * HORIZON + 2);

  const cx = W * 0.5, cy = H * HORIZON - 10;
  const sun = ctx.createRadialGradient(cx, cy, 4, cx, cy, H * 0.18);
  sun.addColorStop(0, `hsla(${(G.hue + 120) % 360},100%,78%,.95)`);
  sun.addColorStop(0.5, `hsla(${(G.hue + 90) % 360},90%,58%,.4)`);
  sun.addColorStop(1, 'transparent');
  ctx.fillStyle = sun;
  ctx.beginPath(); ctx.arc(cx, cy, H * 0.18, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,.6)';
  for (let i = 0; i < 70; i++) {
    const sx = ((i * 137.5) % (W + 40)) - 20;
    const sy = (i * 91.7) % (H * HORIZON * 0.95);
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(G.t * 2 + i));
    ctx.globalAlpha = tw * 0.55;
    ctx.fillRect(sx, sy, 1.6, 1.6);
  }
  ctx.globalAlpha = 1;
}

function drawGround() {
  // 地面：高对比深色，与天空拉开层次
  const g = ctx.createLinearGradient(0, H * HORIZON, 0, H);
  g.addColorStop(0, '#0c0418');
  g.addColorStop(1, '#01010a');
  ctx.fillStyle = g;
  ctx.fillRect(0, H * HORIZON, W, H - H * HORIZON);
}

function drawGrid() {
  const step = 4;
  const camWZ = G.dist - 1; // 绝对世界 z 基准（略在玩家身后）
  const startOff = G.state === 'play' ? (G.dist % step) : (G.t * 6) % step;

  ctx.lineWidth = 1;
  // 纵向线（绝对世界 z：从相机附近一路铺到远处）
  for (let x = -8; x <= 8; x++) {
    const a = project(x * step * 0.55, 0, camWZ);
    const b = project(x * step * 0.55, 0, camWZ + Z_FAR);
    ctx.strokeStyle = `hsla(${(G.hue + 180) % 360},80%,60%,${0.05 + (Math.abs(x) < 2 ? 0.12 : 0)})`;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // 横向线（绝对世界 z，随 dist 滚动）
  for (let i = 0; i < 44; i++) {
    const z = camWZ + ((i * step + step - startOff) % (Z_FAR - Z_NEAR));
    const p = project(0, 0, z);
    if (p.s < 1.2) continue;
    const alpha = clamp((p.s - 1) / 60, 0, 1) * 0.55;
    ctx.strokeStyle = `hsla(${G.hue % 360},90%,65%,${alpha})`;
    const l = project(-TUBE_R * 3, 0, z), r = project(TUBE_R * 3, 0, z);
    ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
  }
  // 车道虚线
  ctx.setLineDash([10, 14]);
  for (const lx of [-SPACING/2, SPACING/2]) {
    const a = project(lx, 0.02, camWZ), b = project(lx, 0.02, camWZ + Z_FAR * 0.8);
    ctx.strokeStyle = `hsla(${G.hue % 360},80%,70%,.55)`;
    ctx.lineWidth = 2;
    ctx.lineDashOffset = -G.dist * 4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.lineDashOffset = 0;
}

/* 道路：具象化地面 */
function drawRoad() {
  const camWZ = G.dist - 1;
  // 路面（比网格更亮的"沥青+霓虹"质感）
  const fl = project(-SPACING * 1.7, 0, camWZ), fr = project(SPACING * 1.7, 0, camWZ);
  const bl = project(-SPACING * 1.7, 0, camWZ + Z_FAR), br = project(SPACING * 1.7, 0, camWZ + Z_FAR);
  const rg = ctx.createLinearGradient(0, bl.y, 0, fl.y);
  rg.addColorStop(0, `hsla(${(G.hue + 180) % 360},40%,14%,.9)`);
  rg.addColorStop(0.7, `hsla(${(G.hue + 180) % 360},55%,10%,.95)`);
  rg.addColorStop(1, `hsla(${(G.hue + 180) % 360},70%,16%,.9)`);
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y); ctx.lineTo(fr.x, fr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
  ctx.closePath(); ctx.fill();

  // 路边发光路缘
  for (const edge of [-1, 1]) {
    const a = project(edge * SPACING * 1.7, 0.02, camWZ);
    const b = project(edge * SPACING * 1.7, 0.02, camWZ + Z_FAR * 0.9);
    ctx.strokeStyle = `hsla(${(G.hue + 20) % 360},100%,60%,.9)`;
    ctx.lineWidth = Math.max(2, a.s * 0.4);
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = a.s * 1.5;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

/* 道路两侧具象化物件 */
function drawScenery() {
  // 按深度排序
  const items = G.scenery.slice().sort((a, b) => b.z - a.z);
  for (const s of items) {
    const rel = s.z - G.dist;
    if (rel < -CAM3.dist - 3 || rel > Z_FAR * 1.3) continue;
    const p = project(s.x, 0, s.z);
    if (p.s < 0.8) continue;
    drawSceneryItem(s, p);
  }
}

function drawSceneryItem(s, p) {
  const sz = p.s;
  const x = p.x, gy = p.y;
  const col = `hsl(${(G.hue + s.seed * 7) % 360},90%,58%)`;

  switch (s.type) {
    case 'tower': {
      // 霓虹塔楼：长方体 + 窗户 + 顶部天线
      const w = sz * 1.6, h = sz * s.h;
      ctx.fillStyle = `hsla(${(G.hue + s.seed * 7) % 360},35%,12%,.95)`;
      ctx.fillRect(x - w/2, gy - h, w, h);
      // 窗户
      ctx.fillStyle = `hsla(${(G.hue + s.seed * 7) % 360},90%,60%,.8)`;
      const rows = Math.max(3, Math.floor(s.h));
      for (let r = 0; r < rows; r++) {
        const wy = gy - h + (h * (r + 0.5)) / rows;
        for (let c = 0; c < 3; c++) {
          const wx = x - w/2 + (w * (c + 0.5)) / 3;
          if ((s.seed + r * 7 + c * 3) % 5 < 3) ctx.fillRect(wx - sz*0.12, wy - sz*0.12, sz*0.24, sz*0.24);
        }
      }
      // 顶部霓虹边
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, sz * 0.2);
      ctx.shadowColor = col; ctx.shadowBlur = sz * 2;
      ctx.strokeRect(x - w/2, gy - h, w, h * 0.08);
      ctx.shadowBlur = 0;
      break;
    }
    case 'arch': {
      // 拱门：两座立柱 + 横梁
      const w = sz * 4, h = sz * s.h;
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, sz * 0.4);
      ctx.shadowColor = col; ctx.shadowBlur = sz * 2.5;
      ctx.beginPath();
      ctx.moveTo(x - w/2, gy); ctx.lineTo(x - w/2, gy - h);
      ctx.lineTo(x + w/2, gy - h); ctx.lineTo(x + w/2, gy);
      ctx.stroke();
      // 横梁发光
      ctx.lineWidth = Math.max(2, sz * 0.25);
      ctx.strokeStyle = `hsla(${(G.hue + 180 + s.seed * 7) % 360},100%,70%,.9)`;
      ctx.beginPath(); ctx.moveTo(x - w/2, gy - h * 0.85); ctx.lineTo(x + w/2, gy - h * 0.85); ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    }
    case 'pylon': {
      // 能量柱：锥体 + 顶部光球
      const w = sz * 0.8, h = sz * s.h;
      const pg = ctx.createLinearGradient(x, gy - h, x, gy);
      pg.addColorStop(0, `hsla(${(G.hue + s.seed * 7) % 360},100%,65%,.3)`);
      pg.addColorStop(1, `hsla(${(G.hue + s.seed * 7) % 360},100%,55%,.9)`);
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.moveTo(x - w/2, gy); ctx.lineTo(x + w/2, gy); ctx.lineTo(x, gy - h);
      ctx.closePath(); ctx.fill();
      // 顶部光球
      const bx = x, by = gy - h;
      const ball = ctx.createRadialGradient(bx, by, 1, bx, by, sz * 0.7);
      ball.addColorStop(0, `hsla(${(G.hue + s.seed * 7) % 360},100%,85%,1)`);
      ball.addColorStop(1, 'transparent');
      ctx.fillStyle = ball;
      ctx.beginPath(); ctx.arc(bx, by, sz * 0.7, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'billboard': {
      // 全息广告屏：立柱 + 发光面板
      const w = sz * 2.4, h = sz * s.h * 0.6;
      const py = gy - sz * s.h;
      // 立柱
      ctx.fillStyle = `hsla(${(G.hue + s.seed * 7) % 360},30%,20%,.9)`;
      ctx.fillRect(x - sz*0.15, gy - sz * s.h, sz*0.3, sz * s.h);
      // 面板
      const pg = ctx.createLinearGradient(x - w/2, py, x + w/2, py + h);
      pg.addColorStop(0, `hsla(${(G.hue + s.seed * 7) % 360},95%,55%,.9)`);
      pg.addColorStop(1, `hsla(${(G.hue + 180 + s.seed * 7) % 360},95%,50%,.9)`);
      ctx.fillStyle = pg;
      ctx.fillRect(x - w/2, py, w, h);
      // 面板边框
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = Math.max(1, sz * 0.12);
      ctx.strokeRect(x - w/2, py, w, h);
      // 面板闪烁内容
      ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.3 * Math.sin(G.t * 3 + s.phase)})`;
      ctx.fillRect(x - w/2 + sz*0.2, py + h*0.3, w * 0.5, h * 0.4);
      break;
    }
    case 'streetlight': {
      // 路灯：L 形杆 + 灯头 + 光晕
      const h = sz * s.h * 0.9;
      const top = gy - h;
      ctx.strokeStyle = `hsla(${(G.hue + s.seed * 7) % 360},40%,30%,.95)`;
      ctx.lineWidth = Math.max(1.5, sz * 0.22);
      // 立杆
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x, top); ctx.stroke();
      // 横臂（朝向道路）
      const armDir = s.side === -1 ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + armDir * sz * 0.9, top); ctx.stroke();
      // 灯头
      const lx = x + armDir * sz * 0.9;
      ctx.fillStyle = `hsla(${(G.hue + s.seed * 7) % 360},100%,80%,.95)`;
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = sz * 1.5;
      ctx.beginPath(); ctx.arc(lx, top, sz * 0.28, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // 光晕落地
      const glow = ctx.createRadialGradient(lx, top, 1, lx, top, sz * 2);
      glow.addColorStop(0, `hsla(${(G.hue + s.seed * 7) % 360},100%,75%,.35)`);
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(lx, top, sz * 2, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
}

function drawObstacles() {
  const items = G.obstacles.slice().sort((a, b) => b.z - a.z);
  for (const o of items) {
    const rel = o.z - G.dist;
    if (rel < -CAM3.dist - 3 || rel > Z_FAR * 1.3) continue;
    drawObstacle(o);
  }
}

function drawObstacle(o) {
  const p = project(0, 0, o.z);
  if (p.s < 1.5) return;
  const glow = `hsl(${(G.hue + 300) % 360},100%,60%)`;

  if (o.type === 'low') {
    // 具象化：路障 + 反光条 + 警示灯
    const cx = project(worldX(o.lane), 0, o.z);
    const w = cx.s * SPACING * 0.72, hgt = cx.s * 1.0;
    // 底座
    ctx.fillStyle = `hsla(${(G.hue + 300) % 360},80%,20%,.95)`;
    ctx.fillRect(cx.x - w/2, cx.y - hgt * 0.15, w, hgt * 0.15);
    // 栏体
    ctx.strokeStyle = glow; ctx.lineWidth = Math.max(2, cx.s * 0.18);
    ctx.shadowColor = glow; ctx.shadowBlur = cx.s * 1.8;
    ctx.strokeRect(cx.x - w/2, cx.y - hgt, w, hgt * 0.85);
    ctx.shadowBlur = 0;
    // 警示斜纹
    ctx.save();
    ctx.beginPath(); ctx.rect(cx.x - w/2, cx.y - hgt, w, hgt * 0.85); ctx.clip();
    ctx.strokeStyle = `hsla(50,100%,60%,.7)`;
    ctx.lineWidth = Math.max(1.5, cx.s * 0.14);
    for (let i = -2; i < 5; i++) {
      const xx = cx.x - w/2 + i * w * 0.3;
      ctx.beginPath(); ctx.moveTo(xx, cx.y); ctx.lineTo(xx + w*0.5, cx.y - hgt); ctx.stroke();
    }
    ctx.restore();
    // 警示灯（闪烁）
    const blink = Math.sin(G.t * 8 + o.phase) > 0;
    if (blink) {
      ctx.fillStyle = `hsla(0,100%,60%,.95)`;
      ctx.shadowColor = 'rgba(255,0,60,.9)'; ctx.shadowBlur = cx.s * 1.5;
      ctx.beginPath(); ctx.arc(cx.x - w/2, cx.y - hgt - cx.s*0.15, cx.s * 0.14, 0, Math.PI*2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  } else if (o.type === 'high') {
    // 具象化：悬挂路标 + 反光
    const yTop = 1.4;
    const cx = project(worldX(o.lane), yTop, o.z);
    const w = cx.s * SPACING * 0.86, hgt = cx.s * 0.6;
    // 吊索
    ctx.strokeStyle = `hsla(${(G.hue + 40) % 360},60%,40%,.8)`;
    ctx.lineWidth = Math.max(1, cx.s * 0.08);
    for (const fx of [-0.35, 0, 0.35]) {
      const fxp = project(worldX(o.lane) + fx * SPACING, 3.2, o.z);
      ctx.beginPath(); ctx.moveTo(fxp.x, fxp.y); ctx.lineTo(cx.x + fx * w, cx.y - hgt); ctx.stroke();
    }
    // 标志体
    const hg = ctx.createLinearGradient(cx.x, cx.y - hgt, cx.x, cx.y);
    hg.addColorStop(0, `hsla(${(G.hue + 40) % 360},90%,60%,.95)`);
    hg.addColorStop(1, `hsla(${(G.hue + 60) % 360},90%,45%,.95)`);
    ctx.fillStyle = hg;
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = cx.s * 1.6;
    ctx.fillRect(cx.x - w/2, cx.y - hgt, w, hgt);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = Math.max(1, cx.s * 0.1);
    ctx.strokeRect(cx.x - w/2, cx.y - hgt, w, hgt);
    // 向下箭头（提示别跳）
    ctx.fillStyle = `hsla(0,0%,100%,.9)`;
    ctx.beginPath();
    ctx.moveTo(cx.x - w*0.15, cx.y - hgt*0.55);
    ctx.lineTo(cx.x + w*0.15, cx.y - hgt*0.55);
    ctx.lineTo(cx.x, cx.y - hgt*0.2);
    ctx.closePath(); ctx.fill();
  } else {
    // wall / gate：具象化能量屏障
    for (const ln of o.lanes) {
      const cx = project(worldX(ln), 0, o.z);
      const w = cx.s * SPACING * 0.8, hgt = cx.s * 2.6;
      // 基座
      ctx.fillStyle = `hsla(${(G.hue + 280) % 360},40%,15%,.9)`;
      ctx.fillRect(cx.x - w/2, cx.y - hgt*0.08, w, hgt*0.08);
      // 屏障（半透明能量体）
      const eg = ctx.createLinearGradient(cx.x, cx.y - hgt, cx.x, cx.y);
      eg.addColorStop(0, `hsla(${(G.hue + 320) % 360},100%,70%,.85)`);
      eg.addColorStop(0.5, `hsla(${(G.hue + 280) % 360},100%,55%,.5)`);
      eg.addColorStop(1, `hsla(${(G.hue + 320) % 360},100%,60%,.85)`);
      ctx.fillStyle = eg;
      ctx.shadowColor = `hsla(${(G.hue + 320) % 360},100%,60%,.9)`;
      ctx.shadowBlur = cx.s * 2.2;
      ctx.fillRect(cx.x - w/2, cx.y - hgt, w, hgt);
      ctx.shadowBlur = 0;
      // 边框
      ctx.strokeStyle = `hsla(${(G.hue + 340) % 360},100%,80%,.9)`;
      ctx.lineWidth = Math.max(1.5, cx.s * 0.14);
      ctx.strokeRect(cx.x - w/2, cx.y - hgt, w, hgt);
      // 能量波纹
      ctx.strokeStyle = `hsla(${(G.hue + 340) % 360},100%,85%,.4)`;
      ctx.lineWidth = Math.max(1, cx.s * 0.08);
      for (let i = 1; i < 4; i++) {
        const yy = cx.y - hgt + (hgt * i) / 4;
        ctx.beginPath(); ctx.moveTo(cx.x - w/2 + 3, yy); ctx.lineTo(cx.x + w/2 - 3, yy); ctx.stroke();
      }
      // 警告标记
      ctx.fillStyle = `hsla(50,100%,60%,.9)`;
      ctx.beginPath();
      ctx.moveTo(cx.x, cx.y - hgt*0.85);
      ctx.lineTo(cx.x - w*0.18, cx.y - hgt*0.55);
      ctx.lineTo(cx.x + w*0.18, cx.y - hgt*0.55);
      ctx.closePath(); ctx.fill();
    }
  }
}

function drawGems() {
  const items = G.gemsArr.filter(g => !g.got).sort((a, b) => b.z - a.z);
  for (const g of items) {
    const rel = g.z - G.dist;
    if (rel < -CAM3.dist - 2 || rel > Z_FAR * 1.3) continue;
    const p = project(worldX(g.lane), g.y + 0.55 + Math.sin(g.phase) * 0.18, g.z);
    if (p.s < 1.5) continue;
    const s = p.s * 0.42;
    const cx = p.x, cy = p.y - s + Math.sin(g.phase) * p.s * 0.1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4 + Math.sin(G.t * 2 + g.phase) * 0.15);
    const grad = ctx.createLinearGradient(-s, -s, s, s);
    grad.addColorStop(0, '#ffe45e'); grad.addColorStop(1, '#ff8a3d');
    ctx.fillStyle = grad;
    ctx.shadowColor = '#ffcf4d'; ctx.shadowBlur = s * 2.4;
    ctx.fillRect(-s/2, -s/2, s, s);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.strokeRect(-s/2, -s/2, s, s);
    ctx.restore();
  }
}

function drawPlayer() {
  // 第三人称下才画玩家本体
  const px = G.playerLaneX, py = G.y;
  const p = project(px, py, G.dist);
  const s = p.s;
  const bx = p.x, by = p.y;

  const gs = project(px, 0, G.dist);
  const shScale = clamp(1 - py * 0.12, 0.25, 1);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.beginPath();
  ctx.ellipse(gs.x, gs.y, s * 0.55 * shScale, s * 0.18 * shScale, 0, 0, Math.PI * 2);
  ctx.fill();

  if (G.invuln > 0 && Math.floor(G.t * 16) % 2 === 0) ctx.globalAlpha = 0.4;

  const bodyH = s * 1.7, bodyW = s * 0.95;
  const tilt = clamp((worldX(G.playerLane) - px) * 0.6, -0.5, 0.5);
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(tilt * 0.25);

  const dashGlow = G.dashHeld && G.dash > 0.02;
  const col = dashGlow ? `hsl(${(G.hue + 300) % 360},100%,65%)` : `hsl(${G.hue % 360},100%,65%)`;
  ctx.shadowColor = col; ctx.shadowBlur = s * 1.8;
  const grad = ctx.createLinearGradient(0, -bodyH, 0, 0);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, col);
  ctx.fillStyle = grad;
  roundRectPath(ctx, -bodyW/2, -bodyH, bodyW, bodyH, bodyW * 0.45);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = Math.max(1.5, s * 0.1);
  roundRectPath(ctx, -bodyW/2, -bodyH, bodyW, bodyH, bodyW * 0.45);
  ctx.stroke();

  ctx.fillStyle = 'rgba(10,20,40,.85)';
  roundRectPath(ctx, -bodyW*0.28, -bodyH*0.78, bodyW*0.56, bodyH*0.2, bodyW*0.2);
  ctx.fill();

  // 腿
  const ph = G.runPhase;
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
  // 臂
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

/* 第一人称：胸前视角的摆臂 */
function drawFirstPersonArms() {
  // 左右两条手臂从画面下方伸出来，随 runPhase 前后摆动
  const bob = Math.sin(G.runPhase * 2) * CAM1.bobAmp;
  const sW = W * 0.5;

  for (const side of [-1, 1]) {
    const swing = Math.sin(G.runPhase + (side === 1 ? Math.PI : 0)) * CAM1.swingAmp;
    // 手臂根在画面下角，手随 swing 在"前-后"（用 y 偏移 + 缩放模拟前后）
    const shoulderX = sW + side * sW * 0.42;
    const shoulderY = H * 0.92;
    // 前摆时手抬高放大（靠近脸），后摆时手降低缩小
    const handDist = 0.35 + (swing * 0.5 + 0.5) * 0.4; // 0.35~0.75
    const handX = shoulderX + side * sW * 0.18 * (1 - handDist);
    const handY = H * 0.55 + swing * H * 0.12 + bob * H;
    const handR = sW * 0.10 * handDist;

    // 上臂
    ctx.strokeStyle = `hsla(${G.hue % 360},90%,55%,.9)`;
    ctx.lineWidth = sW * 0.09;
    ctx.lineCap = 'round';
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = sW * 0.05;
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.lineTo(handX, handY + handR);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 前臂（浅色，袖口）
    ctx.strokeStyle = `hsla(${(G.hue + 40) % 360},95%,70%,.9)`;
    ctx.lineWidth = sW * 0.07;
    ctx.beginPath();
    ctx.moveTo((shoulderX + handX) / 2 + side * sW * 0.03, (shoulderY + handY) / 2 + handR);
    ctx.lineTo(handX, handY);
    ctx.stroke();
    // 拳头
    ctx.fillStyle = `hsla(${(G.hue + 40) % 360},95%,80%,.95)`;
    ctx.beginPath(); ctx.arc(handX, handY, handR, 0, Math.PI * 2); ctx.fill();
  }

  // 胸前 HUD 条（第一人称特有，增加沉浸）
  ctx.strokeStyle = `hsla(${G.hue % 360},80%,70%,.5)`;
  ctx.lineWidth = 2;
  const cx = sW, cy = H * 0.86;
  ctx.beginPath();
  ctx.moveTo(cx - sW*0.25, cy); ctx.lineTo(cx - sW*0.08, cy - sW*0.05);
  ctx.lineTo(cx + sW*0.08, cy - sW*0.05); ctx.lineTo(cx + sW*0.25, cy);
  ctx.stroke();
  // 准心
  ctx.fillStyle = `hsla(${G.hue % 360},100%,80%,.9)`;
  ctx.beginPath(); ctx.arc(cx, cy - sW*0.05, 3, 0, Math.PI*2); ctx.fill();
}

function drawParticles() {
  for (const p of G.particles) {
    const rel = p.z - G.dist;
    if (rel < -2) continue;
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
    } else {
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

document.getElementById('best').textContent = G.best;
document.getElementById('best2').textContent = G.best;
updateCamBadge();
