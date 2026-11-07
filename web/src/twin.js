// Hybrid digital twin: clean, aligned geometry that supports the photoreal scan instead of covering it.
//   · asset condition markers: a small pin above every asset that is not healthy, constant size on screen,
//     colour = condition (healthy assets keep only their faint frame, so the picture stays calm)
//   · "Twin" overlay (toggle): drivable floor tint + 0.5 m floor grid, crisp room outline from the fitted wall and
//     floor planes, and every workbook asset as a clean low-poly outline in its condition colour (other objects only
//     get an outline on hover / selection, so 676 boxes never clutter the photo)
// Everything is built from scene.json in the canonical frame (Y up, floor y = 0), the same frame as the scan,
// object picking (Facility.pick) and the occupancy grid, so it stays aligned by construction.
import * as THREE from "three";
import { CONDITION, hexRGB } from "./semantic.js";

const pinTex = {};
function pinTexture(color) {
  if (pinTex[color]) return pinTex[color];
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fillStyle = "rgba(10,11,13,0.78)"; g.fill();
  g.lineWidth = 5; g.strokeStyle = "rgba(255,255,255,0.95)"; g.stroke();
  g.beginPath(); g.arc(32, 32, 14, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return (pinTex[color] = t);
}

/** Condition pins above every asset that is not healthy (one sprite each; ≈13 tiny quads). */
export function buildMarkers(objects) {
  const g = new THREE.Group(); g.name = "asset-markers";
  const stemPos = [];
  for (const o of objects) {
    if (!o.asset || o.asset.condition_state === "healthy") continue;   // only what needs attention: healthy = no pin
    const top = o.center[1] + o.size[1] / 2, y = Math.min(top + 0.28, 2.0);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTexture(CONDITION[o.asset.condition_state] || "#c8ccd2"), depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false }));
    s.scale.set(0.034, 0.034, 1); s.position.set(o.center[0], y, o.center[2]); s.renderOrder = 30;
    s.userData = { id: o.id, top };
    g.add(s);
    stemPos.push(o.center[0], top, o.center[2], o.center[0], y, o.center[2]);
  }
  const stems = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(stemPos, 3)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, toneMapped: false }));
  stems.renderOrder = 29; stems.frustumCulled = false;
  g.add(stems);
  return g;
}

// floor texture: drivable cells tinted, everything else clear, 0.5 m grid lines on top
function floorTexture(grid, x0, z0, w, d) {
  const px = 50;                                  // texels per metre (2 cm)
  const c = document.createElement("canvas"); c.width = Math.ceil(w * px); c.height = Math.ceil(d * px);
  const g = c.getContext("2d");
  if (grid) {
    const m = document.createElement("canvas"); m.width = grid.W; m.height = grid.H;
    const mg = m.getContext("2d"), img = mg.createImageData(grid.W, grid.H);
    for (let i = 0; i < grid.W * grid.H; i++) if (grid.walkableMask[i]) img.data.set([94, 200, 255, 70], i * 4);
    mg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(m, (grid.x0 - x0) * px, (grid.z0 - z0) * px, grid.W * grid.res * px, grid.H * grid.res * px);
  }
  g.strokeStyle = "rgba(255,255,255,0.22)"; g.lineWidth = 1.5;
  for (let x = Math.ceil(x0 * 2) / 2; x <= x0 + w; x += 0.5) { g.beginPath(); g.moveTo((x - x0) * px, 0); g.lineTo((x - x0) * px, c.height); g.stroke(); }
  for (let z = Math.ceil(z0 * 2) / 2; z <= z0 + d; z += 0.5) { g.beginPath(); g.moveTo(0, (z - z0) * px); g.lineTo(c.width, (z - z0) * px); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// wall plane (n·p = offset form as stored in scene.json: n·p + offset = 0 for the fitted plane) ∩ floor → segment
function wallSegment(pl) {
  const n = pl.normal, nh = Math.hypot(n[0], n[2]);
  const nx = n[0] / nh, nz = n[2] / nh, d = pl.offset / nh;
  // point on the line closest to the origin, direction along the wall
  const px = -nx * d, pz = -nz * d, tx = -nz, tz = nx;
  const [t0, t1] = pl.t_range || [-4, 4];
  return [[px + tx * t0, pz + tz * t0], [px + tx * t1, pz + tz * t1]];
}

/** The Twin overlay group (hidden until toggled). */
export function buildTwin(data, grid) {
  const g = new THREE.Group(); g.name = "twin"; g.visible = false;
  const b = data.bounds, x0 = b.min[0], z0 = b.min[2], w = b.max[0] - b.min[0], d = b.max[2] - b.min[2];
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: floorTexture(grid, x0, z0, w, d), transparent: true, depthWrite: false, toneMapped: false, opacity: 0.9 }));
  floor.position.set(x0 + w / 2, 0.006, z0 + d / 2); floor.renderOrder = 3;
  g.add(floor);
  // room outline: wall/floor junctions, wall tops at the ceiling, verticals at the wall ends
  const ceil = data.ceiling_y || 2.05, seg = [];
  const walls = (data.planes || []).filter((p) => p.label === "wall" && Math.abs(p.normal[1]) < 0.3);
  for (const pl of walls) {
    const [[ax, az], [bx, bz]] = wallSegment(pl);
    seg.push(ax, 0.01, az, bx, 0.01, bz, ax, ceil, az, bx, ceil, bz, ax, 0.01, az, ax, ceil, az, bx, 0.01, bz, bx, ceil, bz);
  }
  const outline = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(seg, 3)),
    new THREE.LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }));
  outline.renderOrder = 4; outline.frustumCulled = false;
  g.add(outline);
  // every workbook asset as a clean low-poly proxy outline (one draw call), in its condition colour
  const objs = data.objects.filter((o) => o.kind === "object" && o.asset);
  const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), bp = box.attributes.position.array;
  const pos = new Float32Array(objs.length * bp.length), col = new Float32Array(objs.length * bp.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), c = new THREE.Color();
  objs.forEach((o, k) => {
    m.compose(new THREE.Vector3(...o.center), q.setFromAxisAngle(up, -o.yaw), new THREE.Vector3(...o.size.map((s) => Math.max(s, 0.03))));
    const rgb = o.asset ? hexRGB(CONDITION[o.asset.condition_state] || "#c8ccd2") : [0.78, 0.86, 0.92];
    c.setRGB(...rgb, THREE.SRGBColorSpace);
    for (let i = 0; i < bp.length; i += 3) {
      v.set(bp[i], bp[i + 1], bp[i + 2]).applyMatrix4(m);
      pos.set([v.x, v.y, v.z], k * bp.length + i); col.set([c.r * (o.asset ? 1 : 0.55), c.g * (o.asset ? 1 : 0.55), c.b * (o.asset ? 1 : 0.55)], k * bp.length + i);
    }
  });
  const proxies = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)).setAttribute("color", new THREE.BufferAttribute(col, 3)),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
  proxies.renderOrder = 4; proxies.frustumCulled = false;
  g.add(proxies);
  g.userData = { floor, outline, proxies };
  return g;
}
