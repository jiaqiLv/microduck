/**
 * 首页 3D 拆解。
 *
 * 数据流：CAD(MJCF) → microduck.glb（节点层级 = 身体层级）+ microduck-model.json
 *        → 每个 mesh 按 parts.js 的规则归到部件 → 射线拾取
 *        → 选中的部件从整机里“拆出来”，其余变暗，相机推近。
 *
 * 拆解不是克隆一份模型：部件里的每个 mesh 各自沿同一个世界方向平移，
 * 所以它还挂在原来的关节链上，待机时仍跟着身体动。
 *
 * 这里刻意不引入任何 UI 框架：一个模块、一个渲染循环，出问题只可能在一个地方。
 */

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
import { PARTS, PART_BY_ID, partForNode } from './parts.js';

const MODEL_URL = './assets/models/microduck.glb';
const MANIFEST_URL = './assets/models/microduck-model.json';

const ACCENT = new THREE.Color('#ff7a2f');
/**
 * 未选中部件的材质：近黑的剪影 + 一圈极淡的菲涅耳边缘光。
 *
 * 不能靠“把原材质调暗”：原材质再暗也会被主光照亮，近景时那片灰色机体
 * 会压过被拆出来的部件。换成不受光的深色之后，纯剪影又是一坨没有体积的
 * 黑影，所以再加一层只看视角的边缘光——外壳的转折处会亮起一条细线，
 * 既读出形体，又不会抢镜。
 */
