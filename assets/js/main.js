/**
 * 首页 3D 拆解。
 *
 * 数据流：CAD(MJCF) → microduck.glb（节点层级 = 身体层级）+ microduck-model.json
 *        → 每个 mesh 按 parts.js 的规则归到部件 → 射线拾取 → 高亮 + 说明卡。
 *
 * 这里刻意不引入任何 UI 框架：一个模块、一个渲染循环，出问题只可能在一个地方。
 */

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
import { PARTS, PART_BY_ID, partForNode } from './parts.js';

const MODEL_URL = './assets/models/microduck.glb';
const MANIFEST_URL = './assets/models/microduck-model.json';

const ACCENT = new THREE.Color('#ff8a3d');
const DIM = new THREE.Color('#2a2f3a');

/**
 * 真机的 home 姿态，单位弧度。
 *
 * 来自 microduck/duck-control/src/model.rs 的 DEFAULT_POSITION —— 真机上电后先
 * 斜坡到这个姿态，策略观察的关节位置也是相对它归一化的。用它做默认站姿，
 * 网页里的鸭子和真机、和训练环境里的鸭子才是同一个姿势。
 *
 * mouth 不在任何策略动作里（14 维动作跳过它），所以这里不列。
 */
const HOME_POSE = {
  left_hip_yaw: 0.0,
  left_hip_roll: -0.0873,
  left_hip_pitch: -0.4579,
  left_knee: -0.0049,
  left_ankle: 0.453,
  neck_pitch: 0.3491,
  head_pitch: 0.3491,
  head_yaw: 0.0,
  head_roll: 0.0,
  right_hip_yaw: 0.0,
  right_hip_roll: 0.0873,
  right_hip_pitch: 0.4579,
  right_knee: 0.0049,
  right_ankle: -0.453,
};

const el = {
  stage: document.getElementById('stage'),
  canvas: document.getElementById('duck-canvas'),
  state: document.getElementById('stage-state'),
  stateText: document.getElementById('stage-state-text'),
  hudPart: document.getElementById('hud-part'),
  card: document.getElementById('part-card'),
  cardLabel: document.getElementById('card-label'),
  cardRole: document.getElementById('card-role'),
  cardTags: document.getElementById('card-tags'),
  cardList: document.getElementById('card-list'),
  hint: document.getElementById('part-hint'),
  chips: document.getElementById('chips'),
  grid: document.getElementById('part-grid'),
  btnReset: document.getElementById('btn-reset'),
  btnSpin: document.getElementById('btn-spin'),
  btnIdle: document.getElementById('btn-idle'),
  btnClear: document.getElementById('btn-clear'),
};

