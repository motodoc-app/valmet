// "Clean scan" classifier: marks the haze in a Gaussian-splat scan (no three.js, so it also runs in Node tests).
// A splat counts as haze when it is
//   · outside the room box (floaters beyond the walls, under the floor or above the ceiling),
//   · [class 2, "outside"] beyond a fitted wall plane (bounds.walls, see wallClip): the wall skin and what lies behind
//     it. It is kept as its own layer but always shown: real walls are not flat, so about half of every wall's splats
//     lie 6–30 cm behind its plane, and hiding them (as the high cameras once did) took the walls out of the room.
//   · a very large, fat blob above the floor (blurry fog that smears colour over the room from a distance),
//   · a faint AND large fat blob (semi-transparent fog), or
//   · isolated and small (almost alone in its 10 cm voxel: speckle floating in the aisles).
// Works on standard 32-byte .splat records: xyz f32, scale xyz f32, rgba u8, quaternion u8.
export const HAZE = { margin: 0.3, wallMargin: 0.06, huge: 0.22, faintA: 32, faintScale: 0.035, voxel: 0.1, lonely: 2, lonelyScale: 0.03, flat: 0.2, floorBand: 0.15 };

/**
 * @param {Uint8Array} splat 32-byte records
 * @param {{min:number[], max:number[], walls?:{n:number[], d:number, s:number}[]}} bounds room box (world metres),
 *        optionally with wall planes (wallClip)
 * @returns {Uint8Array} 0 = keep, 1 = haze, 2 = beyond a wall plane (wall surface and what lies behind it)
 */
export function hazeMask(splat, bounds, opt = HAZE) {
  const n = splat.length / 32, dv = new DataView(splat.buffer, splat.byteOffset, splat.byteLength), out = new Uint8Array(n);
  const walls = bounds.walls || [];
  const m = opt.margin, lo = [bounds.min[0] - m, bounds.min[1] - 0.15, bounds.min[2] - m], hi = [bounds.max[0] + m, bounds.max[1] + m, bounds.max[2] + m];
  const v = opt.voxel, nx = Math.ceil((hi[0] - lo[0]) / v), ny = Math.ceil((hi[1] - lo[1]) / v), nz = Math.ceil((hi[2] - lo[2]) / v);
  const cells = new Uint16Array(nx * ny * nz), cell = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 32, x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
    if (x < lo[0] || y < lo[1] || z < lo[2] || x >= hi[0] || y >= hi[1] || z >= hi[2]) { out[i] = 1; cell[i] = -1; continue; }
    // provisional 2 = beyond a wall (hidden only in cut-away views); the haze rules below still win over it
    for (const w of walls) if ((w.n[0] * x + w.n[1] * y + w.n[2] * z + w.d) * w.s < -opt.wallMargin) { out[i] = 2; break; }
    const c = (((x - lo[0]) / v) | 0) + nx * ((((y - lo[1]) / v) | 0) + ny * (((z - lo[2]) / v) | 0));
    cell[i] = c;
    if (cells[c] < 65535) cells[c]++;
  }
  for (let i = 0; i < n; i++) {
    if (out[i] === 1) continue;
    const o = i * 32, a = splat[o + 27];
    const sx = dv.getFloat32(o + 12, true), sy = dv.getFloat32(o + 16, true), sz = dv.getFloat32(o + 20, true);
    const s = Math.max(sx, sy, sz);
    // flat splats are surface (floor wash, wall paint): only fat blobs above the floor band count as fog
    const blob = Math.min(sx, sy, sz) > opt.flat * s && dv.getFloat32(o + 4, true) > opt.floorBand;
    if ((blob && (s > opt.huge || (a < opt.faintA && s > opt.faintScale))) || (s < opt.lonelyScale && cells[cell[i]] <= opt.lonely)) out[i] = 1;
  }
  return out;
}

/** Wall planes of scene.json (n·p + offset = 0) with the sign of the room side, for hazeMask's bounds.walls. */
export function wallClip(planes, bounds) {
  const c = [0, 1, 2].map((a) => (bounds.min[a] + bounds.max[a]) / 2);
  return (planes || []).filter((p) => p.label === "wall").map((p) => {
    const v = p.normal[0] * c[0] + p.normal[1] * c[1] + p.normal[2] * c[2] + p.offset;
    return { n: p.normal, d: p.offset, s: Math.sign(v) || 1 };
  });
}
