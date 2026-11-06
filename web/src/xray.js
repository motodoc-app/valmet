// Layer C: X-Ray inspection — procedurally generated, clearly *illustrative* end-suction centrifugal pump.
// Every mesh is tagged with a component id from backend/xray/knowledge/pump_components.json.
import * as THREE from "three";

const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.38, ...o });

function volute() {
  // spiral casing: tube along a growing spiral + discharge nozzle
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2 * 0.95;
    const r = 0.30 + 0.07 * (i / 64);
    pts.push(new THREE.Vector3(0, Math.sin(a) * r, Math.cos(a) * r));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.Group();
  const radius = (t) => 0.07 + 0.06 * t;
  // TubeGeometry has constant radius: build rings manually for a growing cross-section
  const segs = 96, radial = 20;
  const pos = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = curve.getPointAt(t), T = curve.getTangentAt(t);
    const N = new THREE.Vector3(1, 0, 0), B = new THREE.Vector3().crossVectors(T, N).normalize();
    const r = radius(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const v = p.clone().addScaledVector(N, Math.cos(a) * r).addScaledVector(B, Math.sin(a) * r);
      pos.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  g.add(new THREE.Mesh(geo, null));
  const back = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.06, 48), null);
  back.rotation.z = Math.PI / 2;
  back.position.x = -0.07;
  g.add(back);
  const discharge = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.38, 32), null);
  discharge.position.set(0, 0.48, -0.2);
  g.add(discharge);
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.035, 32), null);
  flange.position.set(0, 0.67, -0.2);
  g.add(flange);
  const suction = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.26, 32), null);
  suction.rotation.z = Math.PI / 2;
  suction.position.x = 0.16;
  g.add(suction);
  const sflange = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.035, 32), null);
  sflange.rotation.z = Math.PI / 2;
  sflange.position.x = 0.29;
  g.add(sflange);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.42), null);
  foot.position.y = -0.4;
  g.add(foot);
  return g;
}

function impeller() {
  const g = new THREE.Group();
  const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.02, 48), null);
  shroud.rotation.z = Math.PI / 2;
  g.add(shroud);
  const front = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.03, 12, 48), null);
  front.rotation.y = Math.PI / 2;
  front.position.x = 0.07;
  g.add(front);
  const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.08, 32, 1, true), null);
  eye.rotation.z = Math.PI / 2;
  eye.position.x = 0.07;
  g.add(eye);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 24), null);
  hub.rotation.z = Math.PI / 2;
  hub.position.x = 0.02;
  g.add(hub);
  // backward-curved vanes
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.quadraticCurveTo(0.08, 0.02, 0.16, 0.09); shape.lineTo(0.15, 0.1);
  shape.quadraticCurveTo(0.07, 0.035, -0.005, 0.012); shape.closePath();
  const vg = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
  for (let i = 0; i < 6; i++) {
    const v = new THREE.Mesh(vg, null);
    const a = (i / 6) * Math.PI * 2;
    v.rotation.set(0, Math.PI / 2, 0);
    const holder = new THREE.Group();
    holder.add(v);
    v.position.set(0.0, 0.07, 0);
    holder.rotation.x = a;
    holder.position.x = 0.0;
    g.add(holder);
  }
  return g;
}

function bearing(r = 0.085) {
  const g = new THREE.Group();
  const outer = new THREE.Mesh(new THREE.TorusGeometry(r, 0.018, 12, 40), null);
  outer.rotation.y = Math.PI / 2;
  const inner = new THREE.Mesh(new THREE.TorusGeometry(r * 0.62, 0.013, 12, 40), null);
  inner.rotation.y = Math.PI / 2;
  g.add(outer, inner);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 10), null);
    ball.position.set(0, Math.sin(a) * r * 0.81, Math.cos(a) * r * 0.81);
    g.add(ball);
  }
  return g;
}

function motor() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.62, 48), null);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  for (let i = 0; i < 24; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.04, 0.012), null);
    const a = (i / 24) * Math.PI * 2;
    fin.position.set(0, Math.sin(a) * 0.255, Math.cos(a) * 0.255);
    fin.rotation.x = -a;
    g.add(fin);
  }
  const fanCover = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.14, 48), null);
  fanCover.rotation.z = Math.PI / 2;
  fanCover.position.x = -0.38;
  g.add(fanCover);
  const tbox = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.16), null);
  tbox.position.set(0.05, 0.3, 0);
  g.add(tbox);
  const feet = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.4), null);
  feet.position.y = -0.24;
  g.add(feet);
  const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 16), null);
  stub.rotation.z = Math.PI / 2;
  stub.position.x = 0.37;
  g.add(stub);
  return g;
}

function coupling() {
  const g = new THREE.Group();
  for (const x of [-0.045, 0.045]) {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 32), null);
    hub.rotation.z = Math.PI / 2;
    hub.position.x = x;
    g.add(hub);
  }
  const spider = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.016, 10, 24), null);
  spider.rotation.y = Math.PI / 2;
  spider.userData.accent = true;
  g.add(spider);
  return g;
}

function bearingHousing() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.42, 40, 1, true), null);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  for (const x of [-0.21, 0.21]) {
    const cap = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.13, 40), null);
    cap.rotation.y = Math.PI / 2;
    cap.position.x = x;
    g.add(cap);
  }
  const ped = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.2), null);
  ped.position.y = -0.2;
  g.add(ped);
  const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.06, 12), null);
  sensor.position.set(0.05, 0.16, 0);
  sensor.userData.accent = true;
  g.add(sensor);
  return g;
}