const state = {
  selected: null,
  hovered: null,
  spin: true,
  idle: true,
  userMovedAt: 0,
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

const meshesByPart = new Map(); // partId -> Mesh[]
const hotspotByPart = new Map(); // partId -> Object3D
let modelRoot = null;
let controls = null;
let camera = null;
let renderer = null;
let scene = null;
let raycaster = null;
const pointer = new THREE.Vector2();
let pointerDown = null;
let needsPick = false;

/* ------------------------------------------------------------------ UI */

function buildUI() {
  const fragChips = document.createDocumentFragment();
  const fragTiles = document.createDocumentFragment();

  for (const part of PARTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.part = part.id;
    chip.setAttribute('aria-pressed', 'false');
    chip.innerHTML = `<i aria-hidden="true"></i>${part.label}`;
    chip.addEventListener('click', () => {
      select(part.id, { fromUI: true });
      // 芯片在首屏下方，点完把 3D 舞台滚回视野，否则看不到高亮。
      el.stage.scrollIntoView({
        behavior: state.reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    });
    fragChips.append(chip);

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'part-tile';
    tile.dataset.part = part.id;
    const first = part.bullets[0];
    tile.innerHTML = `
      <div class="part-tile__top">
        <h3>${part.label}</h3>
        <span class="part-tile__role">${part.role}</span>
      </div>
      <p>${first.d}</p>
      <div class="tags">${part.tags.map((t) => `<span>${t}</span>`).join('')}</div>
      <span class="part-tile__go">在 3D 里查看 ↑</span>`;
    tile.addEventListener('click', () => {
      select(part.id, { fromUI: true });
      el.stage.scrollIntoView({
        behavior: state.reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    });
    fragTiles.append(tile);
  }

  el.chips.append(fragChips);
  el.grid.append(fragTiles);
}

function showCard(part) {
  el.cardLabel.textContent = part.label;
  el.cardRole.textContent = part.role;
  el.cardTags.innerHTML = part.tags.map((t) => `<span class="tag">${t}</span>`).join('');
  el.cardList.innerHTML = part.bullets
    .map((b) => `<li><b>${b.t}</b><p>${b.d}</p></li>`)
    .join('');
  el.card.hidden = false;
  el.hint.hidden = true;
}

function hideCard() {
  el.card.hidden = true;
  el.hint.hidden = false;
}

function syncPressed(partId) {
  for (const node of el.chips.querySelectorAll('.chip')) {
    node.setAttribute('aria-pressed', String(node.dataset.part === partId));
  }
}

/* --------------------------------------------------------------- three */

function makeEnvironment(renderer) {
  // 一张程序化生成的等距柱状环境图：上冷下暗 + 右上一点暖光，
  // 金属件（轴承、舵机）没有环境反射会发黑，这里用最小代价给一点。
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#243049');
  sky.addColorStop(0.45, '#12161f');
  sky.addColorStop(1, '#050609');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 512, 256);

  const warm = ctx.createRadialGradient(380, 40, 0, 380, 40, 150);
  warm.addColorStop(0, 'rgba(255, 176, 120, 0.85)');
  warm.addColorStop(1, 'rgba(255, 176, 120, 0)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, 512, 256);

  const cool = ctx.createRadialGradient(120, 90, 0, 120, 90, 170);
  cool.addColorStop(0, 'rgba(110, 168, 255, 0.5)');
  cool.addColorStop(1, 'rgba(110, 168, 255, 0)');
  ctx.fillStyle = cool;
  ctx.fillRect(0, 0, 512, 256);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

function addGround(scene) {
  // 落地光晕：让模型不像悬空，也不用开阴影贴图。
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255, 138, 61, 0.30)');
  g.addColorStop(0.35, 'rgba(255, 138, 61, 0.10)');
  g.addColorStop(0.7, 'rgba(90, 120, 200, 0.05)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.62),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0.002;
  plane.renderOrder = -1;
  scene.add(plane);

  // 一圈很淡的基准环，给一个尺度参照。
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.245, 0.248, 128),
    new THREE.MeshBasicMaterial({
      color: 0x5f6b82,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.0015;
  scene.add(ring);

  const ring2 = new THREE.Mesh(
    new THREE.RingGeometry(0.30, 0.3008, 128),
    new THREE.MeshBasicMaterial({
      color: 0x3a4456,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.y = 0.0015;
  scene.add(ring2);
}

function makeHotspot(part) {
  const group = new THREE.Group();
  // 热点是标注而不是实体：不参与深度测试，藏在壳里的 IMU 才看得见。
  // 关掉深度测试后必须自己排到所有 CAD 之后，否则会被模型盖住。
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.0045, 16, 12),
    new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, depthWrite: false }),
  );
  dot.renderOrder = 20;
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.009, 0.011, 24),
    new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    }),
  );
  halo.renderOrder = 20;
  group.add(dot, halo);
  group.userData.partId = part.id;
  group.userData.isHotspot = true;
  group.userData.halo = halo;
  dot.userData.partId = part.id;
  dot.userData.isHotspot = true;
  halo.userData.partId = part.id;
  halo.userData.isHotspot = true;
  return group;
}

function makeLabelSprite(text) {
  const pad = 12;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 34px ui-monospace, Menlo, Consolas, monospace';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = w;
  canvas.height = 56;
  const c2 = canvas.getContext('2d');
  c2.font = font;
  c2.fillStyle = 'rgba(8,9,13,0.78)';
  c2.roundRect?.(0, 0, w, 56, 14);
  if (!c2.roundRect) c2.rect(0, 0, w, 56);
  c2.fill();
  c2.strokeStyle = 'rgba(255,138,61,0.55)';
  c2.lineWidth = 2;
  c2.stroke();
  c2.fillStyle = '#ffb27a';
  c2.textBaseline = 'middle';
  c2.fillText(text, pad, 29);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 和圆点一样关掉深度测试：标签挂在壳体表面，不关就会陷进躯干里看不见。
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
  );
  sprite.renderOrder = 21;
  const scale = 0.00042;
  sprite.scale.set(w * scale, 56 * scale, 1);
  return sprite;
}

/* ------------------------------------------------------------ selection */

function eachMesh(fn) {
  modelRoot.traverse((obj) => {
    if (obj.isMesh && obj.userData.partId && !obj.userData.isHotspot) fn(obj);
  });
}

function applySelection() {
  const sel = state.selected;
  // IMU / ToF / 相机没有自己的网格（它们藏在壳里，只有 MuJoCo site），
  // 选中时把宿主身体一起点亮，否则整只鸭子变暗、只有一个圆点在亮。
  const selPart = sel ? PART_BY_ID.get(sel) : null;
  const highlight = new Set([sel, selPart?.highlightWith].filter(Boolean));

  eachMesh((mesh) => {
    const mat = mesh.material;
    const base = mesh.userData.baseColor;
    if (!sel) {
      mat.color.copy(base);
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
    } else if (highlight.has(mesh.userData.partId)) {
      mat.color.copy(base);
      mat.emissive.copy(ACCENT);
      // 宿主身体比真正的选中部件暗一档，看得出谁是主体。
      mat.emissiveIntensity = mesh.userData.partId === sel ? 0.28 : 0.14;
    } else {
      mat.color.copy(base).lerp(DIM, 0.72);
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
    }
  });

  for (const hotspot of hotspotByPart.values()) hotspot.visible = true;
}

function select(partId, { fromUI = false } = {}) {
  const part = PART_BY_ID.get(partId);
  if (!part) return;

  if (state.selected === partId) {
    if (fromUI) {
      el.card.hidden = false;
      focusPart(partId);
    }
    return;
  }

  state.selected = partId;
  applySelection();
  showCard(part);
  syncPressed(partId);
  el.hudPart.textContent = part.label;

  if (fromUI && modelRoot) {
    // 从列表点进来时，把镜头缓动到该部件附近
    focusPart(partId);
  }
}

function clearSelection() {
  state.selected = null;
  applySelection();
  hideCard();
  syncPressed(null);
  el.hudPart.textContent = '点击部件';
}

const DEFAULT_VIEW = {
  position: new THREE.Vector3(0.40, 0.30, 0.50),
  target: new THREE.Vector3(0, 0.135, 0),
};

function focusPart(partId) {
  const meshes = meshesByPart.get(partId) ?? [];
  if (!meshes.length || !controls) return;

  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.025);

  // 按视场角算距离，而不是“尺寸 × 系数”。竖直和水平视场取更紧的那个，
  // 再留 1.7 倍余量：目标是看清部件，同时保留它和相邻结构的空间关系。
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fitFov = Math.min(vFov, hFov);
  const fullDist = DEFAULT_VIEW.position.distanceTo(DEFAULT_VIEW.target);

  // 大部件（躯干、头、腿）不拉近：整只鸭子留在画面里，比顶到镜头前更好认。
  // 小部件（喙、颈、脚）才真正推近，下限 0.42 是为了别把相邻结构全裁掉。
  const fitted = (radius / Math.sin(fitFov / 2)) * 1.6;
  const large = radius >= 0.055;
  const dist = large ? fullDist : THREE.MathUtils.clamp(fitted, 0.42, fullDist);

  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  const target = large ? DEFAULT_VIEW.target.clone() : sphere.center.clone();
  const to = target.clone().addScaledVector(dir, dist);

  animateCamera(to, target);
}

