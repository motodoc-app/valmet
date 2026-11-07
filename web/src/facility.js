// The scanned plant room: splats, semantic 3D frames, route, robot and walkway blocks.
import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const STATUS = { healthy: 0x30d158, watch: 0xffd60a, degraded: 0xff9f0a, attention_required: 0xff453a };
const NEUTRAL = 0xc8ccd2;

export class Facility {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.frames = new Map();
    this.highlight = new Set();
    this.showMode = "all";
    this.splats = [];
    this._buildFrames();
    this._buildRobot();
    this.routeGroup = new THREE.Group();
    this.blockGroup = new THREE.Group();
    this.gridGroup = new THREE.Group();
    this.gridGroup.visible = false;
    this.root.add(this.routeGroup, this.blockGroup, this.gridGroup);
  }

  async loadSplats(urls, onProgress) {
    const qa = new URLSearchParams(location.search).get("splat");
    if (qa) urls = [qa];
    let done = 0;
    const meshes = await Promise.all(urls.map(async (u) => {
      const bytes = new Uint8Array(await (await fetch(u)).arrayBuffer());
      onProgress?.(++done / urls.length);
      const m = new SplatMesh({ fileBytes: bytes, fileType: "splat", fileName: "scene.splat" });
      this.root.add(m);
      this.splats.push(m);
      return m;
    }));
    await Promise.all(meshes.map((m) => m.initialized));
  }

  colorFor(o) { return o.asset ? STATUS[o.asset.condition_state] ?? NEUTRAL : NEUTRAL; }

  _buildFrames() {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const edgesGeo = new THREE.EdgesGeometry(unit);
    for (const o of this.data.objects) {
      const g = new THREE.Group();
      g.position.set(...o.center);
      g.rotation.y = -o.yaw;
      g.scale.set(...o.size.map((s) => Math.max(s, 0.03)));
      const col = this.colorFor(o);
      const base = o.asset ? 0.85 : 0.16;
      const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: base });
      const edges = new THREE.LineSegments(edgesGeo, mat);
      const fill = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false });
      const pick = new THREE.Mesh(unit, fill);
      pick.userData.objectId = o.id;
      g.add(edges, pick);
      if (o.kind === "structure") g.visible = false;
      this.root.add(g);
      this.frames.set(o.id, { group: g, edges, pick, fill, obj: o, base });
    }
  }

  pickables() { return [...this.frames.values()].filter((f) => f.group.visible).map((f) => f.pick); }

  setShowMode(mode) {
    this.showMode = mode;
    for (const f of this.frames.values()) {
      const o = f.obj;
      f.group.visible = o.kind !== "structure" && (mode === "all" || (mode === "assets" && !!o.asset) || this.highlight.has(o.id));
    }
  }

  ensureLabel(id) {
    const f = this.frames.get(id);
    if (!f) return null;
    if (f.label) return f.label;
    const o = f.obj, el = document.createElement("div");
    if (o.asset) {
      el.className = `tag3d asset s-${o.asset.condition_state}`;
      el.innerHTML = `<span class="dot s-${o.asset.condition_state}"></span><b>${o.asset.tag}</b><small>${o.asset.health_score}</small>`;
    } else {
      el.className = "tag3d";
      el.innerHTML = `${o.label}<small>${Math.round(o.confidence * 100)}%</small>`;
    }
    const lab = new CSS2DObject(el);
    lab.position.set(o.center[0], o.center[1] + o.size[1] / 2, o.center[2]);
    lab.visible = false;
    this.root.add(lab);
    return (f.label = lab);
  }

  setHighlighted(ids, { selected = null, target = null } = {}) {
    const next = new Set(ids);
    for (const [id, f] of this.frames) {
      const on = next.has(id) || id === selected || id === target;
      const o = f.obj;
      f.edges.material.opacity = on ? 1 : f.base;
      f.fill.opacity = id === selected || id === target ? 0.1 : on ? 0.04 : 0;
      const worth = o.asset || id === selected || (o.confidence >= 0.7 && ["rotating", "valve", "instrument", "vessel", "electrical"].includes(o.category));
      if (on && worth) this.ensureLabel(id).visible = true;
      else if (f.label) f.label.visible = false;
    }
    this.highlight = next;
    this.setShowMode(this.showMode);
  }

  pulse(t, id) {
    const f = this.frames.get(id);
    if (f) f.fill.opacity = 0.06 + 0.08 * (0.5 + 0.5 * Math.sin(t * 3));
  }

  // ---------------------------------------------------------------- robot: compact, matte, one status light
  _buildRobot() {
    const r = new THREE.Group();
    const shell = new THREE.MeshStandardMaterial({ color: 0xe9ebee, roughness: 0.55, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.6 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.19, 0.2, 40), shell);
    base.position.y = 0.14;
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.04, 40), dark);
    skirt.position.y = 0.04;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.5, 16), dark);
    mast.position.y = 0.49;
    const head = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.1, 6, 16), shell);
    head.rotation.z = Math.PI / 2;
    head.position.y = 0.78;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshBasicMaterial({ color: 0x0a0b0d }));
    lens.position.set(0, 0.78, 0.051);
    const light = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.006, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    light.rotation.x = Math.PI / 2;
    light.position.y = 0.245;
    r.add(base, skirt, mast, head, lens, light);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.19, 1.2, 96),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    r.add(ring);
    r.position.set(...this.data.start);
    r.userData = { light, ring };
    this.robot = r;
    this.root.add(r);
  }

  // ---------------------------------------------------------------- route + blocks
  drawRoute(waypoints) {
    this.routeGroup.clear();
    if (!waypoints?.length) return null;
    const pts = waypoints.map((p) => new THREE.Vector3(p[0], 0.03, p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.05);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(40, pts.length * 20), 0.012, 6, false),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    this.routeGroup.add(tube);
    const len = curve.getLength();
    const dotGeo = new THREE.CircleGeometry(0.025, 16);
    for (let d = 0.2; d < len - 0.1; d += 0.2) {
      const p = curve.getPointAt(d / len);
      const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(p.x, 0.02, p.z);
      this.routeGroup.add(dot);
    }
    const end = new THREE.Mesh(new THREE.RingGeometry(0.11, 0.13, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    end.rotation.x = -Math.PI / 2;
    end.position.set(pts.at(-1).x, 0.025, pts.at(-1).z);
    this.routeGroup.add(end);
    return curve;
  }

  ghostRoute(waypoints) {
    if (!waypoints?.length) return;
    const geo = new THREE.BufferGeometry().setFromPoints(waypoints.map((p) => new THREE.Vector3(p[0], 0.025, p[2])));
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x8a9099, dashSize: 0.06, gapSize: 0.06, transparent: true, opacity: 0.8 }));
    line.computeLineDistances();
    this.routeGroup.add(line);
  }

  setBlocks(blocks) {
    this.blockGroup.clear();
    for (const b of blocks) {
      const g = new THREE.Group();
      const w = b.w ?? 0.6;
      const mat = new THREE.MeshStandardMaterial({ color: 0xff9f0a, roughness: 0.6 });
      const white = new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.6 });
      for (const x of [-w / 2, w / 2]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.75, 12), white);
        post.position.set(x, 0.375, 0);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.03, 20), white);
        foot.position.set(x, 0.015, 0);
        g.add(post, foot);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.02), mat);
      bar.position.y = 0.62;
      const zone = new THREE.Mesh(new THREE.PlaneGeometry(w, b.d ?? 0.5),
        new THREE.MeshBasicMaterial({ color: 0xff9f0a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      zone.rotation.x = -Math.PI / 2;
      zone.position.y = 0.012;
      g.add(bar, zone);
      g.position.set(b.x, 0, b.z);
      g.rotation.y = -(b.yaw || 0);
      this.blockGroup.add(g);
    }
  }

  showGrid(grid) {
    this.gridGroup.clear();
    const canvas = document.createElement("canvas");
    canvas.width = grid.W; canvas.height = grid.H;
    const ctx = canvas.getContext("2d"), img = ctx.createImageData(grid.W, grid.H);
    for (let i = 0; i < grid.W * grid.H; i++) {
      const k = i * 4;
      if (grid.walkableMask[i]) img.data.set([255, 255, 255, 46], k);
      else if (grid.occupiedMask[i]) img.data.set([255, 69, 58, 40], k);
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    const w = grid.W * grid.res, h = grid.H * grid.res;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    plane.rotation.x = Math.PI / 2;
    plane.scale.y = -1;
    plane.position.set(grid.x0 + w / 2, 0.008, grid.z0 + h / 2);
    this.gridGroup.add(plane);
  }
}
