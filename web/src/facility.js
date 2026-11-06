// Layer A + B: the scanned plant room, semantic 3D frames, navigation route and the inspection robot.
import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const STATUS_COLORS = {
  healthy: 0x34d399, watch: 0xfacc15, degraded: 0xfb923c, attention_required: 0xf43f5e,
};
const CATEGORY_COLORS = {
  rotating: 0x60a5fa, valve: 0xa78bfa, instrument: 0x22d3ee, vessel: 0xf472b6, piping: 0x94a3b8,
  electrical: 0xfbbf24, structure: 0xef4444, logistics: 0x64748b, safety: 0xf97316, other: 0x6b7280,
};

export class Facility {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.frames = new Map();       // object id -> {group, edges, pick, obj, label}
    this.highlight = new Set();
    this.showMode = "all";         // all | assets | none
    this.splat = new SplatMesh({ url: new URLSearchParams(location.search).get("splat") || "/data/scene.splat" });
    this.root.add(this.splat);
    this._buildFrames();
    this._buildRobot();
    this.routeGroup = new THREE.Group();
    this.root.add(this.routeGroup);
    this.blockGroup = new THREE.Group();
    this.root.add(this.blockGroup);
    this.gridGroup = new THREE.Group();
    this.gridGroup.visible = false;
    this.root.add(this.gridGroup);
  }

  colorFor(o) {
    if (o.asset) return STATUS_COLORS[o.asset.condition_state] ?? 0xffffff;
    return CATEGORY_COLORS[o.category] ?? 0x9ca3af;
  }

  _buildFrames() {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const edgesGeo = new THREE.EdgesGeometry(unit);
    for (const o of this.data.objects) {
      const g = new THREE.Group();
      g.position.set(...o.center);
      g.rotation.y = -o.yaw;
      g.scale.set(...o.size.map((s) => Math.max(s, 0.03)));
      const col = this.colorFor(o);
      const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: o.asset ? 0.95 : 0.45, depthTest: true });
      const edges = new THREE.LineSegments(edgesGeo, mat);
      g.add(edges);
      const fillMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.0, depthWrite: false });
      const pick = new THREE.Mesh(unit, fillMat);
      pick.userData.objectId = o.id;
      g.add(pick);
      this.root.add(g);
      if (o.kind === "structure") g.visible = false;
      this.frames.set(o.id, { group: g, edges, pick, obj: o, fill: fillMat, baseOpacity: mat.opacity, color: col });
    }
  }

  pickables() {
    return [...this.frames.values()].filter((f) => f.group.visible).map((f) => f.pick);
  }

  setShowMode(mode) {
    this.showMode = mode;
    for (const f of this.frames.values()) {
      const o = f.obj;
      f.group.visible = o.kind !== "structure" && (mode === "all" || (mode === "assets" && !!o.asset) || this.highlight.has(o.id));
    }
  }

  ensureLabel(id) {
    const f = this.frames.get(id);
    if (!f || f.label) return f?.label;
    const o = f.obj;
    const el = document.createElement("div");
    el.className = "tag3d" + (o.asset ? ` st-${o.asset.condition_state}` : "");
    el.innerHTML = o.asset
      ? `<b>${o.asset.tag}</b> <span>${o.asset.asset_class.replace("_", " ").toLowerCase()}</span><i>${o.asset.condition_state.replace("_", " ")} · ${o.asset.health_score}</i>`
      : `<b>${o.label}</b><i>${Math.round(o.confidence * 100)}% · ${o.label_source}</i>`;
    const lab = new CSS2DObject(el);
    lab.position.set(o.center[0], o.center[1] + o.size[1] / 2 + 0.05, o.center[2]);
    lab.visible = false;
    this.root.add(lab);
    f.label = lab;
    return lab;
  }

  setHighlighted(ids, { selected = null, target = null } = {}) {
    const next = new Set(ids);
    for (const [id, f] of this.frames) {
      const on = next.has(id) || id === selected || id === target;
      const m = f.edges.material;
      if (on) {
        m.opacity = 1;
        f.fill.opacity = id === selected || id === target ? 0.16 : 0.07;
        const o = f.obj;
        const worthLabel = o.asset || id === selected || (o.confidence >= 0.6 && o.label !== "other equipment");
        if (worthLabel) this.ensureLabel(id).visible = true; else if (f.label) f.label.visible = false;
        if (!f.group.visible && f.obj.kind !== "structure") f.group.visible = true;
      } else {
        m.opacity = f.baseOpacity;
        f.fill.opacity = 0;
        if (f.label) f.label.visible = false;
      }
      f.group.scale.set(...f.obj.size.map((s) => Math.max(s, 0.03) * (on ? 1.04 : 1)));
    }
    this.highlight = next;
    this.setShowMode(this.showMode);
  }

  pulse(t, ids) {
    for (const id of ids) {
      const f = this.frames.get(id);
      if (f) f.fill.opacity = 0.1 + 0.12 * (0.5 + 0.5 * Math.sin(t * 6));
    }
  }

  // ---------------------------------------------------------------- robot
  _buildRobot() {
    const r = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.26, 28),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.2, roughness: 0.35 }));
    body.position.y = 0.2;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.195, 0.195, 0.04, 28),
      new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x0ea5e9, emissiveIntensity: 0.8 }));
    band.position.y = 0.12;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 12),
      new THREE.MeshStandardMaterial({ color: 0x334155 }));
    mast.position.y = 0.6;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.5, roughness: 0.3 }));
    head.position.y = 0.9;
    const eye = new THREE.Mesh(new THREE.CircleGeometry(0.028, 20),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
    eye.position.set(0, 0.9, 0.051);
    const lidar = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 1 }));
    lidar.rotation.x = Math.PI / 2;
    lidar.position.y = 0.97;
    for (const m of [body, band, mast, head, eye, lidar]) r.add(m);
    // proximity ring on the floor
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.2, 64),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    r.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.2, 64),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.015;
    r.add(disc);
    r.userData = { lidar, ring };
    r.position.set(...this.data.start);
    this.robot = r;
    this.root.add(r);
  }

  // ---------------------------------------------------------------- route + blocks
  drawRoute(waypoints, { color = 0x38bdf8, dashed = false } = {}) {
    this.routeGroup.clear();
    if (!waypoints?.length) return;
    const pts = waypoints.map((p) => new THREE.Vector3(p[0], 0.04, p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.05);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(20, pts.length * 12), 0.022, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: dashed ? 0.35 : 0.95 }));
    this.routeGroup.add(tube);
    // chevrons along the route
    const len = curve.getLength();
    for (let d = 0.25; d < len; d += 0.3) {
      const t = d / len;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const chev = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 3),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: dashed ? 0.3 : 0.9 }));
      chev.position.copy(p);
      chev.position.y = 0.05;
      chev.lookAt(p.clone().add(tan));
      chev.rotateX(Math.PI / 2);
      this.routeGroup.add(chev);
    }
    const end = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.17, 32), new THREE.MeshBasicMaterial({ color: 0xf43f5e, side: THREE.DoubleSide }));
    end.rotation.x = -Math.PI / 2;
    end.position.set(pts.at(-1).x, 0.03, pts.at(-1).z);
    this.routeGroup.add(end);
    return curve;
  }

  ghostRoute(waypoints) {
    if (!waypoints?.length) return;
    const pts = waypoints.map((p) => new THREE.Vector3(p[0], 0.035, p[2]));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x94a3b8, dashSize: 0.08, gapSize: 0.06 }));
    line.computeLineDistances();
    this.routeGroup.add(line);
  }

  setBlocks(blocks) {
    this.blockGroup.clear();
    for (const b of blocks) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x7c2d12, transparent: true, opacity: 0.85 });
      const stripe = new THREE.MeshStandardMaterial({ color: 0x111827 });
      for (let i = 0; i < 2; i++) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 10), mat);
        post.position.set((i - 0.5) * (b.w ?? 0.6), 0.4, 0);
        g.add(post);
      }
      for (let k = 0; k < 2; k++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(b.w ?? 0.6, 0.07, 0.03), k ? stripe : mat);
        bar.position.y = 0.55 + k * 0.18;
        g.add(bar);
      }
      const zone = new THREE.Mesh(new THREE.PlaneGeometry(b.w ?? 0.6, b.d ?? 0.6),
        new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
      zone.rotation.x = -Math.PI / 2;
      zone.position.y = 0.02;
      g.add(zone);
      g.position.set(b.x, 0, b.z);
      this.blockGroup.add(g);
    }
  }

  showGrid(grid) {
    this.gridGroup.clear();
    const dec = (hex) => {
      const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
      const out = new Uint8Array(grid.W * grid.H);
      for (let i = 0; i < out.length; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
      return out;
    };
    const walk = dec(grid.walkable), occ = dec(grid.occupied);
    const canvas = document.createElement("canvas");
    canvas.width = grid.W; canvas.height = grid.H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(grid.W, grid.H);
    for (let r = 0; r < grid.H; r++) for (let c = 0; c < grid.W; c++) {
      const i = r * grid.W + c, k = i * 4;
      if (walk[i]) { img.data.set([52, 211, 153, 110], k); }
      else if (occ[i]) { img.data.set([244, 63, 94, 120], k); }
      else img.data[k + 3] = 0;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    const w = grid.W * grid.res, h = grid.H * grid.res;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    plane.rotation.x = Math.PI / 2;   // image row r -> +z
    plane.scale.y = -1;
    plane.position.set(grid.x0 + w / 2, 0.01, grid.z0 + h / 2);
    this.gridGroup.add(plane);
  }
}