let camAnim = null;
function animateCamera(toPos, toTarget) {
  camAnim = {
    fromPos: camera.position.clone(),
    toPos,
    fromTarget: controls.target.clone(),
    toTarget,
    t: 0,
    dur: state.reducedMotion ? 1 : 0.55,
  };
}

/* -------------------------------------------------------------- picking */

function updatePointer(event) {
  const rect = el.canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pick() {
  if (!modelRoot) return null;
  raycaster.setFromCamera(pointer, camera);
  // 热点也要能被拾取：鼠标移到 IMU/ToF/相机的小圆点上时能直接选中它。
  const targets = [modelRoot, ...hotspotByPart.values()];
  const hits = raycaster.intersectObjects(targets, true);
  for (const hit of hits) {
    let obj = hit.object;
    while (obj && !obj.userData.partId) obj = obj.parent;
    if (obj?.userData.partId) return obj.userData.partId;
  }
  return null;
}

function onPointerDown(event) {
  pointerDown = { x: event.clientX, y: event.clientY, t: performance.now() };
  state.userMovedAt = performance.now();
  if (controls) controls.autoRotate = false;
}

function onPointerUp(event) {
  if (!pointerDown) return;
  const dx = event.clientX - pointerDown.x;
  const dy = event.clientY - pointerDown.y;
  const dt = performance.now() - pointerDown.t;
  pointerDown = null;
  if (Math.hypot(dx, dy) > 6 || dt > 700) return; // 是在拖动，不是点击

  updatePointer(event);
  const partId = pick();
  if (partId) select(partId);
  else clearSelection();
}

function onPointerMove(event) {
  updatePointer(event);
  needsPick = true;
}

/* ------------------------------------------------------------------ init */

function fail(message) {
  el.state.classList.add('is-error');
  el.state.hidden = false;
  el.stateText.textContent = message;
}

async function init() {
  buildUI();

  if (state.reducedMotion) {
    state.spin = false;
    state.idle = false;
    el.btnSpin.setAttribute('aria-pressed', 'false');
    el.btnIdle.setAttribute('aria-pressed', 'false');
  }

  let gl;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: el.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    gl = renderer.getContext();
  } catch (err) {
    fail('这个浏览器没有可用的 WebGL2/WebGL 上下文，3D 拆解无法运行。');
    return;
  }
  if (!gl) {
    fail('这个浏览器没有可用的 WebGL 上下文，3D 拆解无法运行。');
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(el.stage.clientWidth, el.stage.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#080a0e');
  scene.environment = makeEnvironment(renderer);

  camera = new THREE.PerspectiveCamera(32, el.stage.clientWidth / el.stage.clientHeight, 0.01, 6);
  camera.position.copy(DEFAULT_VIEW.position);

  controls = new OrbitControls(camera, el.canvas);
  controls.target.copy(DEFAULT_VIEW.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 0.22;
  controls.maxDistance = 1.1;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI / 2 + 0.16;
  controls.enablePan = false;
  controls.autoRotate = state.spin;
  controls.autoRotateSpeed = 0.75;
  controls.update();
  controls.addEventListener('start', () => {
    state.userMovedAt = performance.now();
    controls.autoRotate = false;
  });

  // 主光：暖色，从右前上方压下来；补光冷色；背后一盏轮廓光。
  const key = new THREE.DirectionalLight(0xffc9a0, 2.4);
  key.position.set(0.6, 0.9, 0.5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x8fb6ff, 1.0);
  fill.position.set(-0.7, 0.35, 0.35);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 1.5);
  rim.position.set(-0.2, 0.5, -0.9);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0x33405c, 0x05060a, 0.55));

  addGround(scene);

  raycaster = new THREE.Raycaster();

  el.canvas.addEventListener('pointerdown', onPointerDown);
  el.canvas.addEventListener('pointerup', onPointerUp);
  el.canvas.addEventListener('pointermove', onPointerMove);
  el.canvas.addEventListener('pointerleave', () => {
    needsPick = false;
    el.canvas.classList.remove('is-hover');
  });

  el.btnReset.addEventListener('click', () => {
    animateCamera(DEFAULT_VIEW.position.clone(), DEFAULT_VIEW.target.clone());
    clearSelection();
  });
  el.btnSpin.addEventListener('click', () => {
    state.spin = !state.spin;
    controls.autoRotate = state.spin;
    el.btnSpin.setAttribute('aria-pressed', String(state.spin));
  });
  el.btnIdle.addEventListener('click', () => {
    state.idle = !state.idle;
    el.btnIdle.setAttribute('aria-pressed', String(state.idle));
    if (!state.idle) {
      // 关掉微动时回到 home，避免头停在正弦波的半路上。
      setJoint('head_yaw', HOME_POSE.head_yaw);
      setJoint('neck_pitch', HOME_POSE.neck_pitch);
      setJoint('head_pitch', HOME_POSE.head_pitch);
      setJoint('head_roll', HOME_POSE.head_roll);
    }
  });
  el.btnClear.addEventListener('click', clearSelection);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSelection();
  });
  document.querySelectorAll('[data-scroll-to]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(btn.dataset.scrollTo);
      target?.scrollIntoView({ behavior: state.reducedMotion ? 'auto' : 'smooth', block: 'start' });
    });
  });

  const ro = new ResizeObserver(() => {
    const w = el.stage.clientWidth;
    const h = el.stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(el.stage);

  try {
    const [gltf, manifest] = await Promise.all([
      new GLTFLoader().loadAsync(MODEL_URL),
      fetch(MANIFEST_URL).then((r) => {
        if (!r.ok) throw new Error(`manifest ${r.status}`);
        return r.json();
      }),
    ]);
    setupModel(gltf, manifest);
    el.state.hidden = true;
  } catch (err) {
    console.error(err);
    fail(`模型加载失败：${err.message}。请确认 assets/models/ 下的文件存在，并用本地服务器打开页面。`);
    return;
  }

  renderer.setAnimationLoop(tick);
  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : tick);
  });
}