const PART_DEFS = [
  // id, builder, assembled position (x along shaft), explode offset, colour
  ["baseplate", () => new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 0.62), null), [-0.35, -0.48, 0], [0, -0.35, 0], 0x334155],
  ["motor", motor, [-0.98, 0, 0], [-0.6, 0.12, 0], 0x1d4ed8],
  ["coupling", coupling, [-0.55, 0, 0], [-0.25, 0.45, 0], 0x64748b],
  ["shaft", () => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.05, 20), null); m.rotation.z = Math.PI / 2; return m; }, [-0.05, 0, 0], [0, 0.0, 0.55], 0xd1d5db],
  ["bearing_housing", bearingHousing, [-0.2, 0, 0], [-0.05, 0.62, 0], 0x475569],
  ["bearing_outboard", () => bearing(0.075), [-0.38, 0, 0], [-0.25, 0.25, 0.42], 0xcbd5e1],
  ["bearing_inboard", () => bearing(0.08), [-0.02, 0, 0], [0.05, 0.25, 0.42], 0xcbd5e1],
  ["seal", () => { const g = new THREE.Group(); const a = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.07, 32), null); a.rotation.z = Math.PI / 2; const s = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.01, 8, 24), null); s.rotation.y = Math.PI / 2; s.position.x = -0.05; g.add(a, s); return g; }, [0.18, 0, 0], [0.3, 0.3, 0.3], 0x10b981],
  ["impeller", impeller, [0.4, 0, 0], [0.55, 0.05, 0.42], 0xb45309],
  ["wear_ring", () => { const m = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 10, 40), null); m.rotation.y = Math.PI / 2; return m; }, [0.5, 0, 0], [0.75, 0.32, 0.42], 0xf59e0b],
  ["casing", volute, [0.45, 0, 0], [0.85, 0.0, -0.45], 0x9f1239],
];

export class XRay {
  constructor(kb) {
    this.kb = kb;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b14);
    this.scene.fog = new THREE.Fog(0x070b14, 6, 14);
    this.root = new THREE.Group();
    this.root.position.x = -0.7;   // keep the exploded assembly clear of the right-hand panel
    this.scene.add(this.root);
    this.parts = new Map();
    this.explode = 0;        // 0 assembled .. 1 exploded
    this.target = 0;
    this.ghost = false;
    this.hidden = new Set();
    this._lights();
    this._grid();
    this._build();
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x0b1020, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 2.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x38bdf8, 1.4);
    rim.position.set(-3, 1.5, -2);
    this.scene.add(rim);
  }

  _grid() {
    const grid = new THREE.GridHelper(8, 32, 0x1e3a5f, 0x0f2440);
    grid.position.y = -0.53;
    this.scene.add(grid);
  }

  _build() {
    for (const [id, build, pos, off, color] of PART_DEFS) {
      const obj = build();
      const mat = M(color);
      const accent = M(0xf97316, { emissive: 0x7c2d12, emissiveIntensity: 0.4 });
      obj.traverse((m) => {
        if (m.isMesh) {
          m.material = m.userData.accent ? accent : mat;
          m.userData.componentId = id;
        }
      });
      if (obj.isMesh) obj.userData.componentId = id;
      const holder = new THREE.Group();
      holder.add(obj);
      holder.position.set(...pos);
      this.root.add(holder);
      const comp = this.kb.components.find((c) => c.id === id);
      this.parts.set(id, { holder, obj, base: new THREE.Vector3(...pos), off: new THREE.Vector3(...off), mat, color, comp });
    }
  }

  pickables() {
    const out = [];
    for (const [id, p] of this.parts) if (!this.hidden.has(id)) p.obj.traverse((m) => m.isMesh && out.push(m));
    return out;
  }

  setExplode(v) { this.target = v; }

  setGhost(on) {
    this.ghost = on;
    for (const id of ["casing", "bearing_housing", "motor"]) {
      const p = this.parts.get(id);
      p.mat.transparent = on;
      p.mat.opacity = on ? 0.18 : 1;
      p.mat.depthWrite = !on;
    }
  }

  setHidden(ids) {
    this.hidden = new Set(ids);
    for (const [id, p] of this.parts) p.holder.visible = !this.hidden.has(id);
  }

  highlight(ids, { selected = null } = {}) {
    const set = new Set(ids);
    for (const [id, p] of this.parts) {
      const on = set.has(id);
      const sel = id === selected;
      p.mat.emissive = new THREE.Color(sel ? 0x38bdf8 : on ? 0xf43f5e : 0x000000);
      p.mat.emissiveIntensity = sel ? 0.7 : on ? 0.55 : 0;
    }
    this.flagged = set;
  }

  update(dt, t) {
    this.explode += (this.target - this.explode) * Math.min(1, dt * 3.2);
    const e = this.explode;
    const ease = e * e * (3 - 2 * e);
    for (const p of this.parts.values()) {
      p.holder.position.copy(p.base).addScaledVector(p.off, ease);
    }
    // gently spin rotating parts when assembled to show the drive train
    const spin = (1 - ease) * dt * 2.5;
    for (const id of ["impeller", "shaft", "coupling"]) {
      const p = this.parts.get(id);
      p.obj.rotation.x += spin;
    }
    if (this.flagged) {
      for (const id of this.flagged) {
        const p = this.parts.get(id);
        if (p) p.mat.emissiveIntensity = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t * 5));
      }
    }
  }

  partCenter(id) {
    const p = this.parts.get(id);
    const box = new THREE.Box3().setFromObject(p.holder);
    return box.getCenter(new THREE.Vector3());
  }
}