const ghostMat = new THREE.ShaderMaterial({
  // 不跟着整机的 ACES 色调映射走：ACES 会把这种极暗的颜色压成纯黑，
  // 幽灵机身就变成画面上一个洞。这里直接给最终颜色，好控制得多。
  toneMapped: false,
  uniforms: {
    uBase: { value: new THREE.Color(0x131922) },
    uRim: { value: new THREE.Color(0x3d4756) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uBase;
    uniform vec3 uRim;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      vec3 n = normalize(vN);
      // 一点方向感：没有明暗的剪影看不出体积，这里只让朝向固定光的一侧
      // 稍微亮一点，整体仍然压得很暗。
      float ndl = max(dot(n, normalize(vec3(0.35, 0.75, 0.55))), 0.0);
      vec3 base = uBase * (0.45 + 0.9 * ndl);
      float f = 1.0 - abs(dot(n, normalize(vV)));
      f = pow(clamp(f, 0.0, 1.0), 2.2);
      gl_FragColor = vec4(mix(base, uRim, f), 1.0);
      #include <colorspace_fragment>
    }
  `,
});

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

const DEFAULT_VIEW = {
  position: new THREE.Vector3(0.40, 0.28, 0.51),
  target: new THREE.Vector3(0, 0.135, 0),
};

/** 整机的参考中心：拆解方向从这里往外发散。 */
const MODEL_CENTRE = new THREE.Vector3(0, 0.14, 0);
const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();

const state = {
  selected: null,
  hovered: null,
  spin: true,
  idle: true,
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  lastInteract: 0,
};

const el = {
  topBar: document.getElementById('top-bar'),
  stage: document.getElementById('stage'),
  canvas: document.getElementById('duck-canvas'),
  stageState: document.getElementById('stage-state'),
  stageStateText: document.getElementById('stage-state-text'),
  hint: document.getElementById('hint'),
  readout: document.getElementById('readout'),
  readoutIndex: document.getElementById('readout-index'),
  readoutRole: document.getElementById('readout-role'),
  readoutLabel: document.getElementById('readout-label'),
  readoutLine: document.getElementById('readout-line'),
  readoutSpecs: document.getElementById('readout-specs'),
  btnClear: document.getElementById('btn-clear'),
  btnReset: document.getElementById('btn-reset'),
  btnSpin: document.getElementById('btn-spin'),
  btnIdle: document.getElementById('btn-idle'),
  partsList: document.getElementById('parts-list'),
  cursorTag: document.getElementById('cursor-tag'),
};

let scene;
let camera;
let renderer;
let controls;
let modelRoot;
let raycaster;

const pointer = new THREE.Vector2();
const hotspotByPart = new Map();
const meshesByPart = new Map();

/** 每个部件在原位（home 姿态、未拆解）的世界包围球，加载后量一次。 */
const partBox = new Map();
/** 每个部件拆出去的方向与距离（世界坐标），躯干是零。 */
const explodeOffset = new Map();
/** 每个部件当前的拆解进度 0..1，用来做缓动。 */
const explodeProgress = new Map();
const activeParts = new Set();

let camAnim = null;
let pointerDown = null;
let needsPick = false;

/* ------------------------------------------------------------------- ui */

function buildList() {
  const frag = document.createDocumentFragment();
  PARTS.forEach((part, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row';
    btn.dataset.part = part.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `
      <span class="row__i">${String(i + 1).padStart(2, '0')}</span>
      <span class="row__label">${part.label}</span>
      <span class="row__role">${part.role}</span>
      <span class="row__line">${part.line}</span>`;
    btn.addEventListener('click', () => select(part.id, { fromUI: true, scroll: true }));
    li.append(btn);
    frag.append(li);
  });
  el.partsList.append(frag);
}

function showReadout(part) {
  const i = PARTS.indexOf(part) + 1;
  el.readoutIndex.textContent = `${String(i).padStart(2, '0')} / ${PARTS.length}`;
  el.readoutRole.textContent = part.role;
  el.readoutLabel.textContent = part.label;
  el.readoutLine.textContent = part.line;
  el.readoutSpecs.innerHTML = part.specs.map((s) => `<li>${s}</li>`).join('');
  el.readout.hidden = false;
  el.hint.hidden = true;
}

function hideReadout() {
  el.readout.hidden = true;
  el.hint.hidden = false;
}

function syncRows(partId) {
  for (const btn of el.partsList.querySelectorAll('.row')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.part === partId));
  }
}

/* ------------------------------------------------------------ selection */

function eachMesh(fn) {
  if (!modelRoot) return;
  modelRoot.traverse((obj) => {
    if (obj.isMesh && obj.userData.partId && !obj.userData.isHotspot) fn(obj);
  });
}

function applySelection() {
  const sel = state.selected;
  const selPart = sel ? PART_BY_ID.get(sel) : null;
  // IMU / ToF / 相机没有自己的网格（它们藏在壳里，只有 MuJoCo site），
  // 选中时把宿主身体一起点亮，否则整只鸭子变暗、只有一个圆点在亮。
  const lit = new Set([sel, selPart?.highlightWith].filter(Boolean));

  eachMesh((mesh) => {
    const mat = mesh.userData.baseMat;
    const base = mesh.userData.baseColor;

    if (sel && !lit.has(mesh.userData.partId)) {
      mesh.material = ghostMat;
      return;
    }

    mesh.material = mat;
    mat.color.copy(base);
    mat.envMapIntensity = sel ? 1 : 0.6;

    if (!sel) {
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
      return;
    }

    mat.emissive.copy(ACCENT);
    // 宿主身体比真正的选中部件暗一档，看得出谁是主体。
    mat.emissiveIntensity = mesh.userData.partId === sel ? 0.14 : 0.06;
  });
}

function select(partId, { fromUI = false, scroll = false } = {}) {
  const part = PART_BY_ID.get(partId);
  if (!part) return;

  state.selected = partId;
  applySelection();
  showReadout(part);
  syncRows(partId);

  if (meshesByPart.has(partId)) activeParts.add(partId);
  if (modelRoot) framePart(partId);

  if (scroll) {
    el.stage.scrollIntoView({
      behavior: state.reducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
  }
  if (fromUI) state.lastInteract = performance.now();
}

function clearSelection({ resetView = true } = {}) {
  const had = Boolean(state.selected);
  state.selected = null;
  applySelection();
  hideReadout();
  syncRows(null);
  if (had && resetView) animateCamera(DEFAULT_VIEW.position.clone(), DEFAULT_VIEW.target.clone());
}

/* -------------------------------------------------------------- framing */

function framePart(partId) {
  const info = partBox.get(partId);
  if (!info || !camera || !controls) return;

  const offset = explodeOffset.get(partId) ?? ZERO;
  const target = info.centre.clone().add(offset);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();

  // 让部件占画面的大约 66%。
  //
  // 不能用包围球算：腿、喙这种细长件，球的直径比实际轮廓大一倍，
  // 结果就是“点进去反而更小”。这里把包围盒的八个角投到相机的右/上轴上，
  // 取真正的横向、纵向半宽，再按视锥半角反推距离。
  const FILL = 0.66;
  const vTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const hTan = vTan * camera.aspect;

  let dist;
  if (info.box) {
    const right = new THREE.Vector3().crossVectors(camera.up, dir);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();

    let hw = 0;
    let hh = 0;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? info.box.max.x : info.box.min.x,
          i & 2 ? info.box.max.y : info.box.min.y,
          i & 4 ? info.box.max.z : info.box.min.z,
        )
        .sub(info.centre);
      hw = Math.max(hw, Math.abs(corner.dot(right)));
      hh = Math.max(hh, Math.abs(corner.dot(up)));
    }
    dist = Math.max(hh / vTan, hw / hTan) / FILL;
  } else {
    dist = info.radius / (FILL * Math.min(vTan, hTan));
  }

  // 下限放得很低：喙这种两厘米的零件，不凑近就完全没有“拎出来”的感觉。
  dist = THREE.MathUtils.clamp(dist, 0.15, 0.8);

  animateCamera(target.clone().addScaledVector(dir, dist), target);
}

function animateCamera(toPos, toTarget) {
  camAnim = {
    fromPos: camera.position.clone(),
    toPos,
    fromTarget: controls.target.clone(),
    toTarget,
    t: 0,
    dur: state.reducedMotion ? 0.001 : 0.62,
  };
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
  sky.addColorStop(0, '#26324a');
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
  // 只留一圈极淡的基准环。
  //
  // 之前这里还有一块加色混合的地面光晕，但画布是 alpha 合成到页面上的，
  // 任何覆盖到 alpha 的贴图都会把 canvas 后面那层 CSS 暖光挡掉，地上就
  // 多出一个方块。与其和混合模式较劲，不如什么都不画：黑底 + 一圈细线
  // 本来就够高级，模型也不会显得悬空。
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.168, 0.1695, 128),
    new THREE.MeshBasicMaterial({
      color: 0x5f6b82,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.0015;
  scene.add(ring);
}

/* -------------------------------------------------------------- hotspots */

function makeHotspot(part) {
  const group = new THREE.Group();
  // 热点是标注而不是实体：不参与深度测试，藏在壳里的 IMU 才看得见。
  // 关掉深度测试后必须自己排到所有 CAD 之后，否则会被模型盖住。
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.004, 16, 12),
    new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, depthWrite: false }),
  );
  dot.renderOrder = 20;
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.008, 0.0098, 24),
    new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.45,
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
  c2.strokeStyle = 'rgba(255,122,47,0.55)';
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

/* --------------------------------------------------------------- picking */

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
  state.lastInteract = performance.now();
  el.cursorTag.hidden = true;
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
  if (partId) select(partId, { fromUI: true });
  else clearSelection();
}

function onPointerMove(event) {
  updatePointer(event);
  needsPick = true;
  if (!el.cursorTag.hidden) {
    el.cursorTag.style.left = `${event.clientX}px`;
    el.cursorTag.style.top = `${event.clientY}px`;
  }
}

/* ------------------------------------------------------------ the loop */

const clock = new THREE.Clock();
const jointNodes = new Map();
const tmpQuat = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();
const axisZ = new THREE.Vector3(0, 0, 1);

function setJoint(name, angle) {
  if (!jointNodes.size || !jointNodes.has(name)) {
    if (!modelRoot) return;
    let found = null;
    modelRoot.traverse((o) => {
      if (!found && o.userData.joint === name) found = o;
    });
    jointNodes.set(name, found);
    if (!found) return;
  }
  const node = jointNodes.get(name);
  if (!node) return;
  tmpQuat.setFromAxisAngle(axisZ, angle);
  node.quaternion.copy(node.userData.baseQuat).multiply(tmpQuat);
}

/**
 * 拆解动画。
 *
 * 每个 mesh 记着自己的原位；选中时沿同一个世界方向平移，所以部件整体是刚体
 * 平移，不会散架。平移量要换算到 mesh 的父空间，因为父节点带着关节旋转。
 */
function updateExplode(dt) {
  if (!activeParts.size) return;
  const step = dt / (state.reducedMotion ? 0.001 : 0.62);

  for (const partId of activeParts) {
    const goal = state.selected === partId ? 1 : 0;
    const list = meshesByPart.get(partId) ?? [];
    const prev = explodeProgress.get(partId) ?? 0;
    const p = goal > prev ? Math.min(1, prev + step) : Math.max(0, prev - step);
    explodeProgress.set(partId, p);

    const e = 1 - Math.pow(1 - p, 3);
    const off = explodeOffset.get(partId) ?? ZERO;

    for (const mesh of list) {
      if (e === 0) {
        mesh.position.copy(mesh.userData.homePos);
        continue;
      }
      mesh.parent.getWorldQuaternion(tmpQuat).invert();
      tmpVec.copy(off).applyQuaternion(tmpQuat).multiplyScalar(e);
      mesh.position.copy(mesh.userData.homePos).add(tmpVec);
    }

    if (p === 0 && goal === 0) activeParts.delete(partId);
  }
}

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
    setJoint('head_yaw', HOME_POSE.head_yaw + Math.sin(t * 0.45) * 0.11);
    setJoint('neck_pitch', HOME_POSE.neck_pitch + Math.sin(t * 0.31 + 1.1) * 0.04);
    setJoint('head_pitch', HOME_POSE.head_pitch + Math.sin(t * 0.37 + 2.2) * 0.03);
    setJoint('head_roll', HOME_POSE.head_roll + Math.sin(t * 0.26 + 0.4) * 0.025);
  }

  // 关节动完再更新世界矩阵，热点和拆解都依赖它。
  if (modelRoot) modelRoot.updateMatrixWorld(true);

  for (const [, hs] of hotspotByPart) {
    const { anchor, local } = hs.userData;
    if (anchor && local) hs.position.copy(anchor.localToWorld(local.clone()));
  }

  updateExplode(dt);

  // 热点呼吸 + 标签：平时只留小圆点，选中或悬停时才出现文字。
  for (const [partId, hs] of hotspotByPart) {
    const active = state.selected === partId;
    const muted = Boolean(state.selected) && !active;
    const pulse = 1 + Math.sin(t * 2.2) * 0.12;
    hs.userData.halo.scale.setScalar(active ? pulse * 1.5 : pulse);
    hs.userData.halo.material.opacity = active ? 0.9 : muted ? 0.14 : 0.4;
    if (hs.userData.label) {
      hs.userData.label.visible = active || state.hovered === partId;
      hs.userData.label.material.opacity = active ? 1 : 0.85;
    }
  }

  if (needsPick && !pointerDown) {
    needsPick = false;
    const partId = pick();
    if (partId !== state.hovered) {
      state.hovered = partId;
      el.canvas.classList.toggle('is-hover', Boolean(partId));
      if (partId) {
        el.cursorTag.textContent = PART_BY_ID.get(partId).label;
        el.cursorTag.hidden = false;
      } else {
        el.cursorTag.hidden = true;
      }
    }
  }

  // 自转：选中部件时停住（要看清），松手几秒后再自己转起来。
  if (controls) {
    const idleEnough = performance.now() - state.lastInteract > 5000;
    controls.autoRotate =
      state.spin && !state.selected && !pointerDown && idleEnough && !camAnim;
  }

  controls.update();
  renderer.render(scene, camera);
}

/* --------------------------------------------------------------- model */

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

    // glTF 里同一份几何被多个节点复用 → 材质也是共享的。
    // 高亮要按节点改色，所以必须克隆，否则点一个舵机整机同型号舵机一起亮。
    obj.material = obj.material.clone();
    obj.material.flatShading = true;
    obj.material.envMapIntensity = 0.6;
    obj.material.needsUpdate = true;

    obj.userData.partId = partId;
    obj.userData.baseMat = obj.material;
    obj.userData.baseColor = obj.material.color.clone();
    obj.userData.homePos = obj.position.clone();

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

  measureParts();
  applySelection();
}

/** 真机 home 姿态。见文件顶部的 HOME_POSE。 */
function applyHomePose() {
  for (const [name, angle] of Object.entries(HOME_POSE)) setJoint(name, angle);
}

/**
 * 量出每个部件的包围盒，并决定它往哪儿拆。
 * 必须在 home 姿态、模型居中之后调用一次——之后所有取景都读这份缓存，
 * 不会因为上一个部件已经拆出去而量歪。
 */
function measureParts() {
  for (const [partId, list] of meshesByPart) {
    const box = new THREE.Box3();
    for (const mesh of list) box.expandByObject(mesh);
    if (box.isEmpty()) continue;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.012);
    partBox.set(partId, { centre: sphere.center.clone(), radius, box: box.clone() });
    explodeOffset.set(partId, offsetFor(partId, sphere.center, radius));
  }
  // IMU / ToF / 相机没有网格，只记热点位置，取景时用。
  for (const [partId, hs] of hotspotByPart) {
    if (partBox.has(partId)) continue;
    // 热点本身只有几毫米，取景半径按“宿主身体上的一块区域”算，
    // 否则相机会贴到壳里，画面里只剩一片放大的塑料。
    partBox.set(partId, { centre: hs.position.clone(), radius: 0.07, box: null });
  }
}

/**
 * 拆解方向：从整机中心指向部件中心，再把竖直分量抬一点，像被拎起来。
 * 躯干不动——它是整机的参照，拉走只会让腿留在原地。
 */
function offsetFor(partId, centre, radius) {
  if (partId === 'torso') return new THREE.Vector3();

  const dir = centre.clone().sub(MODEL_CENTRE);
  dir.y = Math.max(dir.y, 0);
  if (dir.lengthSq() < 0.0004) {
    // 中心附近的部件（舵机）：朝镜头方向拎出来，别往头上撞。
    dir.set(0, 0.16, 1);
  }
  dir.normalize().addScaledVector(UP, 0.2).normalize();

  const dist = THREE.MathUtils.clamp(0.07 + radius * 1.05, 0.07, 0.17);
  return dir.multiplyScalar(dist);
}

/* ---------------------------------------------------------------- init */

function fail(message) {
  el.stageState.classList.add('is-error');
  el.stageState.hidden = false;
  el.stageStateText.textContent = message;
}

async function init() {
  buildList();

  const onScroll = () => el.topBar.classList.toggle('is-solid', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

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
      alpha: true,
      powerPreference: 'high-performance',
    });
    gl = renderer.getContext();
  } catch (err) {
    fail('这个浏览器没有可用的 WebGL 上下文，3D 拆解无法运行。');
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
  renderer.toneMappingExposure = 1.18;

  scene = new THREE.Scene();
  scene.background = null;
  scene.environment = makeEnvironment(renderer);

  camera = new THREE.PerspectiveCamera(
    32,
    el.stage.clientWidth / el.stage.clientHeight,
    0.01,
    6,
  );
  camera.position.copy(DEFAULT_VIEW.position);

  controls = new OrbitControls(camera, el.canvas);
  controls.target.copy(DEFAULT_VIEW.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 0.12;
  controls.maxDistance = 1.1;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI / 2 + 0.16;
  controls.enablePan = false;
  controls.autoRotate = state.spin;
  controls.autoRotateSpeed = 0.5;
  controls.update();
  controls.addEventListener('start', () => {
    state.lastInteract = performance.now();
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
    state.hovered = null;
    el.canvas.classList.remove('is-hover');
    el.cursorTag.hidden = true;
  });

  el.btnReset.addEventListener('click', () => {
    clearSelection();
    animateCamera(DEFAULT_VIEW.position.clone(), DEFAULT_VIEW.target.clone());
  });
  el.btnSpin.addEventListener('click', () => {
    state.spin = !state.spin;
    state.lastInteract = 0;
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
  el.btnClear.addEventListener('click', () => clearSelection());

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSelection();
  });

  const ro = new ResizeObserver(() => {
    const w = el.stage.clientWidth;
    const h = el.stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 换屏 / 转屏之后取景是按旧画幅算的，选中的部件会偏到一边，重新框一次。
    if (state.selected) framePart(state.selected);
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
  } catch (err) {
    console.error(err);
    fail(`模型加载失败：${err.message}。请确认 assets/models/ 下的文件存在，并用本地服务器打开页面。`);
    return;
  }

  el.stageState.hidden = true;
  renderer.setAnimationLoop(tick);
  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : tick);
  });
}

// 调试用把手：控制台里能直接看相机、选中态、拆解进度与部件分组。
window.__duck = {
  state,
  select,
  clearSelection,
  get camera() {
    return camera;
  },
  get controls() {
    return controls;
  },
  get modelRoot() {
    return modelRoot;
  },
  meshesByPart,
  hotspotByPart,
  partBox,
  explodeOffset,
  explodeProgress,
};

init();