function setupModel(gltf, manifest) {
  const root = gltf.scene;

  // MuJoCo 是 Z 轴向上，three.js 是 Y 轴向上。
  root.rotation.x = -Math.PI / 2;

  const nodeIndex = new Map(manifest.nodes.map((n) => [n.node, n]));

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const info = nodeIndex.get(obj.name);
    if (!info) return;
    const partId = partForNode(info);
    if (!partId) return;

    obj.userData.partId = partId;
    obj.userData.baseColor = obj.material.color.clone();

    // glTF 里同一份几何被多个节点复用 → 材质也是共享的。
    // 高亮要按节点改色，所以必须克隆，否则点一个舵机整机同型号舵机一起亮。
    obj.material = obj.material.clone();
    obj.material.flatShading = true;
    obj.material.envMapIntensity = 0.6;
    obj.material.needsUpdate = true;
    obj.userData.baseColor = obj.material.color.clone();

    if (!meshesByPart.has(partId)) meshesByPart.set(partId, []);
    meshesByPart.get(partId).push(obj);
  });

  modelRoot = root;
  scene.add(root);

  // 关节节点先登记，再把 home 姿态套上去。顺序不能反：setJoint 需要 baseQuat。
  for (const joint of manifest.joints) {
    if (!joint.actuated) continue;
    const node = root.getObjectByName(joint.node);
    if (!node) continue;
    node.userData.baseQuat = node.quaternion.clone();
    node.userData.joint = joint.name;
  }
  applyHomePose();

  // 先把零姿态下的 site 换算成“相对所属身体”的局部坐标。
  // 这样套上 home 姿态、以后再做待机动画时，热点都会跟着身体走。
  root.updateMatrixWorld(true);
  const bodyNodeByName = new Map(
    manifest.bodies.map((b) => [b.name, root.getObjectByName(b.node)]),
  );
  const hotspotParts = [
    { site: 'imu', partId: 'imu', label: 'IMU' },
    { site: 'tof', partId: 'tof', label: 'ToF' },
    { site: 'head_camera', partId: 'camera', label: 'CAM' },
  ];
  const siteAnchors = [];
  for (const hs of hotspotParts) {
    const site = manifest.sites.find((s) => s.name === hs.site);
    if (!site) continue;
    const anchor = bodyNodeByName.get(site.body) ?? root;
    const worldAtZero = new THREE.Vector3(...site.world).applyMatrix4(root.matrixWorld);
    siteAnchors.push({
      ...hs,
      anchor,
      local: anchor.worldToLocal(worldAtZero.clone()),
    });
  }

  // 把脚底落到 y=0，水平居中，这样相机与地面环不用猜坐标。
  const box = new THREE.Box3().setFromObject(root);
  const centre = box.getCenter(new THREE.Vector3());
  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);

  // 热点挂在场景根上，而不是 Z 轴朝上的 root 里：Sprite 一旦继承那层旋转，
  // 文字会被转成镜像。位置每帧按身体节点的世界矩阵重算，所以仍然跟着头动。
  for (const hs of siteAnchors) {
    const hotspot = makeHotspot(PART_BY_ID.get(hs.partId));
    hotspot.position.copy(hs.anchor.localToWorld(hs.local.clone()));
    hotspot.userData.anchor = hs.anchor;
    hotspot.userData.local = hs.local;
    const label = makeLabelSprite(hs.label);
    label.position.set(0, 0.019, 0);
    label.visible = false;
    hotspot.add(label);
    hotspot.userData.label = label;
    scene.add(hotspot);
    hotspotByPart.set(hs.partId, hotspot);
  }

  applySelection();
}

/** 真机 home 姿态。见文件顶部的 HOME_POSE。 */
function applyHomePose() {
  for (const [name, angle] of Object.entries(HOME_POSE)) setJoint(name, angle);
}

/* ------------------------------------------------------------------ loop */

const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt / camAnim.dur);
    const e = 1 - Math.pow(1 - camAnim.t, 3);
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    controls.target.lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);
    if (camAnim.t >= 1) camAnim = null;
  }

  // 待机微动：在 home 姿态上叠四个不同频率的小正弦。
  if (modelRoot && state.idle) {
    setJoint('head_yaw', HOME_POSE.head_yaw + Math.sin(t * 0.45) * 0.13);
    setJoint('neck_pitch', HOME_POSE.neck_pitch + Math.sin(t * 0.31 + 1.1) * 0.045);
    setJoint('head_pitch', HOME_POSE.head_pitch + Math.sin(t * 0.37 + 2.2) * 0.035);
    setJoint('head_roll', HOME_POSE.head_roll + Math.sin(t * 0.26 + 0.4) * 0.03);
  }

  // 关节动完再更新世界矩阵，热点才能贴着头一起转。
  if (modelRoot) modelRoot.updateMatrixWorld(true);
  for (const [partId, hs] of hotspotByPart) {
    const { anchor, local } = hs.userData;
    if (anchor && local) hs.position.copy(anchor.localToWorld(local.clone()));
  }

  if (hotspotByPart.size) {
    for (const [partId, hs] of hotspotByPart) {
      const active = state.selected === partId;
      const muted = Boolean(state.selected) && !active;
      const pulse = 1 + Math.sin(t * 2.2) * 0.12;
      hs.userData.halo.scale.setScalar(active ? pulse * 1.35 : pulse);
      hs.userData.halo.material.opacity = active ? 0.9 : muted ? 0.18 : 0.45;
      if (hs.userData.label) {
        // 平时只留小圆点，鼠标悬停或选中时才出现文字标签。
        hs.userData.label.visible = active || state.hovered === partId;
        hs.userData.label.material.opacity = active ? 1 : 0.85;
      }
    }
  }

  if (needsPick && !pointerDown) {
    needsPick = false;
    const partId = pick();
    if (partId !== state.hovered) {
      state.hovered = partId;
      el.canvas.classList.toggle('is-hover', Boolean(partId));
      el.hudPart.textContent = partId
        ? PART_BY_ID.get(partId).label
        : state.selected
          ? PART_BY_ID.get(state.selected).label
          : '点击部件';
    }
  }

  // 用户松手 9 秒后恢复自转，避免一直转着看不清。
  if (state.spin && controls && !controls.autoRotate && !camAnim) {
    if (performance.now() - state.userMovedAt > 9000) controls.autoRotate = true;
  }

  controls.update();
  renderer.render(scene, camera);
}

const jointNodes = new Map();
const tmpQuat = new THREE.Quaternion();
const axisZ = new THREE.Vector3(0, 0, 1);

function setJoint(name, angle) {
  if (!jointNodes.size || !jointNodes.has(name)) {
    if (!modelRoot) return;
    let found = null;
    modelRoot.traverse((o) => {
      if (!found && o.userData.joint === name) found = o;
    });
    if (!found) {
      jointNodes.set(name, null);
      return;
    }
    jointNodes.set(name, found);
  }
  const node = jointNodes.get(name);
  if (!node) return;
  tmpQuat.setFromAxisAngle(axisZ, angle);
  node.quaternion.copy(node.userData.baseQuat).multiply(tmpQuat);
}

// 调试用把手：控制台里能直接看相机、选中态与部件分组。
window.__duck = {
  state,
  get camera() { return camera; },
  get controls() { return controls; },
  get modelRoot() { return modelRoot; },
  meshesByPart,
  hotspotByPart,
};

init();
