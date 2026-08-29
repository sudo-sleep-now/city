import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GARBAGE_SPOTS, GRID_LINES, SIDEWALK_HEIGHT, SIDEWALK_WIDTH, lineClass } from './constants'
import { roadHalfWidth } from './planner'
import { getBinGrimeTexture, getFenceMaterial, getPitchMaterial, canvas, tex, worldUVPlane, worldUVBox } from './materials'
import type { AABB, CityMaterials, CityPlan, RoadClass } from './types'

/* ============================================================
 * Environment: trees, park contents, street furniture, shelters,
 * rail yard, city boundary — all instanced / merged.
 * ============================================================ */

export interface EnvironmentResult {
  group: THREE.Group
  colliders: AABB[]
  /** world positions of streetlight lamps (for pooled night point lights) */
  streetLights: THREE.Vector3[]
  /** rain-puddle decal sites (x, z, size) — consumed by the weather system */
  puddleSpots: { x: number; z: number; s: number }[]
  /** bench seats (ry = facing direction) — pedestrians come here to sit */
  benchSpots: { x: number; z: number; ry: number }[]
  /** bus-stop waiting spots (shelter position, facing the road) — keyed by stop id */
  stopSpots: { stopId: string; x: number; z: number; ry: number }[]
  /** per-frame animation for cranes / turbine rotors / fountain / ducks */
  animated?: (t: number) => void
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createEnvironment(plan: CityPlan, mats: CityMaterials): EnvironmentResult {
  const group = new THREE.Group()
  const colliders: AABB[] = []
  const streetLights: THREE.Vector3[] = []
  const puddleSpots: { x: number; z: number; s: number }[] = []
  const benchSpots: { x: number; z: number; ry: number }[] = []
  const stopSpots: { stopId: string; x: number; z: number; ry: number }[] = []
  const animators: ((t: number) => void)[] = []
  const rng = mulberry32(424242)

  /* ---------- helpers ---------- */
  const dummy = new THREE.Object3D()
  const makeIM = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    items: { x: number; y: number; z: number; ry?: number; s?: number; sy?: number }[],
    color?: (i: number) => THREE.Color,
    shadow = true,
  ): THREE.InstancedMesh | null => {
    if (items.length === 0) return null
    const im = new THREE.InstancedMesh(geo, mat, items.length)
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y, it.z)
      dummy.rotation.set(0, it.ry ?? 0, 0)
      const s = it.s ?? 1
      dummy.scale.set(s, it.sy ?? s, s)
      dummy.updateMatrix()
      im.setMatrixAt(i, dummy.matrix)
      if (color) im.setColorAt(i, color(i))
    })
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.castShadow = shadow
    im.receiveShadow = true
    group.add(im)
    return im
  }
  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, shadow = true) => {
    if (!geos.length) return
    const merged = mergeGeometries(geos, false)
    if (!merged) return
    const mesh = new THREE.Mesh(merged, mat)
    mesh.castShadow = shadow
    mesh.receiveShadow = true
    group.add(mesh)
    geos.forEach((g) => g.dispose())
  }
  const nearIntersection = (x: number, z: number, r = 9) =>
    GRID_LINES.some((l) => Math.abs(x - l) < r) && GRID_LINES.some((l) => Math.abs(z - l) < r)
  const nearCrosswalk = (x: number, z: number, r = 5) => plan.crosswalks.some((c) => Math.hypot(c.x - x, c.z - z) < r)
  /** signed clearance from a point to the nearest road corridor (negative = inside) */
  const distToRoadCorridor = (x: number, z: number): number => {
    let best = Infinity
    for (const r of plan.roads) {
      const hw = roadHalfWidth(r.cls, r.coord)
      if (r.axis === 'x') {
        if (x >= r.from && x <= r.to) best = Math.min(best, Math.abs(z - r.coord) - hw)
      } else {
        if (z >= r.from && z <= r.to) best = Math.min(best, Math.abs(x - r.coord) - hw)
      }
    }
    return best
  }
  /** full corridor half-width (asphalt + sidewalk band + safety margin) */
  const corridorHalf = (cls: RoadClass, coord: number) => roadHalfWidth(cls, coord) + SIDEWALK_WIDTH[cls] + 0.7
  /** true if (x,z) lies inside ANY street corridor incl. its sidewalks */
  const inCorridor = (x: number, z: number): boolean => {
    for (const r of plan.roads) {
      const m = corridorHalf(r.cls, r.coord)
      if (r.axis === 'x') {
        if (Math.abs(z - r.coord) < m && x > r.from - 2 && x < r.to + 2) return true
      } else {
        if (Math.abs(x - r.coord) < m && z > r.from - 2 && z < r.to + 2) return true
      }
    }
    return false
  }
  type Rect = { x: number; z: number; w: number; d: number }
  const cutIntervals = (ivs: [number, number][], c: number, m: number): [number, number][] => {
    const out: [number, number][] = []
    for (const [a, b] of ivs) {
      const lo = c - m
      const hi = c + m
      if (hi <= a || lo >= b) {
        out.push([a, b])
        continue
      }
      if (lo > a) out.push([a, Math.min(lo, b)])
      if (hi < b) out.push([Math.max(hi, a), b])
    }
    return out
  }
  /** split an axis-aligned rect into sub-rects that avoid ALL street corridors */
  const splitRect = (x: number, z: number, w: number, d: number): Rect[] => {
    let xs: [number, number][] = [[x - w / 2, x + w / 2]]
    let zs: [number, number][] = [[z - d / 2, z + d / 2]]
    for (const r of plan.roads) {
      const m = corridorHalf(r.cls, r.coord)
      if (r.axis === 'z') xs = cutIntervals(xs, r.coord, m)
      else zs = cutIntervals(zs, r.coord, m)
    }
    const out: Rect[] = []
    for (const [xa, xb] of xs) {
      for (const [za, zb] of zs) {
        if (xb - xa >= 2.5 && zb - za >= 2.5) out.push({ x: (xa + xb) / 2, z: (za + zb) / 2, w: xb - xa, d: zb - za })
      }
    }
    return out
  }

  /* ============================================================
   * 1. TREES — five procedural species (oak ×2, linden, birch,
   *    spruce) with faceted blob canopies, tapered trunks with
   *    root flare + limbs, per-tree foliage color (incl. autumn),
   *    mulch pits under street trees and trunk colliders.
   * ============================================================ */
  interface TreeItem { x: number; z: number; s: number; ry: number; c: THREE.Color }
  const treeOakA: TreeItem[] = []
  const treeOakB: TreeItem[] = []
  const treeLinden: TreeItem[] = []
  const treeBirch: TreeItem[] = []
  const treeConifer: TreeItem[] = []
  const treeCols: { x: number; z: number; r: number }[] = []
  /** mulch pits sit only under paved-surface trees (y = sidewalk/paver top + ε) */
  const treePits: { x: number; z: number; y: number }[] = []
  const summerGreens = ['#4e7c3a', '#5d8f45', '#6f9c4a', '#4a7248', '#557f33', '#7fa34e'].map((c) => new THREE.Color(c))
  const autumnSet = ['#b0602c', '#c9862f', '#d4a93c', '#9c8a33'].map((c) => new THREE.Color(c))
  const coniferGreens = ['#3d6134', '#2f5730', '#48703b'].map((c) => new THREE.Color(c))
  const birchGreens = ['#7fa04e', '#8fae56', '#a9b23f', '#c9b03c'].map((c) => new THREE.Color(c))
  const pickGreen = (i: number) => summerGreens[(i * 7 + 3) % summerGreens.length]
  // white birch bark — pale base with dark horizontal lenticel dashes
  const birchBarkMat = (() => {
    const [bc, bctx] = canvas(64, 128)
    bctx.fillStyle = '#e9e5da'
    bctx.fillRect(0, 0, 64, 128)
    const brng = mulberry32(31)
    for (let i = 0; i < 60; i++) {
      bctx.fillStyle = brng() < 0.7 ? '#2e2a26' : '#8a857a'
      const bx = brng() * 64
      const by = brng() * 128
      const bw = 2 + brng() * 7
      bctx.fillRect(bx, by, bw, 1 + brng() * 2.2)
      if (brng() < 0.35) {
        bctx.fillStyle = '#d5d0c2'
        bctx.fillRect(brng() * 64, brng() * 128, 4 + brng() * 10, 3 + brng() * 6)
      }
    }
    const t = tex(bc)
    t.repeat.set(2, 2)
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 })
  })()
  const addTree = (x: number, z: number, conifer = false, s = 0.85 + rng() * 0.5) => {
    const it: TreeItem = { x, z, s, ry: rng() * Math.PI * 2, c: summerGreens[0] }
    if (conifer || rng() < 0.2) {
      it.c = coniferGreens[(rng() * coniferGreens.length) | 0]
      treeConifer.push(it)
      treeCols.push({ x, z, r: 0.22 * s })
    } else {
      const r = rng()
      // ~15% of broadleaf stock turns each its own autumn shade
      it.c = rng() < 0.15 ? autumnSet[(rng() * autumnSet.length) | 0] : summerGreens[(rng() * summerGreens.length) | 0]
      if (r < 0.16) {
        it.c = rng() < 0.3 ? birchGreens[3] : birchGreens[(rng() * birchGreens.length) | 0]
        treeBirch.push(it)
        treeCols.push({ x, z, r: 0.17 * s })
      } else if (r < 0.42) {
        treeLinden.push(it)
        treeCols.push({ x, z, r: 0.26 * s })
      } else if (r < 0.72) {
        treeOakA.push(it)
        treeCols.push({ x, z, r: 0.3 * s })
      } else {
        treeOakB.push(it)
        treeCols.push({ x, z, r: 0.3 * s })
      }
    }
  }

  // street trees along arterials & collectors (both sides), locals alternating
  for (const road of plan.roads) {
    if (road.pedestrianOnly) continue
    const hw = roadHalfWidth(road.cls, road.coord)
    const spacing = road.cls === 'local' ? 32 : 24
    for (let pos = road.from + 14; pos < road.to - 14; pos += spacing) {
      const sides = road.cls === 'local' ? (Math.floor(pos / spacing) % 2 === 0 ? [1] : [-1]) : [1, -1]
      for (const s of sides) {
        const off = hw + 2.6
        const x = road.axis === 'x' ? pos : road.coord + s * off
        const z = road.axis === 'x' ? road.coord + s * off : pos
        if (nearIntersection(road.axis === 'x' ? pos : road.coord, road.axis === 'x' ? road.coord : pos, 11)) continue
        if (nearCrosswalk(x, z)) continue
        // keep the station forecourt clear
        if (x > 14 && x < 86 && z < -94 && z > -138) continue
        // Fire Station 1 forecourt (330,-27) — no street trees in the pull-out
        if (x > 300 && x < 362 && z > -14 && z < 0) continue
        addTree(x, z, road.cls !== 'local' && rng() < 0.3)
        treePits.push({ x, z, y: SIDEWALK_HEIGHT + 0.015 })
      }
    }
  }
  // pedestrian street tree rows (car-free street runs along z=100, paver top ≈ 0.1)
  for (let x = -190; x <= 190; x += 13) {
    addTree(x, 100 - 2.9, false, 0.7 + rng() * 0.3)
    addTree(x, 100 + 2.9, false, 0.7 + rng() * 0.3)
    treePits.push({ x, z: 100 - 2.9, y: 0.121 })
    treePits.push({ x, z: 100 + 2.9, y: 0.121 })
  }

  // park trees
  const inParkRect = (p: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number, m = 4) =>
    x > p.x0 + m && x < p.x1 - m && z > p.z0 + m && z < p.z1 - m
  for (const park of plan.parks) {
    if (park.kind === 'central-park') {
      for (let i = 0; i < 115; i++) {
        const x = park.x0 + 6 + rng() * (park.x1 - park.x0 - 12)
        const z = park.z0 + 6 + rng() * (park.z1 - park.z0 - 12)
        // avoid pond, path lines and every street corridor
        if (Math.hypot((x + 73) / 22, (z + 364) / 14) < 1.5) continue
        if (Math.abs(x + 55) < 4.5 || Math.abs(x - 55) < 4.5) continue
        if (Math.abs(z + 345) < 4.5 || Math.abs(z + 255) < 4.5) continue
        if (inCorridor(x, z)) continue
        addTree(x, z, rng() < 0.25)
      }
    } else if (park.kind === 'pocket-park') {
      for (let i = 0; i < 24; i++) {
        addTree(park.x0 + 8 + rng() * 84, park.z0 + 8 + rng() * 84, rng() < 0.2)
      }
    } else if (park.kind === 'sports') {
      for (let i = 0; i < 26; i++) {
        const edge = rng()
        let x: number, z: number
        if (edge < 0.5) { x = park.x0 + 3 + rng() * 8; z = park.z0 + rng() * 100 } else { x = park.x0 + 90 + rng() * 7; z = park.z0 + rng() * 100 }
        addTree(x, z, true)
      }
    } else if (park.kind === 'garden') {
      for (let i = 0; i < 8; i++) addTree(205 + (i % 4) * 30, 208 + Math.floor(i / 4) * 84, false, 0.8)
    }
  }
  // school yard trees
  for (const [sx, sz] of [[-252, -266], [252, -266], [-252, 338]]) {
    for (let i = 0; i < 12; i++) {
      const x = sx - 32 + rng() * 64
      const z = sz + 16 + (i < 6 ? 6 : 34) + rng() * 4
      addTree(x, z, false, 0.7)
    }
  }
  // industrial buffer (double conifer rows)
  for (let z = 305; z < 600; z += 7) {
    addTree(292, z, true, 0.9 + rng() * 0.4)
    addTree(289, z, true, 0.9 + rng() * 0.4)
  }
  for (let x = 305; x < 600; x += 7) {
    addTree(x, 292, true, 0.9 + rng() * 0.4)
    addTree(x, 289, true, 0.9 + rng() * 0.4)
  }
  // low-density front yard trees
  for (const b of plan.blocks) {
    if (b.zone !== 'residential-low') continue
    for (let i = 0; i < 4; i++) {
      addTree(b.x0 + 12 + rng() * 76, b.z0 + (i < 2 ? 6 : 94) + rng() * 4, false, 0.6 + rng() * 0.3)
    }
  }

  /* ---- tree geometry factory ----
   * All parts go through toNonIndexed() so Icosahedron blobs (already
   * non-indexed) merge cleanly with cones/cylinders; canopy blobs get a
   * vertex jitter so no two shell faces read as perfect spheres. */
  const NI = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g)
  const jitter = (geo: THREE.BufferGeometry, j: number) => {
    const p = geo.attributes.position
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i) + (rng() - 0.5) * j, p.getY(i) + (rng() - 0.5) * j, p.getZ(i) + (rng() - 0.5) * j)
    }
    geo.computeVertexNormals()
    return geo
  }
  /** slanted branch stub reaching into the canopy */
  const limb = (r: number, len: number, y: number, tilt: number, az: number) =>
    NI(new THREE.CylinderGeometry(r * 0.55, r, len, 5)).translate(0, len / 2, 0).rotateZ(tilt).rotateY(az).translate(0, y, 0)
  const blob = (r: number, x: number, y: number, z: number) => NI(new THREE.IcosahedronGeometry(r, 1)).translate(x, y, z)
  const flare = (rB: number) => NI(new THREE.CylinderGeometry(rB * 0.84, rB, 0.52, 7)).translate(0, 0.24, 0)
  const mergeParts = (parts: THREE.BufferGeometry[], j: number) => {
    const m = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false)!
    parts.forEach((g) => g.dispose())
    return j > 0 ? jitter(m, j) : m
  }

  // OAK A — tall woods oak: 5-blob crown on a flared trunk with 3 limbs
  const canopyOakA = mergeParts(
    [blob(2.05, 0, 4.35, 0), blob(1.35, 1.15, 3.85, 0.55), blob(1.3, -1.05, 4.0, -0.55), blob(1.2, 0.15, 5.5, -0.35), blob(1.05, -0.55, 5.1, 0.8)],
    0.24,
  )
  const trunkOakA = mergeParts(
    [
      NI(new THREE.CylinderGeometry(0.17, 0.36, 2.8, 7)).translate(0, 1.4, 0),
      flare(0.46),
      limb(0.09, 1.7, 2.2, 0.65, 0.4),
      limb(0.08, 1.5, 2.4, 0.7, 2.5),
      limb(0.07, 1.3, 2.6, 0.8, 4.4),
    ],
    0,
  )
  // OAK B — broad spreading pasture oak: wider, squatter crown
  const canopyOakB = mergeParts(
    [blob(1.8, 0, 3.7, 0), blob(1.5, 1.5, 3.5, 0.2), blob(1.45, -1.5, 3.55, -0.2), blob(1.3, 0.7, 4.6, -0.9), blob(1.25, -0.8, 4.55, 0.95), blob(1.0, 0.1, 5.3, 0.1)],
    0.26,
  )
  const trunkOakB = mergeParts(
    [
      NI(new THREE.CylinderGeometry(0.15, 0.33, 2.3, 7)).translate(0, 1.15, 0),
      flare(0.44),
      limb(0.08, 1.9, 1.9, 0.85, 0.9),
      limb(0.08, 1.8, 2.0, 0.9, 3.4),
      limb(0.07, 1.5, 2.2, 0.7, 5.3),
      limb(0.06, 1.3, 2.1, 1.0, 1.6),
    ],
    0,
  )
  // LINDEN — the neat street tree: clean tall trunk, tight rounded crown
  const canopyLinden = mergeParts(
    [
      (() => { const b = blob(2.0, 0, 0, 0); b.scale(1, 0.92, 1); b.translate(0, 4.55, 0); return b })(),
      blob(1.15, 0.1, 5.9, -0.1),
      blob(0.95, -0.7, 5.6, 0.5),
    ],
    0.17,
  )
  const trunkLinden = mergeParts(
    [NI(new THREE.CylinderGeometry(0.14, 0.27, 3.1, 7)).translate(0, 1.55, 0), flare(0.36), limb(0.06, 1.1, 2.9, 0.75, 1.8), limb(0.06, 1.1, 3.0, 0.7, 4.6)],
    0,
  )
  // BIRCH — slender white stem, small airy crown
  const canopyBirch = mergeParts([blob(1.05, 0, 4.35, 0), blob(0.85, 0.55, 3.9, 0.4), blob(0.8, -0.5, 4.6, -0.3)], 0.2)
  const trunkBirch = mergeParts(
    [NI(new THREE.CylinderGeometry(0.09, 0.16, 3.6, 7)).translate(0, 1.8, 0), limb(0.045, 0.9, 2.6, 0.9, 0.7), limb(0.04, 0.8, 3.0, 0.85, 3.9)],
    0,
  )
  // SPRUCE — four stacked tiers + spike (open bases where hidden)
  const canopyConifer = mergeParts(
    [
      NI(new THREE.ConeGeometry(1.85, 2.5, 9, 1, true)).translate(0, 2.3, 0),
      NI(new THREE.ConeGeometry(1.5, 2.3, 9, 1, true)).translate(0, 3.75, 0),
      NI(new THREE.ConeGeometry(1.1, 2.1, 9, 1, true)).translate(0, 5.05, 0),
      NI(new THREE.ConeGeometry(0.72, 1.8, 8)).translate(0, 6.3, 0),
      NI(new THREE.ConeGeometry(0.3, 1.1, 7)).translate(0, 7.5, 0),
    ],
    0.14,
  )
  const trunkConifer = NI(new THREE.CylinderGeometry(0.11, 0.22, 2.5, 6)).translate(0, 1.25, 0)

  const foliageMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true })
  const makeTreeIM = (canopy: THREE.BufferGeometry, trunk: THREE.BufferGeometry, items: TreeItem[], trunkMat: THREE.Material) => {
    makeIM(trunk, trunkMat, items.map((t) => ({ x: t.x, y: 0, z: t.z, ry: t.ry, s: t.s })))
    makeIM(canopy, foliageMat, items.map((t) => ({ x: t.x, y: 0, z: t.z, ry: t.ry, s: t.s })), (i) => items[i].c)
  }
  makeTreeIM(canopyOakA, trunkOakA, treeOakA, mats.trunk)
  makeTreeIM(canopyOakB, trunkOakB, treeOakB, mats.trunk)
  makeTreeIM(canopyLinden, trunkLinden, treeLinden, mats.trunk)
  makeTreeIM(canopyBirch, trunkBirch, treeBirch, birchBarkMat)
  makeTreeIM(canopyConifer, trunkConifer, treeConifer, mats.trunk)

  // mulch pits under paved-surface street trees (thin dark disc, just above the slab)
  if (treePits.length) {
    const [mc, mctx] = canvas(64, 64)
    mctx.fillStyle = '#3b3128'
    mctx.fillRect(0, 0, 64, 64)
    const mrng = mulberry32(99)
    for (let i = 0; i < 130; i++) {
      mctx.globalAlpha = 0.25 + mrng() * 0.4
      mctx.fillStyle = mrng() < 0.5 ? '#2c241d' : '#57482f'
      mctx.beginPath()
      mctx.arc(mrng() * 64, mrng() * 64, 0.6 + mrng() * 1.8, 0, Math.PI * 2)
      mctx.fill()
    }
    mctx.globalAlpha = 1
    const mulchMat = new THREE.MeshStandardMaterial({ map: tex(mc), roughness: 1 })
    makeIM(NI(new THREE.CircleGeometry(0.82, 12)).rotateX(-Math.PI / 2), mulchMat, treePits, undefined, false)
  }
  // trunk colliders — walk into a tree, slide around it
  for (const t of treeCols) colliders.push({ minX: t.x - t.r, maxX: t.x + t.r, minZ: t.z - t.r, maxZ: t.z + t.r, h: 3 })

  /* ============================================================
   * 2. STREET FURNITURE
   * ============================================================ */

  // --- streetlights (cobra-head: pole on the curb, arm reaching over the road) ---
  const slItems: { x: number; z: number; ry: number }[] = []
  for (const road of plan.roads) {
    if (road.pedestrianOnly) continue
    const hw = roadHalfWidth(road.cls, road.coord)
    for (let pos = road.from + 15; pos < road.to - 15; pos += 30) {
      for (const s of [-1, 1]) {
        const off = hw + 1.0
        const x = road.axis === 'x' ? pos : road.coord + s * off
        const z = road.axis === 'x' ? road.coord + s * off : pos
        if (nearIntersection(road.axis === 'x' ? pos : road.coord, road.axis === 'x' ? road.coord : pos, 12)) continue
        // arm geometry extends toward −Z locally; rotate it to point at the road centerline
        const ry = road.axis === 'x' ? (s > 0 ? 0 : Math.PI) : s > 0 ? Math.PI / 2 : -Math.PI / 2
        slItems.push({ x, z, ry })
      }
    }
  }
  makeIM(new THREE.CylinderGeometry(0.09, 0.13, 7, 6), mats.poleMetal, slItems.map((p) => ({ x: p.x, y: 3.5, z: p.z })))
  const armGeo = new THREE.BoxGeometry(0.09, 0.09, 1.7).translate(0, 0, -0.85)
  makeIM(armGeo, mats.poleMetal, slItems.map((p) => ({ x: p.x, y: 6.9, z: p.z, ry: p.ry })), undefined, false)
  // head hangs at the arm tip, long axis parallel to the road
  const slHeads = slItems.map((p) => ({ x: p.x - Math.sin(p.ry) * 1.55, y: 6.76, z: p.z - Math.cos(p.ry) * 1.55, ry: p.ry }))
  makeIM(new THREE.BoxGeometry(0.56, 0.13, 0.26), mats.streetlightHead, slHeads, undefined, false)
  for (const h of slHeads) streetLights.push(new THREE.Vector3(h.x, 6.42, h.z))

  // --- benches ---
  const benchWood: { x: number; y: number; z: number; ry: number }[] = []
  const benchMetal: { x: number; y: number; z: number; ry: number }[] = []
  const addBench = (x: number, z: number, ry: number) => {
    benchWood.push({ x, y: 0.48, z, ry })
    benchMetal.push({ x, y: 0.22, z, ry })
    benchSpots.push({ x, z, ry })
  }
  // central park benches at the four path-node plazas + pond + playground
  for (const [nx, nz] of [[-55, -345], [55, -345], [-55, -255], [55, -255]] as const) {
    addBench(nx - 8, nz, Math.PI / 2)
    addBench(nx + 8, nz, -Math.PI / 2)
    addBench(nx, nz - 8, Math.PI)
  }
  addBench(-73, -349, Math.PI) // pond overlook
  addBench(-64, -224, 0) // playground
  // plaza benches
  for (const [bx, bz, br] of [[20, -40, 0], [60, -40, 0], [20, -60, Math.PI], [60, -60, Math.PI], [40, -20, 0]] as const) addBench(bx, bz, br)
  // pocket park benches
  for (const p of plan.parks) {
    if (p.kind !== 'pocket-park') continue
    addBench(p.x0 + 50 - 8, p.z0 + 50, 0)
    addBench(p.x0 + 50 + 8, p.z0 + 50, Math.PI)
    addBench(p.x0 + 50, p.z0 + 50 - 10, 0)
  }
  // pedestrian street benches (car-free street along z=100)
  for (let x = -170; x <= 170; x += 68) {
    addBench(x, 96.2, 0)
    addBench(x + 30, 103.8, Math.PI)
  }
  // sports park
  addBench(-45, 325, 0)
  addBench(-55, 325, 0)
  addBench(-45, 375, Math.PI)
  addBench(-55, 375, Math.PI)
  makeIM(
    mergeGeometries([new THREE.BoxGeometry(1.8, 0.07, 0.45), new THREE.BoxGeometry(1.8, 0.5, 0.06).translate(0, 0.3, -0.22)], false)!,
    mats.wood,
    benchWood,
  )
  makeIM(
    mergeGeometries(
      [new THREE.BoxGeometry(0.06, 0.44, 0.4).translate(-0.8, 0, 0), new THREE.BoxGeometry(0.06, 0.44, 0.4).translate(0.8, 0, 0)],
      false,
    )!,
    mats.metalDark,
    benchMetal,
  )

  // --- trash, bike racks & bus shelters (shelters attach their trash + racks) ---
  const trash: { x: number; y: number; z: number }[] = []
  const rackGeo = mergeGeometries(
    [new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6).translate(0, 0.35, -0.35), new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6).translate(0, 0.35, 0.35), new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6).rotateX(Math.PI / 2).translate(0, 0.7, 0)],
    false,
  )!
  const racks: { x: number; y: number; z: number; ry: number }[] = []
  const bikes: { x: number; y: number; z: number; ry: number }[] = []
  const addRack = (x: number, z: number, ry: number) => {
    for (let i = 0; i < 4; i++) {
      const ox = (i - 1.5) * 0.9
      racks.push({ x: x + Math.cos(ry) * ox, y: 0, z: z - Math.sin(ry) * ox, ry })
      if (rng() < 0.55) bikes.push({ x: x + Math.cos(ry) * ox + 0.4, y: 0, z: z - Math.sin(ry) * ox, ry: ry + Math.PI / 2 + (rng() - 0.5) * 0.3 })
    }
  }
  const shelterRoof: { x: number; y: number; z: number; ry: number }[] = []
  const shelterBack: { x: number; y: number; z: number; ry: number }[] = []
  const shelterPost: { x: number; y: number; z: number }[] = []
  for (const s of plan.stops) {
    if (s.mode !== 'bus') continue
    // travel direction from the first route serving this stop
    let dx = 0
    let dz = 1
    for (const r of plan.routes) {
      if (!r.stopIds.includes(s.id)) continue
      const pts = r.points
      let bestD = Infinity
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 1
        const ux = (b.x - a.x) / segLen
        const uz = (b.z - a.z) / segLen
        const t = Math.max(0, Math.min(segLen, (s.x - a.x) * ux + (s.z - a.z) * uz))
        const d = Math.hypot(s.x - (a.x + ux * t), s.z - (a.z + uz * t))
        if (d < bestD) {
          bestD = d
          dx = ux
          dz = uz
        }
      }
      break
    }
    // nearest road to offset the shelter onto the curb
    let bestRoad = plan.roads[0]
    let bestD = Infinity
    for (const r of plan.roads) {
      if (r.pedestrianOnly) continue
      const d = r.axis === 'x' ? Math.abs(r.coord - s.z) : Math.abs(r.coord - s.x)
      const along = r.axis === 'x' ? s.x > r.from && s.x < r.to : s.z > r.from && s.z < r.to
      if (along && d < bestD) {
        bestD = d
        bestRoad = r
      }
    }
    const hw = roadHalfWidth(bestRoad.cls, bestRoad.coord) + 2.0
    // curb side = right-hand side of the travel direction (matches lane offsets)
    const side = bestRoad.axis === 'x' ? (dx >= 0 ? 1 : -1) : dz >= 0 ? -1 : 1
    let bx = bestRoad.axis === 'x' ? s.x : bestRoad.coord + side * hw
    let bz = bestRoad.axis === 'x' ? bestRoad.coord + side * hw : s.z
    // nudge along the travel direction until clear of every road corridor
    for (let n = 0; n < 14 && distToRoadCorridor(bx, bz) < 0.5; n++) {
      bx += dx * 2
      bz += dz * 2
    }
    if (distToRoadCorridor(bx, bz) < 0.3) continue // never leave furniture on the asphalt
    const ry = bestRoad.axis === 'x' ? (side > 0 ? 0 : Math.PI) : side > 0 ? Math.PI / 2 : -Math.PI / 2
    shelterRoof.push({ x: bx, y: 2.45, z: bz, ry })
    shelterBack.push({ x: bx - Math.sin(ry) * 0.55, y: 1.15, z: bz - Math.cos(ry) * 0.55, ry })
    shelterPost.push({ x: bx - Math.sin(ry) * 1.6, y: 1.2, z: bz - Math.cos(ry) * 1.6 })
    shelterPost.push({ x: bx + Math.sin(ry) * 1.6, y: 1.2, z: bz + Math.cos(ry) * 1.6 })
    addBench(bx, bz - Math.cos(ry) * 0.2, ry + Math.PI)
    trash.push({ x: bx + Math.cos(ry) * 2.7, y: 0.45, z: bz - Math.sin(ry) * 2.7 })
    addRack(bx - Math.cos(ry) * 3.6, bz + Math.sin(ry) * 3.6, ry)
    stopSpots.push({ stopId: s.id, x: bx, z: bz, ry })
  }
  makeIM(new THREE.BoxGeometry(4.4, 0.12, 1.7), mats.metal, shelterRoof, undefined, false)
  makeIM(new THREE.BoxGeometry(4.0, 2.2, 0.1), mats.glassDark, shelterBack, undefined, false)
  makeIM(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), mats.metalDark, shelterPost, undefined, false)

  // --- trash cans (fixed spots; stop-side cans are added by the shelter loop) ---
  for (const [tx, tz] of [[-18, -306], [42, -294], [30, -50], [70, -50], [13, -105], [-30, 100], [30, 200], [-50, 350], [250, 240], [106, -120]] as const) {
    trash.push({ x: tx, y: 0.45, z: tz })
  }
  makeIM(new THREE.CylinderGeometry(0.28, 0.24, 0.8, 8), mats.black, trash, undefined, false)

  // --- bollards (car-free street gates + plaza corners) ---
  const bollards: { x: number; y: number; z: number }[] = []
  for (const sx of [-209, 209]) {
    for (let j = -2; j <= 2; j++) bollards.push({ x: sx, y: 0.5, z: 100 + j * 1.7 })
  }
  for (const [bx, bz] of [
    [14, -14],
    [86, -14],
    [14, -86],
    [86, -86],
  ] as const) bollards.push({ x: bx, y: 0.5, z: bz })
  makeIM(new THREE.CylinderGeometry(0.13, 0.15, 1.0, 8), mats.metalDark, bollards, undefined, false)

  // --- fire hydrants — curb-side on every vehicular street, alternating
  //     sides ~90 m apart; sit ON the sidewalk slab (the old ones floated
  //     at y=0.35 and glowed: neonRed emissive) ---
  const hydrants: { x: number; y: number; z: number; ry: number }[] = []
  for (const road of plan.roads) {
    if (road.pedestrianOnly) continue
    const hw = roadHalfWidth(road.cls, road.coord)
    const off = hw + 0.9 // against the curb, fully on the sidewalk (SW ≥ 3.5)
    let n = 0
    for (let pos = road.from + 22; pos < road.to - 22; pos += 88, n++) {
      const side = n % 2 === 0 ? 1 : -1
      const x = road.axis === 'x' ? pos : road.coord + side * off
      const z = road.axis === 'x' ? road.coord + side * off : pos
      if (nearIntersection(x, z, 12)) continue
      if (nearCrosswalk(x, z, 4.5)) continue
      if (x > 14 && x < 86 && z < -94 && z > -138) continue // station forecourt
      if (x > 300 && x < 362 && z > -12 && z < 0) continue // Fire Station 1 apron
      if (stopSpots.some((s) => Math.hypot(s.x - x, s.z - z) < 3.5)) continue // keep stops clear
      hydrants.push({ x, y: SIDEWALK_HEIGHT, z, ry: rng() * Math.PI * 2 })
    }
  }
  if (hydrants.length) {
    const hydrantRedMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.52, metalness: 0.22 })
    const hydrantBrassMat = new THREE.MeshStandardMaterial({ color: '#9c7c33', roughness: 0.38, metalness: 0.82 })
    const hRed = new THREE.Color('#a8322a')
    // body: curb flange + barrel + domed bonnet + 3 nozzle stubs (painted red)
    const hydrantBodyGeo = mergeGeometries(
      [
        NI(new THREE.CylinderGeometry(0.2, 0.235, 0.1, 10)).translate(0, 0.05, 0),
        NI(new THREE.CylinderGeometry(0.13, 0.148, 0.5, 10)).translate(0, 0.35, 0),
        NI(new THREE.SphereGeometry(0.15, 10, 8)).scale(1, 0.78, 1).translate(0, 0.6, 0),
        NI(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 8)).rotateZ(Math.PI / 2).translate(-0.175, 0.42, 0),
        NI(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 8)).rotateZ(Math.PI / 2).translate(0.175, 0.42, 0),
        NI(new THREE.CylinderGeometry(0.065, 0.065, 0.09, 8)).rotateX(Math.PI / 2).translate(0, 0.4, 0.18),
      ],
      false,
    )!
    // hardware: pentagonal operating nut + cap discs + flange bolts (brass)
    const hydrantBrassGeo = mergeGeometries(
      [
        NI(new THREE.CylinderGeometry(0.034, 0.045, 0.07, 5)).translate(0, 0.735, 0),
        NI(new THREE.CylinderGeometry(0.048, 0.048, 0.02, 8)).rotateZ(Math.PI / 2).translate(-0.225, 0.42, 0),
        NI(new THREE.CylinderGeometry(0.048, 0.048, 0.02, 8)).rotateZ(Math.PI / 2).translate(0.225, 0.42, 0),
        NI(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 8)).rotateX(Math.PI / 2).translate(0, 0.4, 0.235),
        ...[45, 135, 225, 315].map((a) =>
          NI(new THREE.CylinderGeometry(0.028, 0.028, 0.06, 6))
            .translate(0, 0.09, 0)
            .rotateY((a * Math.PI) / 180)
            .translate(Math.sin((a * Math.PI) / 180) * 0.185, 0, Math.cos((a * Math.PI) / 180) * 0.185),
        ),
      ],
      false,
    )!
    makeIM(hydrantBodyGeo, hydrantRedMat, hydrants, (i) => new THREE.Color(hRed).offsetHSL(0, 0, ((i * 13) % 5) * 0.012), true)
    makeIM(hydrantBrassGeo, hydrantBrassMat, hydrants, undefined, false)
    for (const h of hydrants) colliders.push({ minX: h.x - 0.24, maxX: h.x + 0.24, minZ: h.z - 0.24, maxZ: h.z + 0.24, h: 1 })
  }

  // --- bike racks + bicycles (declared above; fixed placements here) ---
  addRack(-20, -20, Math.PI / 2) // plaza
  addRack(-80, -30, 0) // market front
  for (const [sx, sz] of [[-252, -266], [252, -266], [-252, 338]]) addRack(sx + 20, sz + 22, 0)
  makeIM(rackGeo, mats.metalDark, racks, undefined, false)
  const bikeGeo = mergeGeometries(
    [
      new THREE.TorusGeometry(0.34, 0.035, 6, 14).rotateY(Math.PI / 2).translate(0, 0.34, 0.42),
      new THREE.TorusGeometry(0.34, 0.035, 6, 14).rotateY(Math.PI / 2).translate(0, 0.34, -0.42),
      new THREE.BoxGeometry(0.05, 0.05, 0.9).translate(0, 0.55, 0),
      new THREE.BoxGeometry(0.05, 0.4, 0.05).translate(0, 0.42, -0.5),
      new THREE.BoxGeometry(0.05, 0.05, 0.4).translate(0, 0.8, -0.55),
    ],
    false,
  )!
  makeIM(bikeGeo, mats.metalDark, bikes, (i) => new THREE.Color(['#c94f3d', '#4a8c5c', '#d8a832', '#9a9da1'][i % 4]), false)

  // --- tram stop platforms + canopies ---
  // T1 runs along x=0 (platform flanks east of the track),
  // T2 runs along z=0 (platform flanks south of the track).
  const platformGeos: THREE.BufferGeometry[] = []
  const canopyPosts: { x: number; y: number; z: number }[] = []
  const canopyRoofs: { x: number; y: number; z: number; ry: number }[] = []
  for (const s of plan.stops) {
    if (s.mode !== 'tram') continue
    const isT1 = s.routeIds.includes('T1')
    const isT2 = s.routeIds.includes('T2')
    if (!isT1 && !isT2) continue
    // platform center: 4.2 m from track centerline — clear of the near
    // double-track (trams run at ±1.6 m, body half-width 1.15 → near edge 2.75)
    const cx = isT1 ? 4.2 : s.x
    const cz = isT1 ? s.z : 4.2
    const alongX = isT2 // platform long axis
    const plat = new THREE.BoxGeometry(alongX ? 9 : 2.2, 0.28, alongX ? 2.2 : 9)
    plat.translate(cx, 0.14, cz)
    platformGeos.push(plat)
    canopyRoofs.push({ x: cx, y: 2.8, z: cz, ry: alongX ? 0 : Math.PI / 2 })
    canopyPosts.push({ x: cx + (alongX ? 3.4 : 0), y: 1.4, z: cz + (alongX ? 0 : 3.4) })
    canopyPosts.push({ x: cx - (alongX ? 3.4 : 0), y: 1.4, z: cz - (alongX ? 0 : 3.4) })
    // sign on the platform end
    const sx2 = cx + (alongX ? 4.9 : 1.5)
    const sz2 = cz + (alongX ? 1.5 : 4.9)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3, 6), mats.metalDark)
    pole.position.set(sx2, 1.5, sz2)
    group.add(pole)
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.08), mats.neonAmber)
    board.position.set(sx2, 3.1, sz2)
    group.add(board)
  }
  addMerged(platformGeos, mats.concreteLight, false)
  makeIM(new THREE.BoxGeometry(5.4, 0.1, 2.0), mats.fabricGreen, canopyRoofs, undefined, false)
  makeIM(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 6), mats.metalDark, canopyPosts, undefined, false)

  // --- planters (plaza + ped street) ---
  const planterBoxes: { x: number; y: number; z: number }[] = []
  const bushes: { x: number; y: number; z: number; s: number }[] = []
  for (const [px, pz] of [[12, -12], [12, -88], [88, -88], [40, -70], [60, -30], [88, -30]] as const) {
    planterBoxes.push({ x: px, y: 0.3, z: pz })
    bushes.push({ x: px, y: 0.75, z: pz, s: 0.55 })
  }
  for (let x = -180; x <= 180; x += 26) {
    planterBoxes.push({ x, y: 0.3, z: 95.5 })
    bushes.push({ x, y: 0.75, z: 95.5, s: 0.5 })
  }
  makeIM(new THREE.BoxGeometry(1.3, 0.6, 1.3), mats.planter, planterBoxes, undefined, false)
  makeIM(new THREE.SphereGeometry(0.6, 7, 5), foliageMat, bushes, pickGreen, false)

  // --- park & plaza lanterns (globe on a post — glows at night, feeds the pooled lights) ---
  const lanternPosts: { x: number; y: number; z: number }[] = []
  const lanternGlobes: { x: number; y: number; z: number }[] = []
  const addLantern = (x: number, z: number) => {
    if (inCorridor(x, z)) return
    lanternPosts.push({ x, y: 0, z })
    lanternGlobes.push({ x, y: 3.16, z })
    streetLights.push(new THREE.Vector3(x, 2.9, z))
  }
  // one lantern pair per park node plaza
  for (const [nx, nz] of [[-55, -345], [55, -345], [-55, -255], [55, -255]] as const) {
    addLantern(nx - 7.5, nz - 7.5)
    addLantern(nx + 7.5, nz + 7.5)
  }
  // civic plaza + pedestrian street
  for (const [lx, lz] of [[20, -20], [80, -20], [20, -80], [80, -80], [40, -50], [62, -50], [-20, 96.5], [20, 96.5], [-60, 103.5], [60, 103.5]] as const) addLantern(lx, lz)
  makeIM(
    mergeGeometries(
      [
        new THREE.CylinderGeometry(0.055, 0.085, 2.9, 6).translate(0, 1.45, 0),
        new THREE.CylinderGeometry(0.05, 0.05, 0.22, 6).translate(0, 3.0, 0),
      ],
      false,
    )!,
    mats.poleMetal,
    lanternPosts,
    undefined,
    false,
  )
  makeIM(new THREE.SphereGeometry(0.21, 10, 8), mats.streetlightHead, lanternGlobes, undefined, false)

  // --- utility poles on locals ---
  const utilPoles: { x: number; y: number; z: number }[] = []
  const utilArms: { x: number; y: number; z: number; ry: number }[] = []
  for (const road of plan.roads) {
    if (road.cls !== 'local' || road.pedestrianOnly) continue
    const hw = roadHalfWidth('local', road.coord)
    for (let pos = road.from + 50; pos < road.to - 50; pos += 100) {
      const x = road.axis === 'x' ? pos : road.coord + (hw + 1.3)
      const z = road.axis === 'x' ? road.coord + (hw + 1.3) : pos
      utilPoles.push({ x, y: 4, z })
      utilArms.push({ x, y: 7.4, z, ry: road.axis === 'x' ? 0 : Math.PI / 2 })
    }
  }
  makeIM(new THREE.CylinderGeometry(0.09, 0.13, 8, 6), mats.wood, utilPoles)
  makeIM(new THREE.BoxGeometry(0.07, 0.07, 1.6), mats.wood, utilArms, undefined, false)

  /* ============================================================
   * 3. PARK CONTENTS
   * ============================================================ */

  const pathGeos: THREE.BufferGeometry[] = []
  const lawnGeos: THREE.BufferGeometry[] = []
  const detailGeos = new Map<THREE.Material, THREE.BufferGeometry[]>()
  const pushDetail = (mat: THREE.Material, geo: THREE.BufferGeometry) => {
    if (!detailGeos.has(mat)) detailGeos.set(mat, [])
    detailGeos.get(mat)!.push(geo)
  }
  const pathPlane = (x: number, z: number, w: number, d: number) => {
    const g = new THREE.PlaneGeometry(w, d)
    g.rotateX(-Math.PI / 2)
    worldUVPlane(g, w, d, 3)
    g.translate(x, 0.03, z)
    pathGeos.push(g)
  }

  // ---- Central Park (x -100..100, z -400..-200) ----
  // The x=0 tram avenue and the z=-300 street cross the park, splitting it
  // into 4 quadrants. Paths live INSIDE the quadrants and meet the streets
  // only at the crosswalks — nothing is ever painted onto asphalt.
  const parkPaths: [number, number, number, number][] = [
    [-55, -346, 3.4, 74], [55, -346, 3.4, 74], // north quadrants, N–S
    [-55, -254, 3.4, 74], [55, -254, 3.4, 74], // south quadrants, N–S
    [-54, -345, 74, 3.2], [54, -345, 74, 3.2], // north quadrants, E–W
    [-54, -255, 74, 3.2], [54, -255, 74, 3.2], // south quadrants, E–W
  ]
  for (const [px, pz, pw, pd] of parkPaths) {
    for (const r of splitRect(px, pz, pw, pd)) pathPlane(r.x, r.z, r.w, r.d)
  }
  // pond (NW quadrant, clear of every path and street)
  const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 32), mats.water)
  pond.rotation.x = -Math.PI / 2
  pond.scale.set(15, 10.5, 1)
  pond.position.set(-73, 0.05, -364)
  pond.receiveShadow = true
  group.add(pond)
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 40), mats.concrete)
  rim.rotation.x = -Math.PI / 2
  rim.scale.set(16.4, 11.6, 1)
  rim.position.set(-73, 0.06, -364)
  group.add(rim)

  // --- pond fountain (stone basin, pedestal, spray + ripples) & resident ducks ---
  {
    const fx = -73
    const fz = -364
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.55, 0.8, 18, 1, true), mats.concreteLight)
    basin.position.set(fx, 0.4, fz)
    basin.castShadow = true
    group.add(basin)
    const basinFloor = new THREE.Mesh(new THREE.CircleGeometry(2.42, 18), mats.concreteLight)
    basinFloor.rotation.x = -Math.PI / 2
    basinFloor.position.set(fx, 0.06, fz)
    group.add(basinFloor)
    const basinWater = new THREE.Mesh(new THREE.CircleGeometry(2.2, 18), mats.water)
    basinWater.rotation.x = -Math.PI / 2
    basinWater.position.set(fx, 0.6, fz)
    group.add(basinWater)
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.35, 10), mats.concreteLight)
    pedestal.position.set(fx, 1.2, fz)
    pedestal.castShadow = true
    group.add(pedestal)
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.55, 0.3, 14), mats.concreteLight)
    bowl.position.set(fx, 2.0, fz)
    bowl.castShadow = true
    group.add(bowl)
    const bowlWater = new THREE.Mesh(new THREE.CircleGeometry(0.86, 14), mats.water)
    bowlWater.rotation.x = -Math.PI / 2
    bowlWater.position.set(fx, 2.12, fz)
    group.add(bowlWater)
    // foam column rising from the bowl
    const jet = new THREE.Mesh(new THREE.ConeGeometry(0.24, 1.5, 8), new THREE.MeshStandardMaterial({ color: '#eef6f2', roughness: 0.25 }))
    jet.position.set(fx, 2.85, fz)
    group.add(jet)
    // spray droplets — instanced spheres on parabolic loops
    const dropCount = 14
    const dropIM = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.055, 5, 4),
      new THREE.MeshStandardMaterial({ color: '#e8f4ee', roughness: 0.2 }),
      dropCount,
    )
    dropIM.frustumCulled = false
    group.add(dropIM)
    // expanding ripple rings on the basin water
    const rippleMats: THREE.MeshBasicMaterial[] = []
    const ripples: THREE.Mesh[] = []
    for (let i = 0; i < 2; i++) {
      const rm = new THREE.MeshBasicMaterial({ color: '#dceee6', transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false })
      const rp = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.98, 24), rm)
      rp.rotation.x = -Math.PI / 2
      rp.position.set(fx, 0.62, fz)
      group.add(rp)
      rippleMats.push(rm)
      ripples.push(rp)
    }
    colliders.push({ minX: fx - 2.6, maxX: fx + 2.6, minZ: fz - 2.6, maxZ: fz + 2.6, h: 2.2 })
    // ducks — merged body+head+bill per duck, one InstancedMesh
    const duckGeo = mergeGeometries(
      [
        new THREE.SphereGeometry(0.2, 8, 6).scale(1, 0.78, 1.4).translate(0, 0, 0),
        new THREE.SphereGeometry(0.105, 7, 5).translate(0, 0.2, 0.24),
        new THREE.BoxGeometry(0.07, 0.045, 0.14).translate(0, 0.185, 0.38),
      ],
      false,
    )!
    const duckIM = new THREE.InstancedMesh(duckGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 }), 6)
    duckIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    duckIM.frustumCulled = false
    duckIM.castShadow = true
    group.add(duckIM)
    const duckCols = ['#8c5a3a', '#8c5a3a', '#d8d4c8', '#5a6a4a', '#d8d4c8', '#3c4448']
    for (let i = 0; i < 6; i++) duckIM.setColorAt(i, new THREE.Color(duckCols[i]))
    if (duckIM.instanceColor) duckIM.instanceColor.needsUpdate = true
    const ducks = Array.from({ length: 6 }, (_, i) => ({
      a: rng() * Math.PI * 2,
      w: (0.1 + rng() * 0.12) * (i % 2 === 0 ? 1 : -1),
      rx: 5 + rng() * 6.5,
      rz: 3.4 + rng() * 3.4,
      phase: rng() * Math.PI * 2,
    }))
    const dd = new THREE.Object3D()
    dd.rotation.order = 'YXZ'
    animators.push((t: number) => {
      // spray droplets: parabolic arcs out of the bowl
      for (let i = 0; i < dropCount; i++) {
        const lt = (t * 0.55 + i / dropCount) % 1
        const ang = (i / dropCount) * Math.PI * 2 + t * 0.15
        const rr = 0.2 + lt * 1.15
        dd.position.set(fx + Math.cos(ang) * rr, 2.75 + 1.5 * lt - 2.6 * lt * lt, fz + Math.sin(ang) * rr)
        dd.rotation.set(0, 0, 0)
        dd.scale.setScalar(1 - lt * 0.4)
        dd.updateMatrix()
        dropIM.setMatrixAt(i, dd.matrix)
      }
      dropIM.instanceMatrix.needsUpdate = true
      for (let i = 0; i < 2; i++) {
        const lt = (t * 0.32 + i * 0.5) % 1
        ripples[i].scale.setScalar(1 + lt * 2.1)
        rippleMats[i].opacity = 0.42 * (1 - lt)
      }
      jet.scale.y = 1 + Math.sin(t * 2.2) * 0.07
      jet.position.y = 2.85 + Math.sin(t * 2.2) * 0.05
      // paddling ducks
      for (let i = 0; i < ducks.length; i++) {
        const d = ducks[i]
        d.a += d.w * 0.016
        const dx = -Math.sin(d.a) * d.rx * d.w
        const dz = Math.cos(d.a) * d.rz * d.w
        dd.position.set(fx + Math.cos(d.a) * d.rx, 0.14 + Math.sin(t * 1.6 + d.phase) * 0.035, fz + Math.sin(d.a) * d.rz)
        dd.rotation.set(0, Math.atan2(dx, dz), Math.sin(t * 1.1 + d.phase) * 0.04)
        dd.scale.setScalar(1)
        dd.updateMatrix()
        duckIM.setMatrixAt(i, dd.matrix)
      }
      duckIM.instanceMatrix.needsUpdate = true
    })
  }
  // circular node plazas where the paths cross (one per quadrant)
  for (const [nx, nz] of [[-55, -345], [55, -345], [-55, -255], [55, -255]] as const) {
    const node = new THREE.Mesh(worldUVPlane(new THREE.CircleGeometry(4.6, 22), 9.2, 9.2, 3), mats.parkPath)
    node.rotation.x = -Math.PI / 2
    node.position.set(nx, 0.052, nz)
    group.add(node)
  }
  // lawns (one per quadrant, between the paths)
  for (const [lx, lz, lw, ld] of [[-33, -320, 34, 20], [34, -320, 34, 20], [-33, -280, 34, 20], [34, -280, 34, 20]] as const) {
    const g = new THREE.CircleGeometry(1, 20)
    g.rotateX(-Math.PI / 2)
    g.scale(lw / 2, ld / 2, 1)
    worldUVPlane(g, lw, ld, 7)
    g.translate(lx, 0.06, lz)
    lawnGeos.push(g)
  }
  // pavilion at (62,-330)
  {
    const px = 62
    const pz = -330
    const slab = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 7), mats.concreteLight)
    slab.position.set(px, 0.2, pz)
    slab.receiveShadow = true
    group.add(slab)
    const roof = new THREE.Mesh(new THREE.ConeGeometry(5.4, 2.2, 4), mats.fabricGreen)
    roof.rotation.y = Math.PI / 4
    roof.position.set(px, 4.4, pz)
    roof.castShadow = true
    group.add(roof)
    for (const [ox, oz] of [[-2.6, -2.6], [2.6, -2.6], [-2.6, 2.6], [2.6, 2.6]] as const) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 3.4, 6), mats.wood)
      post.position.set(px + ox, 2, pz + oz)
      post.castShadow = true
      group.add(post)
    }
    colliders.push({ minX: px - 3.5, maxX: px + 3.5, minZ: pz - 3.5, maxZ: pz + 3.5, h: 3.5 })
  }
  // playground at (-55,-230) — SW quadrant, paths pass right by it
  {
    const px = -55
    const pz = -230
    const sand = new THREE.Mesh(new THREE.CircleGeometry(8, 20), mats.gravel)
    sand.rotation.x = -Math.PI / 2
    sand.position.set(px, 0.05, pz)
    group.add(sand)
    // slide
    const slideBase = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.2, 0.6), mats.fabricOrange)
    slideBase.position.set(px - 3, 1.1, pz)
    slideBase.castShadow = true
    group.add(slideBase)
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 4.4), mats.metal)
    slide.position.set(px - 1.2, 1.05, pz + 1.6)
    slide.rotation.x = 0.72
    slide.castShadow = true
    group.add(slide)
    // swings
    const frameA = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.12), mats.fabricRed)
    frameA.position.set(px + 3, 1.3, pz - 1.8)
    const frameB = frameA.clone()
    frameB.position.z = pz + 1.8
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.8), mats.fabricRed)
    top.position.set(px + 3, 2.55, pz)
    group.add(frameA, frameB, top)
    for (const so of [-0.9, 0.9]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.25), mats.wood)
      seat.position.set(px + 3, 0.75, pz + so)
      group.add(seat)
    }
    colliders.push({ minX: px - 3.5, maxX: px - 2.5, minZ: pz - 0.5, maxZ: pz + 0.5, h: 2.4 })
    colliders.push({ minX: px + 2.7, maxX: px + 3.3, minZ: pz - 2, maxZ: pz + 2, h: 2.7 })
  }
  // flower beds flanking the quadrant paths — low planters with blooms,
  // validated against every street corridor (never on asphalt)
  const flowerBeds: { x: number; y: number; z: number }[] = []
  const blooms: { x: number; y: number; z: number }[] = []
  for (let i = 0; i < 30; i++) {
    const quad = i % 4
    const qx = quad % 2 === 0 ? -55 : 55
    const qz = quad < 2 ? -345 : -255
    const fx = qx + (rng() < 0.5 ? -4.2 : 4.2)
    const fz = qz + (rng() - 0.5) * 56
    if (inCorridor(fx, fz)) continue
    flowerBeds.push({ x: fx, y: 0.12, z: fz })
    for (let b = 0; b < 4; b++) {
      blooms.push({ x: fx + (rng() - 0.5) * 0.72, y: 0.3 + rng() * 0.1, z: fz + (rng() - 0.5) * 0.72 })
    }
  }
  makeIM(new THREE.BoxGeometry(1.0, 0.24, 1.0), mats.planter, flowerBeds, undefined, false)
  makeIM(new THREE.SphereGeometry(0.09, 6, 5), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 }), blooms, (i) => new THREE.Color(['#d84a3a', '#e8a03a', '#e8e0d0', '#c94f7c'][i % 4]), false)
  addMerged(pathGeos, mats.parkPath, false)
  addMerged(lawnGeos, mats.grassDark, false)

  // ---- Pocket parks: cross paths + seesaw ----
  for (const p of plan.parks) {
    if (p.kind !== 'pocket-park') continue
    for (const r of splitRect(p.x0 + 50, p.z0 + 50, 2.4, 80)) pathPlane(r.x, r.z, r.w, r.d)
    for (const r of splitRect(p.x0 + 50, p.z0 + 50, 80, 2.4)) pathPlane(r.x, r.z, r.w, r.d)
    const sand = new THREE.Mesh(worldUVPlane(new THREE.CircleGeometry(4.5, 14), 9, 9, 2.5), mats.gravel)
    sand.rotation.x = -Math.PI / 2
    sand.position.set(p.x0 + 50 + 14, 0.05, p.z0 + 50 + 12)
    group.add(sand)
    const beam = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.12, 0.4), mats.fabricOrange)
    beam.position.set(p.x0 + 50 + 14, 0.75, p.z0 + 50 + 12)
    beam.rotation.z = 0.14
    beam.castShadow = true
    group.add(beam)
    const pivot = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.3), mats.metalDark)
    pivot.position.set(p.x0 + 50 + 14, 0.35, p.z0 + 50 + 12)
    group.add(pivot)
  }

  // ---- Sports park ----
  {
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(60, 38), getPitchMaterial())
    pitch.rotation.x = -Math.PI / 2
    pitch.position.set(-50, 0.04, 350)
    pitch.receiveShadow = true
    group.add(pitch)
    const lineMat = mats.roadLine
    const lines: [number, number, number, number][] = [
      [-50, 331.2, 60, 0.2], [-50, 368.8, 60, 0.2], [-80.1, 350, 0.2, 38], [-19.9, 350, 0.2, 38], [-50, 350, 0.2, 38],
    ]
    for (const [x, z, w, d] of lines) {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat)
      l.rotation.x = -Math.PI / 2
      l.position.set(x, 0.06, z)
      group.add(l)
    }
    const circle = new THREE.Mesh(new THREE.RingGeometry(4.6, 4.85, 28), lineMat)
    circle.rotation.x = -Math.PI / 2
    circle.position.set(-50, 0.06, 350)
    group.add(circle)
    // goals
    for (const gx of [-80, -20]) {
      for (const gz of [346.5, 353.5]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.2, 6), mats.white)
        post.position.set(gx, 1.1, gz)
        group.add(post)
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 7.4), mats.white)
      bar.position.set(gx, 2.2, 350)
      group.add(bar)
    }
    // multi-use court
    const court = new THREE.Mesh(worldUVPlane(new THREE.PlaneGeometry(22, 13), 22, 13, 6), mats.asphaltRough)
    court.rotation.x = -Math.PI / 2
    court.position.set(-25, 0.04, 316)
    group.add(court)
    const courtLine = new THREE.Mesh(new THREE.PlaneGeometry(21, 12), new THREE.MeshBasicMaterial({ color: '#c9a437' }))
    courtLine.rotation.x = -Math.PI / 2
    courtLine.scale.set(0.985, 0.985, 1)
    courtLine.position.set(-25, 0.06, 316)
    courtLine.material = new THREE.MeshBasicMaterial({ color: '#c9a437', wireframe: true })
    group.add(courtLine)
  }

  // ---- Community garden ----
  {
    const bedGeos: THREE.BufferGeometry[] = []
    const soilGeos: THREE.BufferGeometry[] = []
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const x = 215 + c * 14
        const z = 215 + r * 14
        const bed = new THREE.BoxGeometry(3.2, 0.5, 1.4)
        bed.translate(x, 0.25, z)
        bedGeos.push(bed)
        const soil = new THREE.BoxGeometry(2.9, 0.1, 1.1)
        worldUVBox(soil, 2.9, 1.1, 7)
        soil.translate(x, 0.52, z)
        soilGeos.push(soil)
        // occasional plants
        if (rng() < 0.7) bushes.push({ x, y: 0.75, z, s: 0.4 })
      }
    }
    addMerged(bedGeos, mats.wood)
    addMerged(soilGeos, mats.grassDark, false)
    const shed = new THREE.Mesh(new THREE.BoxGeometry(3, 2.4, 2.2), mats.wood)
    shed.position.set(288, 1.2, 212)
    shed.castShadow = true
    group.add(shed)
    colliders.push({ minX: 286.5, maxX: 289.5, minZ: 210.9, maxZ: 213.1, h: 2.4 })
    for (const bz of [214.5, 216.5]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.1, 10), mats.planter)
      barrel.position.set(291.5, 0.55, bz)
      barrel.castShadow = true
      group.add(barrel)
    }
    // gravel paths
    for (let r = 0; r < 5; r++) pathPlane(250, 222 + r * 14, 80, 1.6)
  }

  // ---- Plaza paving (kept clear of the surrounding road corridors) ----
  {
    const pave = new THREE.Mesh(new THREE.PlaneGeometry(85.4, 82.9), mats.concreteLight)
    pave.rotation.x = -Math.PI / 2
    pave.position.set(53.3, 0.02, -52.05)
    pave.receiveShadow = true
    group.add(pave)
    const band = new THREE.Mesh(new THREE.PlaneGeometry(72, 4), mats.planter)
    band.rotation.x = -Math.PI / 2
    band.position.set(50, 0.04, -50)
    group.add(band)
    // sculpture: 3 interlocking arcs on plinth
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 0.8, 16), mats.concrete)
    plinth.position.set(50, 0.4, -50)
    plinth.castShadow = true
    group.add(plinth)
    const arcColors = [mats.metal, mats.fabricGreen, mats.fabricOrange]
    for (let i = 0; i < 3; i++) {
      const R = 1.6 + i * 0.25
      const arcLen = Math.PI * 1.4
      // torus arc + spherical end caps so the rods have no open holes
      const arcParts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(R, 0.12, 10, 28, arcLen)]
      for (const a of [0, arcLen]) {
        const cap = new THREE.SphereGeometry(0.125, 8, 6)
        cap.translate(Math.cos(a) * R, Math.sin(a) * R, 0)
        arcParts.push(cap)
      }
      const arcMerged = mergeGeometries(arcParts, false)
      if (!arcMerged) continue
      const arc = new THREE.Mesh(arcMerged, arcColors[i])
      arc.position.set(50, 2.2 + i * 0.15, -50)
      arc.rotation.y = (i * Math.PI) / 3
      arc.rotation.x = 0.2 * i
      arc.castShadow = true
      group.add(arc)
    }
    colliders.push({ minX: 47.4, maxX: 52.6, minZ: -52.6, maxZ: -47.4, h: 1.2 })
    // flag pole (moved onto the plaza paving, off the arterial sidewalk)
    const fp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 11, 8), mats.metal)
    fp.position.set(19, 5.5, -19)
    fp.castShadow = true
    group.add(fp)
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1), mats.fabricGreen)
    flag.position.set(20, 10.2, -19)
    group.add(flag)
    // café terrace: real patio umbrellas (pole + conical canopy + base) with
    // bistro tables — merged per material (5 draw calls for all 4 sets)
    const umbrellaAccent = [mats.fabricOrange, mats.fabricRed, mats.fabricGreen, mats.fabricOrange]
    const bistroPositions: [number, number][] = [
      [18, -60],
      [24, -70],
      [38, -60],
      [52, -70],
    ]
    {
      const poleGeos: THREE.BufferGeometry[] = []
      const baseGeos: THREE.BufferGeometry[] = []
      const metalGeos: THREE.BufferGeometry[] = []
      const woodGeos: THREE.BufferGeometry[] = []
      const canopiesByMat = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>()
      bistroPositions.forEach(([mx, mz], ui) => {
        const tilt = (ui % 2 === 0 ? 1 : -1) * 0.07
        const pole = new THREE.CylinderGeometry(0.045, 0.06, 2.75, 8)
        pole.translate(mx, 1.375, mz)
        poleGeos.push(pole)
        const base = new THREE.CylinderGeometry(0.3, 0.36, 0.09, 12)
        base.translate(mx, 0.045, mz)
        baseGeos.push(base)
        // canopy: open cone tilted like a real umbrella, DoubleSide fabric
        const canopyMat = umbrellaAccent[ui % umbrellaAccent.length]
        canopyMat.side = THREE.DoubleSide
        const canopy = new THREE.ConeGeometry(1.65, 0.55, 8, 1, true)
        canopy.rotateZ(tilt)
        canopy.rotateX(tilt * 0.6)
        canopy.translate(mx, 2.9, mz)
        if (!canopiesByMat.has(canopyMat)) canopiesByMat.set(canopyMat, [])
        canopiesByMat.get(canopyMat)!.push(canopy)
        for (let rib = 0; rib < 4; rib++) {
          const angle = (rib / 4) * Math.PI * 2
          const ribG = new THREE.BoxGeometry(0.03, 0.03, 1.6)
          ribG.rotateX(0.32)
          ribG.rotateY(angle)
          ribG.translate(mx + Math.sin(angle) * 0.78, 2.78, mz + Math.cos(angle) * 0.78)
          poleGeos.push(ribG)
        }
        const finial = new THREE.SphereGeometry(0.07, 8, 6)
        finial.translate(mx + Math.sin(tilt) * 0.28, 3.2, mz)
        metalGeos.push(finial)
        const table = new THREE.CylinderGeometry(0.55, 0.55, 0.05, 12)
        table.translate(mx, 0.78, mz)
        metalGeos.push(table)
        const tLeg = new THREE.CylinderGeometry(0.05, 0.09, 0.76, 8)
        tLeg.translate(mx, 0.38, mz)
        poleGeos.push(tLeg)
        for (const so of [-0.95, 0.95]) {
          const stool = new THREE.CylinderGeometry(0.22, 0.2, 0.06, 10)
          stool.translate(mx + so, 0.62, mz)
          woodGeos.push(stool)
          const sLeg = new THREE.CylinderGeometry(0.035, 0.05, 0.6, 6)
          sLeg.translate(mx + so, 0.3, mz)
          poleGeos.push(sLeg)
        }
        colliders.push({ minX: mx - 0.6, maxX: mx + 0.6, minZ: mz - 0.6, maxZ: mz + 0.6, h: 0.85 })
      })
      addMerged(poleGeos, mats.metalDark)
      addMerged(baseGeos, mats.concrete, false)
      addMerged(metalGeos, mats.metal)
      addMerged(woodGeos, mats.wood)
      for (const [mat, geos] of canopiesByMat) {
        const merged = mergeGeometries(geos, false)
        if (!merged) continue
        const mesh = new THREE.Mesh(merged, mat)
        mesh.castShadow = true
        mesh.receiveShadow = true
        group.add(mesh)
      }
    }
  }

  // ---- School sports pitches ----
  // Each school now gets a REAL 4-lane running track painted around its
  // grass pitch (terracotta tartan, white lane lines, finish line) plus
  // football markings on the pitch — the old white border rectangle read
  // as a textureless white sheet.
  const trackMat = (() => {
    const [c, ctx] = canvas(640, 480)
    // tartan surface
    ctx.fillStyle = '#b0553a'
    ctx.fillRect(0, 0, 640, 480)
    const trng = mulberry32(4242)
    for (let i = 0; i < 2600; i++) {
      ctx.globalAlpha = 0.05 + trng() * 0.06
      ctx.fillStyle = trng() < 0.5 ? '#8a3f2a' : '#c9714f'
      ctx.fillRect(trng() * 640, trng() * 480, 2 + trng() * 3, 2)
    }
    ctx.globalAlpha = 1
    // inner field (green) — 30×20 m of the 44×32 m plane
    const fx0 = (7 / 44) * 640
    const fy0 = (6 / 32) * 480
    const fx1 = 640 - fx0
    const fy1 = 480 - fy0
    ctx.fillStyle = '#4f8340'
    ctx.fillRect(fx0, fy0, fx1 - fx0, fy1 - fy0)
    for (let sy = fy0; sy < fy1; sy += 22) {
      ctx.fillStyle = ((sy / 22) | 0) % 2 ? '#578f47' : '#4f8340'
      ctx.fillRect(fx0, sy, fx1 - fx0, 22)
    }
    // lane lines: 4 lanes between field edge and outer edge, both axes
    ctx.strokeStyle = '#f2efe6'
    ctx.lineWidth = 4
    for (let l = 0; l <= 4; l++) {
      const t = l / 4
      const x0 = fx0 * (1 - t)
      ctx.strokeRect(x0, fy0 * (1 - t), 640 - x0 * 2, 480 - fy0 * (1 - t) * 2)
    }
    // finish line (checkered) on the east straight
    const finX = 640 - fx0 * 0.5
    for (let cy = fy0 * 0.5; cy < 480 - fy0 * 0.5; cy += 14) {
      ctx.fillStyle = ((cy / 14) | 0) % 2 ? '#f2efe6' : '#22201c'
      ctx.fillRect(finX - 7, cy, 7, 14)
    }
    // lane numbers on the west straight
    ctx.fillStyle = '#f2efe6'
    ctx.font = 'bold 30px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let l = 0; l < 4; l++) {
      const t = (l + 0.5) / 4
      ctx.fillText(String(l + 1), fx0 * t, 240)
      ctx.fillText(String(l + 1), 640 - fx0 * t, 240)
    }
    const m = new THREE.MeshStandardMaterial({ map: tex(c, false), roughness: 0.95 })
    return m
  })()
  const pitchMarkMat = (() => {
    const [c, ctx] = canvas(512, 320)
    ctx.strokeStyle = 'rgba(250,250,244,0.92)'
    ctx.lineWidth = 3
    // outer touchlines (30×18 → 512×320 px)
    ctx.strokeRect(6, 6, 500, 308)
    // halfway line + centre circle + spot
    ctx.beginPath(); ctx.moveTo(256, 6); ctx.lineTo(256, 314); ctx.stroke()
    ctx.beginPath(); ctx.arc(256, 160, 44, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = 'rgba(250,250,244,0.92)'
    ctx.beginPath(); ctx.arc(256, 160, 4, 0, Math.PI * 2); ctx.fill()
    // penalty boxes + spots + arcs
    for (const side of [0, 1]) {
      const bx = side === 0 ? 6 : 506
      const dir = side === 0 ? 1 : -1
      ctx.strokeRect(bx, 92, dir * 66, 136) // penalty area
      ctx.strokeRect(bx, 128, dir * 26, 64) // goal area
      ctx.beginPath(); ctx.arc(256 + dir * 96, 160, 40, side === 0 ? -Math.PI / 2.6 : Math.PI - Math.PI / 2.6, side === 0 ? Math.PI / 2.6 : Math.PI + Math.PI / 2.6); ctx.stroke()
      ctx.beginPath(); ctx.arc(256 + dir * 72, 160, 4, 0, Math.PI * 2); ctx.fill()
    }
    const m = new THREE.MeshStandardMaterial({ map: tex(c, false), transparent: true, alphaTest: 0.3, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 })
    return m
  })()
  for (const [sx, sz] of [[-252, -266], [252, -266], [-252, 338]]) {
    const track = new THREE.Mesh(new THREE.PlaneGeometry(44, 32), trackMat)
    track.rotation.x = -Math.PI / 2
    track.position.set(sx, 0.028, sz + 26)
    track.receiveShadow = true
    group.add(track)
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(30, 18), getPitchMaterial())
    pitch.rotation.x = -Math.PI / 2
    pitch.position.set(sx, 0.05, sz + 26)
    pitch.receiveShadow = true
    group.add(pitch)
    const marks = new THREE.Mesh(new THREE.PlaneGeometry(30, 18), pitchMarkMat)
    marks.rotation.x = -Math.PI / 2
    marks.position.set(sx, 0.064, sz + 26)
    group.add(marks)
    const court = new THREE.Mesh(worldUVPlane(new THREE.PlaneGeometry(12, 8), 12, 8, 6), mats.asphaltRough)
    court.rotation.x = -Math.PI / 2
    court.position.set(sx - 28, 0.04, sz + 26)
    group.add(court)
  }

  // ---- Special-place painted grounds (unique texture per place) ----
  {
    // PLAYGROUND GAMES CIRCLE at (-55,-230): hopscotch + four-square +
    // rainbow arcs painted on the sand
    const [pc, pctx] = canvas(512, 512)
    pctx.lineWidth = 4
    // hopscotch (west): 8 numbered cells in an S-column
    const cell = 44
    for (let i = 0; i < 8; i++) {
      const col = i % 2
      const row = Math.floor(i / 2)
      const x = 96 + col * cell - (i === 6 || i === 7 ? cell / 2 : 0)
      const y = 110 + row * cell
      pctx.fillStyle = ['#e2b23a', '#c94f3d', '#5b8c4a', '#3a6a8a'][i % 4]
      pctx.fillRect(x, y, cell, cell)
      pctx.strokeStyle = '#f5f2e8'
      pctx.strokeRect(x, y, cell, cell)
      pctx.fillStyle = '#ffffff'
      pctx.font = 'bold 22px system-ui, sans-serif'
      pctx.textAlign = 'center'
      pctx.textBaseline = 'middle'
      pctx.fillText(String(i + 1), x + cell / 2, y + cell / 2)
    }
    // four-square (east): 2×2 grid
    for (let q = 0; q < 4; q++) {
      const x = 330 + (q % 2) * 62
      const y = 140 + Math.floor(q / 2) * 62
      pctx.fillStyle = ['#3a6a8a', '#e2b23a', '#c94f3d', '#5b8c4a'][q]
      pctx.fillRect(x, y, 62, 62)
      pctx.strokeStyle = '#f5f2e8'
      pctx.strokeRect(x, y, 62, 62)
      pctx.fillStyle = '#ffffff'
      pctx.font = 'bold 26px system-ui, sans-serif'
      pctx.fillText(String(q + 1), x + 31, y + 31)
    }
    // rainbow arcs (north)
    const arcCols = ['#c94f3d', '#e2b23a', '#5b8c4a', '#3a6a8a']
    for (let a = 0; a < 4; a++) {
      pctx.beginPath()
      pctx.strokeStyle = arcCols[a]
      pctx.lineWidth = 9
      pctx.arc(256, 448, 150 - a * 16, Math.PI, 0)
      pctx.stroke()
    }
    // colored dots scattered between the games
    for (const [dx, dy, dc] of [[180, 420, '#c94f3d'], [256, 420, '#5b8c4a'], [330, 420, '#3a6a8a'], [180, 70, '#e2b23a'], [330, 70, '#c94f3d']] as const) {
      pctx.beginPath()
      pctx.fillStyle = dc
      pctx.arc(dx, dy, 13, 0, Math.PI * 2)
      pctx.fill()
    }
    const games = new THREE.Mesh(
      new THREE.CircleGeometry(7.6, 36),
      new THREE.MeshStandardMaterial({ map: tex(pc, false), transparent: true, alphaTest: 0.25, roughness: 1 }),
    )
    games.rotation.x = -Math.PI / 2
    games.position.set(-55, 0.064, -230)
    group.add(games)

    // CIVIC PLAZA COMPASS MEDALLION at (50,-50): stone compass rose in the
    // middle of the pavers — the plaza finally has a center
    const [mc, mctx] = canvas(512, 512)
    mctx.translate(256, 256)
    // outer double ring
    mctx.strokeStyle = '#8a867a'
    mctx.lineWidth = 14
    mctx.beginPath(); mctx.arc(0, 0, 238, 0, Math.PI * 2); mctx.stroke()
    mctx.strokeStyle = '#a8a496'
    mctx.lineWidth = 5
    mctx.beginPath(); mctx.arc(0, 0, 214, 0, Math.PI * 2); mctx.stroke()
    mctx.beginPath(); mctx.arc(0, 0, 178, 0, Math.PI * 2); mctx.stroke()
    // compass star: proper 8-point polygon
    mctx.beginPath()
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2 - Math.PI / 2
      const r = i % 2 === 0 ? 168 : 62
      const wx = Math.cos(ang) * r
      const wy = Math.sin(ang) * r
      if (i === 0) mctx.moveTo(wx, wy)
      else mctx.lineTo(wx, wy)
    }
    mctx.closePath()
    mctx.fillStyle = '#8a867a'
    mctx.fill()
    mctx.strokeStyle = '#6a665c'
    mctx.lineWidth = 4
    mctx.stroke()
    // center disc
    mctx.beginPath()
    mctx.arc(0, 0, 44, 0, Math.PI * 2)
    mctx.fillStyle = '#b8b4a6'
    mctx.fill()
    mctx.strokeStyle = '#8a867a'
    mctx.stroke()
    // cardinal letters
    mctx.fillStyle = '#5a564c'
    mctx.font = 'bold 44px system-ui, sans-serif'
    mctx.textAlign = 'center'
    mctx.textBaseline = 'middle'
    mctx.fillText('N', 0, -196)
    mctx.fillText('S', 0, 196)
    mctx.fillText('E', 196, 0)
    mctx.fillText('W', -196, 0)
    const medallion = new THREE.Mesh(
      new THREE.CircleGeometry(6.5, 40),
      new THREE.MeshStandardMaterial({ map: tex(mc, false), transparent: true, alphaTest: 0.25, roughness: 0.9 }),
    )
    medallion.rotation.x = -Math.PI / 2
    medallion.position.set(50, 0.024, -50)
    group.add(medallion)
  }

  /* ============================================================
   * 4. CAR-FREE STREET DRESSING — neon totems + string lights
   * ============================================================ */
  {
    const neonNames: [string, string][] = [
      ['BAKERY', '#ffb84a'],
      ['FLOWERS', '#7ee0a8'],
      ['RAMEN', '#ff6a5a'],
      ['BOOKS', '#ffe9b0'],
      ['VINYL', '#7ee0a8'],
      ['DELI', '#ffb84a'],
      ['ARCADE', '#ff6a5a'],
      ['SHOES', '#ffe9b0'],
    ]
    const neonMats: THREE.MeshBasicMaterial[] = []
    const totemGeos: THREE.BufferGeometry[] = []
    const boardGeos = new Map<THREE.Material, THREE.BufferGeometry[]>()
    const xs = [-136, -102, -68, -34, 34, 68, 102, 136]
    xs.forEach((x, i) => {
      const z = i % 2 === 0 ? 95.2 : 104.8
      const pole = new THREE.BoxGeometry(0.14, 3.6, 0.14)
      pole.translate(x, 1.8, z)
      totemGeos.push(pole)
      const [name, col] = neonNames[i % neonNames.length]
      let mat = neonMats.find((m) => m.userData.neonName === name)
      if (!mat) {
        const [c, ctx] = canvas(128, 256)
        ctx.fillStyle = '#17120c'
        ctx.fillRect(0, 0, 128, 256)
        ctx.strokeStyle = col
        ctx.lineWidth = 6
        ctx.shadowColor = col
        ctx.shadowBlur = 18
        ctx.strokeRect(10, 10, 108, 236)
        ctx.fillStyle = col
        ctx.shadowBlur = 14
        ctx.font = 'bold 30px Arial'
        ctx.textAlign = 'center'
        const letters = name.split('')
        const startY = 78
        letters.forEach((ch, li) => ctx.fillText(ch, 64, startY + li * 34))
        const t = tex(c, false)
        mat = new THREE.MeshBasicMaterial({ map: t, toneMapped: false })
        mat.userData.neonName = name
        neonMats.push(mat)
      }
      const board = new THREE.BoxGeometry(0.95, 2.3, 0.14)
      board.translate(x, 2.85, z)
      if (!boardGeos.has(mat)) boardGeos.set(mat, [])
      boardGeos.get(mat)!.push(board)
    })
    addMerged(totemGeos, mats.metalDark, false)
    for (const [mat, geos] of boardGeos) {
      const merged = mergeGeometries(geos, false)
      if (!merged) continue
      const mesh = new THREE.Mesh(merged, mat)
      group.add(mesh)
    }

    // string lights across the walkway (sagged cables + glowing bulbs)
    const cableGeos: THREE.BufferGeometry[] = []
    const cablePoles: { x: number; y: number; z: number }[] = []
    const bulbs: { x: number; y: number; z: number }[] = []
    for (const sx of [-120, -80, -40, 40, 80, 120]) {
      for (const sz of [96.1, 103.9]) {
        cablePoles.push({ x: sx, y: 2.9, z: sz })
      }
      const a = new THREE.Vector3(sx, 5.7, 96.1)
      const b = new THREE.Vector3(sx, 5.7, 103.9)
      const mid = new THREE.Vector3(sx, 4.75, 100)
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
      cableGeos.push(new THREE.TubeGeometry(curve, 10, 0.035, 5, false))
      for (let i = 1; i < 10; i++) {
        const p = curve.getPoint(i / 10)
        bulbs.push({ x: p.x, y: p.y - 0.09, z: p.z })
      }
    }
    addMerged(cableGeos, mats.metalDark, false)
    makeIM(new THREE.CylinderGeometry(0.05, 0.07, 5.8, 6), mats.metalDark, cablePoles, undefined, false)
    makeIM(
      new THREE.SphereGeometry(0.075, 6, 5),
      new THREE.MeshBasicMaterial({ color: '#ffd9a0', toneMapped: false }),
      bulbs,
      undefined,
      false,
    )

    // ---- DELIVERING ON THE ADS ----
    // The neon totems promise BAKERY / FLOWERS / RAMEN / BOOKS / VINYL /
    // DELI and the POI text promises café terraces — this block builds the
    // actual street life those signs sell: themed market stalls down the
    // centre, bistro terraces along the shopfronts and A-frame ad boards.
    {
      // --- 5 themed market stalls down the centre of the street ---
      const stalls: { x: number; theme: 'flowers' | 'bakery' | 'books' | 'vinyl' | 'deli' }[] = [
        { x: -175.5, theme: 'flowers' },
        { x: -123.5, theme: 'bakery' },
        { x: -44.5, theme: 'books' },
        { x: 9.5, theme: 'vinyl' },
        { x: 111.5, theme: 'deli' },
      ]
      const stripeMats: Record<string, THREE.MeshStandardMaterial> = {}
      const stallPostGeos: THREE.BufferGeometry[] = []
      const stallWoodGeos: THREE.BufferGeometry[] = []
      const goodsByColor = new Map<string, THREE.BufferGeometry[]>()
      const addGood = (color: string, geo: THREE.BufferGeometry) => {
        if (!goodsByColor.has(color)) goodsByColor.set(color, [])
        goodsByColor.get(color)!.push(geo)
      }
      const srng = mulberry32(777)
      const SZ = 100 // the car-free street centerline
      for (const st of stalls) {
        const x = st.x
        for (const sx of [-1.45, 1.45]) {
          for (const sz of [-0.72, 0.72]) {
            const p = new THREE.BoxGeometry(0.07, 2.35, 0.07)
            p.translate(x + sx, 1.175, SZ + sz)
            stallPostGeos.push(p)
          }
          const brace = new THREE.BoxGeometry(0.05, 0.05, 1.6)
          brace.rotateX(0.33)
          brace.translate(x + sx, 2.26, SZ - 0.2)
          stallPostGeos.push(brace)
        }
        const counter = new THREE.BoxGeometry(3.1, 0.08, 1.5)
        counter.translate(x, 0.92, SZ)
        stallWoodGeos.push(counter)
        for (const sz of [-0.66, 0.66]) {
          const skirt = new THREE.BoxGeometry(3.0, 0.5, 0.05)
          skirt.translate(x, 0.62, SZ + sz)
          stallWoodGeos.push(skirt)
        }
        if (!stripeMats[st.theme]) {
          const pairs: Record<string, [string, string]> = {
            flowers: ['#f3efe4', '#4e8c3f'],
            bakery: ['#f3efe4', '#d88a3a'],
            books: ['#e8e2d2', '#7a5c40'],
            vinyl: ['#33333a', '#c9c4b4'],
            deli: ['#f3efe4', '#c94f3d'],
          }
          const [a, b] = pairs[st.theme]
          const [cc, cctx] = canvas(128, 64)
          for (let i = 0; i < 8; i++) {
            cctx.fillStyle = i % 2 === 0 ? a : b
            cctx.fillRect(i * 16, 0, 16, 64)
          }
          stripeMats[st.theme] = new THREE.MeshStandardMaterial({ map: tex(cc, false), roughness: 0.85, side: THREE.DoubleSide })
        }
        const canopy = new THREE.BoxGeometry(3.3, 0.05, 2.1)
        canopy.rotateX(-0.24)
        canopy.translate(x, 2.62, SZ - 0.28)
        addMerged([canopy], stripeMats[st.theme])

        // theme goods on the counter
        if (st.theme === 'flowers') {
          const petals = ['#d9648a', '#e3b23c', '#e8e2da', '#c94f3d', '#b45ea8']
          for (let i = 0; i < 5; i++) {
            const bx = x - 1.1 + i * 0.55
            const bz = (i % 2 === 0 ? 1 : -1) * 0.28
            const bucket = new THREE.CylinderGeometry(0.1, 0.08, 0.26, 8)
            bucket.translate(bx, 1.09, SZ + bz)
            addGood('#9aa0a2', bucket)
            const bloom = new THREE.IcosahedronGeometry(0.13, 0)
            bloom.translate(bx + (srng() - 0.5) * 0.05, 1.3, SZ + bz + (srng() - 0.5) * 0.05)
            addGood(petals[i], bloom)
          }
        } else if (st.theme === 'bakery') {
          for (let i = 0; i < 3; i++) {
            const bx = x - 0.9 + i * 0.9
            const basket = new THREE.BoxGeometry(0.62, 0.14, 0.46)
            basket.translate(bx, 1.03, SZ + (i % 2 === 0 ? 1 : -1) * 0.3)
            addGood('#8a6a4a', basket)
            for (const bz of [-0.12, 0.14]) {
              const roll = new THREE.SphereGeometry(0.13, 8, 6)
              roll.scale(1.25, 0.62, 1)
              roll.translate(bx + (srng() - 0.5) * 0.14, 1.16, SZ + (i % 2 === 0 ? 1 : -1) * 0.3 + bz)
              addGood(srng() < 0.5 ? '#c89a5a' : '#b08048', roll)
            }
          }
        } else if (st.theme === 'books') {
          const covers = ['#7a5c40', '#4e6b52', '#8a4f3d', '#5c6b7a', '#a08a4a']
          for (let i = 0; i < 3; i++) {
            const bx = x - 0.9 + i * 0.9
            const bz = (i % 2 === 0 ? 1 : -1) * 0.3
            for (let k = 0; k < 5; k++) {
              const bk = new THREE.BoxGeometry(0.24, 0.035, 0.32)
              bk.rotateY((srng() - 0.5) * 0.25)
              bk.translate(bx + (srng() - 0.5) * 0.04, 1.01 + k * 0.037, SZ + bz)
              addGood(covers[(i * 2 + k) % covers.length], bk)
            }
          }
        } else if (st.theme === 'vinyl') {
          for (let i = 0; i < 2; i++) {
            const bx = x - 0.6 + i * 1.2
            const crate = new THREE.BoxGeometry(0.62, 0.34, 0.46)
            crate.translate(bx, 1.13, SZ + (i % 2 === 0 ? 1 : -1) * 0.28)
            addGood('#8a6a4a', crate)
            for (let k = 0; k < 3; k++) {
              const sleeve = new THREE.BoxGeometry(0.3, 0.3, 0.015)
              sleeve.rotateY(-0.35 + k * 0.12)
              sleeve.translate(bx - 0.12 + k * 0.12, 1.38, SZ + (i % 2 === 0 ? 1 : -1) * 0.28)
              addGood(['#c94f3d', '#e3b23c', '#4e6b52'][k], sleeve)
            }
          }
        } else {
          const fruit: [string, number][] = [['#e08a2d', 5], ['#b5342a', 4], ['#7fa04e', 4]]
          let fi = 0
          for (const [col, n] of fruit) {
            const px = x - 0.9 + fi * 0.9
            const crate = new THREE.BoxGeometry(0.58, 0.16, 0.44)
            crate.translate(px, 1.04, SZ + (fi % 2 === 0 ? 1 : -1) * 0.3)
            addGood('#8a6a4a', crate)
            for (let k = 0; k < n; k++) {
              const ball = new THREE.SphereGeometry(0.085, 7, 6)
              ball.translate(px + (srng() - 0.5) * 0.36, 1.16 + (k > 2 ? 0.13 : 0), SZ + (fi % 2 === 0 ? 1 : -1) * 0.3 + (srng() - 0.5) * 0.24)
              addGood(col, ball)
            }
            fi++
          }
        }
        colliders.push({ minX: x - 1.6, maxX: x + 1.6, minZ: SZ - 0.9, maxZ: SZ + 0.9, h: 2.4 })
      }
      addMerged(stallPostGeos, mats.metalDark, false)
      addMerged(stallWoodGeos, mats.wood)
      for (const [col, geos] of goodsByColor) {
        // unify index-ness — goods buckets can mix Icosahedron blooms (non-indexed)
        // with Box crates (indexed), which mergeGeometries refuses
        const ni = geos.map((g) => {
          const n = g.index ? g.toNonIndexed() : g
          if (n !== g) g.dispose()
          return n
        })
        addMerged(ni, new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 }))
      }

      // --- café terraces along the shopfronts (the promised "café terraces") ---
      const terraceXs = [-149, -90, -25, 47, 95, 165]
      const tFabrics = [mats.fabricOrange, mats.fabricRed, mats.fabricGreen]
      const tPoleGeos: THREE.BufferGeometry[] = []
      const tBaseGeos: THREE.BufferGeometry[] = []
      const tMetalGeos: THREE.BufferGeometry[] = []
      const tWoodGeos: THREE.BufferGeometry[] = []
      const tCanopies = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>()
      terraceXs.forEach((tx, i) => {
        const tz = i % 2 === 0 ? 95.65 : 104.35
        const tilt = (i % 2 === 0 ? 1 : -1) * 0.06
        const pole = new THREE.CylinderGeometry(0.045, 0.06, 2.75, 8)
        pole.translate(tx, 1.375, tz)
        tPoleGeos.push(pole)
        const base = new THREE.CylinderGeometry(0.3, 0.36, 0.09, 12)
        base.translate(tx, 0.045, tz)
        tBaseGeos.push(base)
        const fmat = tFabrics[i % tFabrics.length]
        fmat.side = THREE.DoubleSide
        const canopy = new THREE.ConeGeometry(1.6, 0.52, 8, 1, true)
        canopy.rotateZ(tilt)
        canopy.translate(tx, 2.85, tz)
        if (!tCanopies.has(fmat)) tCanopies.set(fmat, [])
        tCanopies.get(fmat)!.push(canopy)
        for (let rib = 0; rib < 4; rib++) {
          const angle = (rib / 4) * Math.PI * 2
          const ribG = new THREE.BoxGeometry(0.03, 0.03, 1.55)
          ribG.rotateX(0.3)
          ribG.rotateY(angle)
          ribG.translate(tx + Math.sin(angle) * 0.76, 2.72, tz + Math.cos(angle) * 0.76)
          tPoleGeos.push(ribG)
        }
        const table = new THREE.CylinderGeometry(0.55, 0.55, 0.05, 12)
        table.translate(tx, 0.78, tz)
        tMetalGeos.push(table)
        const tLeg = new THREE.CylinderGeometry(0.05, 0.09, 0.76, 8)
        tLeg.translate(tx, 0.38, tz)
        tPoleGeos.push(tLeg)
        for (const so of [-0.95, 0.95]) {
          const stool = new THREE.CylinderGeometry(0.22, 0.2, 0.06, 10)
          stool.translate(tx + so, 0.62, tz)
          tWoodGeos.push(stool)
          const sLeg = new THREE.CylinderGeometry(0.035, 0.05, 0.6, 6)
          sLeg.translate(tx + so, 0.3, tz)
          tPoleGeos.push(sLeg)
        }
        colliders.push({ minX: tx - 0.6, maxX: tx + 0.6, minZ: tz - 0.6, maxZ: tz + 0.6, h: 0.85 })
      })
      addMerged(tPoleGeos, mats.metalDark)
      addMerged(tBaseGeos, mats.concrete, false)
      addMerged(tMetalGeos, mats.metal)
      addMerged(tWoodGeos, mats.wood)
      for (const [mat, geos] of tCanopies) {
        const merged = mergeGeometries(geos, false)
        if (!merged) continue
        const mesh = new THREE.Mesh(merged, mat)
        mesh.castShadow = true
        group.add(mesh)
      }

      // --- A-frame sandwich boards advertising the shops ---
      const boardDefs: { x: number; z: number; text: string; accent: string }[] = [
        { x: -160, z: 96.4, text: 'FRESH BREAD', accent: '#d88a3a' },
        { x: -120, z: 103.6, text: 'FLOWERS 5.-', accent: '#4e8c3f' },
        { x: -85, z: 96.4, text: 'RAMEN 6.50', accent: '#c94f3d' },
        { x: -50, z: 103.6, text: 'BOOKS 2-FOR-1', accent: '#7a5c40' },
        { x: -15, z: 96.4, text: 'COFFEE 2.50', accent: '#8a5c3a' },
        { x: 50, z: 103.6, text: 'LIVE VINYL FRI', accent: '#33333a' },
        { x: 85, z: 96.4, text: 'DELI LUNCH 7.-', accent: '#c94f3d' },
        { x: 120, z: 103.6, text: 'SHOES -30%', accent: '#b06030' },
      ]
      for (const bd of boardDefs) {
        const [pc, pctx] = canvas(128, 160)
        pctx.fillStyle = '#efe8d6'
        pctx.fillRect(0, 0, 128, 160)
        pctx.strokeStyle = bd.accent
        pctx.lineWidth = 7
        pctx.strokeRect(7, 7, 114, 146)
        pctx.fillStyle = '#2a241c'
        pctx.font = 'bold 21px Arial'
        pctx.textAlign = 'center'
        const words = bd.text.split(' ')
        words.forEach((w, wi) => pctx.fillText(w, 64, 66 + wi * 26))
        pctx.fillStyle = bd.accent
        pctx.fillRect(34, 132, 60, 8)
        const bmat = new THREE.MeshStandardMaterial({ map: tex(pc, false), roughness: 0.8, side: THREE.DoubleSide })
        const bGeos: THREE.BufferGeometry[] = []
        for (const lean of [0.26, -0.26]) {
          const face = new THREE.PlaneGeometry(0.62, 0.82)
          face.rotateX(lean * 0.9)
          face.translate(0, 0.42, lean * 0.12)
          bGeos.push(face)
        }
        const boardMesh = new THREE.Mesh(mergeGeometries(bGeos, false)!, bmat)
        boardMesh.position.set(bd.x, 0.1, bd.z)
        boardMesh.rotation.y = (bd.z < 100 ? 0 : Math.PI) + (srng() - 0.5) * 0.3
        boardMesh.castShadow = true
        group.add(boardMesh)
        colliders.push({ minX: bd.x - 0.32, maxX: bd.x + 0.32, minZ: bd.z - 0.16, maxZ: bd.z + 0.16, h: 0.9 })
      }
    }
  }

  /* ============================================================
   * 5. CONSTRUCTION SITE + CRANE (downtown infill)
   * ============================================================ */
  {
    const site = new THREE.Group()
    const pad = new THREE.Mesh(worldUVBox(new THREE.BoxGeometry(20, 0.08, 20), 20, 20, 6), mats.asphaltRough)
    pad.position.set(-26, 0.04, 150)
    pad.receiveShadow = true
    site.add(pad)
    // hoarding fence on 3 sides (east = site entrance)
    const fenceMat = getFenceMaterial()
    const fenceSeg = (w: number, h: number, x: number, z: number, ry = 0) => {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(w, h), fenceMat)
      f.position.set(x, h / 2, z)
      f.rotation.y = ry
      site.add(f)
    }
    fenceSeg(20, 2.1, -26, 160)
    fenceSeg(20, 2.1, -26, 140)
    fenceSeg(20, 2.1, -36, 150, Math.PI / 2) // side segment runs along Z, not up into the sky
    const fencePosts: { x: number; y: number; z: number }[] = []
    for (let x = -35; x <= -17; x += 4) {
      fencePosts.push({ x, y: 1.05, z: 160 })
      fencePosts.push({ x, y: 1.05, z: 140 })
    }
    for (let z = 142; z <= 158; z += 4) fencePosts.push({ x: -36, y: 1.05, z })
    makeIM(new THREE.BoxGeometry(0.12, 2.2, 0.12), mats.metalDark, fencePosts, undefined, false)
    // site cabin + material piles
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.7, 2.5), mats.white)
    cabin.position.set(-33, 1.39, 144.5)
    cabin.castShadow = true
    site.add(cabin)
    const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.14, 2.8), mats.metalDark)
    cabinRoof.position.set(-33, 2.8, 144.5)
    site.add(cabinRoof)
    const pileA = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.1, 2.2), mats.gravel)
    pileA.position.set(-20.5, 0.6, 156)
    pileA.castShadow = true
    site.add(pileA)
    for (let i = 0; i < 3; i++) {
      const timber = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.16, 0.35), mats.wood)
      timber.position.set(-20.5, 0.35 + i * 0.18, 152.4)
      timber.castShadow = true
      site.add(timber)
    }
    const pallets: THREE.BufferGeometry[] = []
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.BoxGeometry(1.2, 0.14, 1.0)
      pl.translate(-29.5 + (i % 2) * 1.5, 0.55 + Math.floor(i / 2) * 0.9, 157)
      pallets.push(pl)
    }
    addMerged(pallets, mats.wood)
    colliders.push(
      { minX: -34.9, maxX: -31.1, minZ: 143.1, maxZ: 145.9, h: 2.8 },
      { minX: -22.3, maxX: -18.7, minZ: 154.7, maxZ: 157.3, h: 1.2 },
      { minX: -21.2, maxX: -18.8, minZ: 144.6, maxZ: 160, h: 1.4 },
    )

    // tower crane
    const craneYellow = new THREE.MeshStandardMaterial({ color: '#d8a832', roughness: 0.55, metalness: 0.45 })
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 4.2), mats.concrete)
    base.position.set(-20, 0.45, 148)
    base.castShadow = true
    site.add(base)
    const mast = new THREE.Mesh(new THREE.BoxGeometry(1.05, 30, 1.05), craneYellow)
    mast.position.set(-20, 15.9, 148)
    mast.castShadow = true
    site.add(mast)
    for (let y = 3; y <= 30; y += 4.5) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(1.13, 0.2, 1.13), mats.metalDark)
      band.position.set(-20, y, 148)
      site.add(band)
    }
    const jib = new THREE.Group()
    jib.position.set(-20, 31.2, 148)
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.5, 1.7), mats.metalDark)
    cab.position.y = 0.4
    jib.add(cab)
    const arm = new THREE.Mesh(new THREE.BoxGeometry(24, 0.75, 0.75), craneYellow)
    arm.position.x = 11.5
    arm.castShadow = true
    jib.add(arm)
    const counter = new THREE.Mesh(new THREE.BoxGeometry(7, 0.75, 0.75), craneYellow)
    counter.position.x = -4.2
    jib.add(counter)
    const weight = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.0, 1.3), mats.concrete)
    weight.position.set(-7.2, -0.4, 0)
    jib.add(weight)
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 13, 5), mats.metalDark)
    cable.position.set(19.5, -6.6, 0)
    jib.add(cable)
    const hookLoad = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 1.1), mats.metalDark)
    hookLoad.position.set(19.5, -13.4, 0)
    jib.add(hookLoad)
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#ff4a3a', toneMapped: false }),
    )
    beacon.position.set(0, 1.35, 0)
    jib.add(beacon)
    site.add(jib)
    colliders.push({ minX: -21.3, maxX: -18.7, minZ: 146.7, maxZ: 149.3, h: 31 })
    group.add(site)

    // ==========================================================
    // 6. WIND TURBINES (east of the boundary wall, on the horizon)
    //    Real proportions: tapered tower, rounded nacelle, spinner
    //    cone, twisted tapering blades, aviation band + beacon.
    // ==========================================================
    const rotors: { group: THREE.Group; phase: number; speed: number }[] = []
    // always-lit white: at 500+ m the lit-only material turned unlit turbine
    // faces into black silhouettes on the horizon
    const turbineWhite = new THREE.MeshBasicMaterial({ color: '#dde0da' })
    const turbineAt = (x: number, z: number, h: number, phase: number) => {
      const tw = new THREE.Group()
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.6, h, 12), turbineWhite)
      tower.position.y = h / 2
      tower.castShadow = true
      tw.add(tower)
      // base flange + service door
      const flange = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.85, 0.5, 12), mats.concreteLight)
      flange.position.y = 0.25
      tw.add(flange)
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.12), mats.metalDark)
      door.position.set(0, 0.85, 1.52)
      tw.add(door)
      // aviation band near the top
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.87, 0.9, 2.4, 12), mats.neonRed)
      band.position.y = h - 1.4
      tw.add(band)
      // nacelle: rounded can (cylinder) + tapered tail
      const nac = new THREE.Group()
      nac.position.set(-0.4, h + 0.55, 0)
      const nacBody = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 3.4, 12), turbineWhite)
      nacBody.rotation.z = Math.PI / 2
      nac.add(nacBody)
      const nacTail = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.6, 12), turbineWhite)
      nacTail.rotation.z = -Math.PI / 2
      nacTail.position.x = -2.5
      nac.add(nacTail)
      // aviation beacon on the nacelle
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff4136', toneMapped: false }))
      beacon.position.set(0.6, 1.15, 0)
      nac.add(beacon)
      tw.add(nac)
      // rotor: spinner cone + 3 tapered, slightly twisted blades
      const rotor = new THREE.Group()
      rotor.position.set(-2.4, h + 0.55, 0)
      const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.5, 10), turbineWhite)
      spinner.rotation.z = Math.PI / 2
      spinner.position.x = -0.5
      rotor.add(spinner)
      const bladeLen = h * 0.36
      const bladeGeo = new THREE.BoxGeometry(0.55, bladeLen, 0.12, 1, 6, 1)
      const bp = bladeGeo.attributes.position as THREE.BufferAttribute
      for (let vi = 0; vi < bp.count; vi++) {
        const y = bp.getY(vi)
        const t = (y + bladeLen / 2) / bladeLen // 0 root → 1 tip
        bp.setX(vi, bp.getX(vi) * (1 - 0.72 * t))
        bp.setZ(vi, bp.getZ(vi) * (1 - 0.55 * t) + Math.sin(t * 2.2) * 0.18)
      }
      bp.needsUpdate = true
      bladeGeo.computeVertexNormals()
      bladeGeo.translate(0, bladeLen / 2 + 0.5, 0)
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(bladeGeo, turbineWhite)
        blade.rotation.x = (i * Math.PI * 2) / 3
        blade.castShadow = true
        rotor.add(blade)
      }
      tw.add(rotor)
      tw.position.set(x, 0, z)
      group.add(tw)
      rotors.push({ group: rotor, phase, speed: 1 })
    }
    turbineAt(630, 300, 44, 0)
    turbineAt(650, 382, 50, 2.1)
    turbineAt(632, 462, 44, 4.2)

    // solar canopy over the bus depot apron
    const panelMat = new THREE.MeshStandardMaterial({ color: '#22303a', roughness: 0.35, metalness: 0.6 })
    const canopyPosts: { x: number; y: number; z: number }[] = []
    const canopyFrames: THREE.BufferGeometry[] = []
    const panelGeos: THREE.BufferGeometry[] = []
    for (const px of [356, 363, 370, 377]) {
      for (const pz of [359.5, 377]) canopyPosts.push({ x: px, y: 2.1, z: pz })
      for (const pz of [359.5, 377]) {
        const beam = new THREE.BoxGeometry(0.14, 0.14, 17.5)
        beam.translate(px, 4.15, 368.25)
        canopyFrames.push(beam)
      }
      for (const pz of [363.6, 372.9]) {
        const panel = new THREE.BoxGeometry(6.4, 0.09, 2.1)
        panel.rotateX(0.34)
        panel.translate(px, 4.42, pz)
        panelGeos.push(panel)
      }
    }
    makeIM(new THREE.CylinderGeometry(0.11, 0.13, 4.2, 6), mats.metalDark, canopyPosts, undefined, false)
    addMerged(canopyFrames, mats.metalDark, false)
    addMerged(panelGeos, panelMat)

    // crane works like a real one: slew to a target, pause, sometimes lift
    // or lower the hook load, then pick a new heading — never a constant spin
    let craneYaw = 0.6
    let craneTarget = 2.1
    let cranePause = 1.5
    let hoist = 0.55 // 0 = hook near the jib, 1 = load near the ground
    let hoistTarget = 0.55
    jib.rotation.y = craneYaw
    let prevT = 0

    animators.push((t: number) => {
      const dt = Math.min(0.1, Math.max(0, t - prevT))
      prevT = t
      // --- crane ---
      if (cranePause > 0) {
        cranePause -= dt
        if (cranePause <= 0) {
          craneTarget = craneYaw + (rng() - 0.5) * 3.4
          hoistTarget = 0.15 + rng() * 0.65
        }
      } else {
        const dy = craneTarget - craneYaw
        const step = 0.16 * dt
        if (Math.abs(dy) <= step) {
          craneYaw = craneTarget
          cranePause = 2.5 + rng() * 5.5
        } else {
          craneYaw += Math.sign(dy) * step
        }
        const dh = hoistTarget - hoist
        const hstep = 0.1 * dt
        hoist += Math.abs(dh) <= hstep ? 0 : Math.sign(dh) * hstep
      }
      jib.rotation.y = craneYaw
      const cableLen = 2.5 + hoist * 10.5
      cable.scale.y = cableLen / 13
      cable.position.y = -cableLen / 2
      hookLoad.position.y = -cableLen - 0.7
      beacon.visible = (t % 1.3) < 0.8
      // --- turbines: gusts change rotor speed over time ---
      for (const r of rotors) {
        r.speed = 0.55 + 0.45 * Math.sin(t * 0.09 + r.phase * 2.7) + 0.15 * Math.sin(t * 0.31 + r.phase)
        r.group.rotation.x += r.speed * dt
      }
    })
  }

  /* ============================================================
   * 7. INDUSTRIAL RAIL YARD
   * ============================================================ */
  {
    // ballast + rails along z=590 from x=250..600
    const ballast = new THREE.Mesh(new THREE.BoxGeometry(350, 0.1, 4.2), mats.gravel)
    ballast.position.set(425, 0.05, 590)
    ballast.receiveShadow = true
    group.add(ballast)
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(350, 0.12, 0.1), mats.metalDark)
      rail.position.set(425, 0.14, 590 + s * 0.75)
      group.add(rail)
    }
    const sleepers: { x: number; y: number; z: number }[] = []
    for (let x = 252; x < 600; x += 1.6) sleepers.push({ x, y: 0.08, z: 590 })
    makeIM(new THREE.BoxGeometry(0.24, 0.1, 2.4), mats.wood, sleepers, undefined, false)

    // freight train parked
    const trainCars: THREE.BufferGeometry[] = []
    // consist split AROUND the x=400 arterial (392..408): the old loco sat at
    // x=390 and the first wagon at x=412 — both physically blocking the road's
    // lanes at the level crossing. Loco now fully west, wagons fully east.
    const loco = new THREE.Mesh(new THREE.BoxGeometry(14, 3.4, 3.0), mats.metalDark)
    loco.position.set(376, 1.9, 590)
    loco.castShadow = true
    group.add(loco)
    const cab = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 2.8), mats.fabricOrange)
    cab.position.set(372.5, 3.9, 590)
    cab.castShadow = true
    group.add(cab)
    colliders.push({ minX: 369, maxX: 383, minZ: 588.5, maxZ: 591.5, h: 4.6 })
    const wagonColors = ['#8c5a3a', '#5b6b4a', '#7a7d80', '#6b5a4a']
    for (let i = 0; i < 4; i++) {
      const wx = 421 + i * 13
      const wagon = new THREE.Mesh(new THREE.BoxGeometry(11, 2.8, 2.9), new THREE.MeshStandardMaterial({ color: wagonColors[i], roughness: 0.7, metalness: 0.3 }))
      wagon.position.set(wx, 1.7, 590)
      wagon.castShadow = true
      group.add(wagon)
      if (i === 1) {
        const container = new THREE.Mesh(new THREE.BoxGeometry(10, 2.4, 2.4), mats.fabricOrange)
        container.position.set(wx, 4.2, 590)
        group.add(container)
      }
      colliders.push({ minX: wx - 5.5, maxX: wx + 5.5, minZ: 588.5, maxZ: 591.5, h: 3.1 })
    }
    void trainCars

    // chain-link fence along industrial N and W edges — hugs the industrial
    // side of the z=300 / x=300 local roads (7 m wide → curb at 303.5).
    // The old copies stood IN the roadway (z/x = 297.5), and fenceW had its
    // PlaneGeometry args swapped: 2.4 × 280 rotated = a 280 m TALL wall
    // shooting into the sky instead of a 2.4 m fence.
    const fenceMat = getFenceMaterial()
    const fenceN = new THREE.Mesh(new THREE.PlaneGeometry(280, 2.4), fenceMat)
    fenceN.position.set(445, 1.2, 307.5)
    group.add(fenceN)
    const fenceW = new THREE.Mesh(new THREE.PlaneGeometry(280, 2.4), fenceMat)
    fenceW.rotation.y = Math.PI / 2
    fenceW.position.set(307.5, 1.2, 445)
    group.add(fenceW)
    const fencePosts: { x: number; y: number; z: number }[] = []
    for (let x = 315; x < 590; x += 10) fencePosts.push({ x, y: 1.2, z: 307.5 })
    for (let z = 315; z < 590; z += 10) fencePosts.push({ x: 307.5, y: 1.2, z })
    makeIM(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5), mats.metalDark, fencePosts, undefined, false)

    // trailers near depot
    for (let i = 0; i < 3; i++) {
      const trailer = new THREE.Mesh(new THREE.BoxGeometry(9, 2.8, 2.6), new THREE.MeshStandardMaterial({ color: ['#d8d4cc', '#8c4a3a', '#5b7461'][i], roughness: 0.6, metalness: 0.2 }))
      trailer.position.set(620 - i * 0, 1.5, 620)
      trailer.visible = false
      group.add(trailer)
    }
  }

  /* ============================================================
   * 8a. STREET MICRO-DETAIL — manholes, drain grates, street-name
   *     signs on signal poles, balcony flower boxes, yard hedges.
   * ============================================================ */
  {
    // --- manhole covers on the car lanes (skip junction areas) ---
    const manholes: { x: number; y: number; z: number }[] = []
    const grates: { x: number; y: number; z: number; ry: number }[] = []
    for (const road of plan.roads) {
      if (road.pedestrianOnly) continue
      const hw = roadHalfWidth(road.cls, road.coord)
      for (let pos = road.from + 22; pos < road.to - 22; pos += 37) {
        if (nearIntersection(road.axis === 'x' ? pos : road.coord, road.axis === 'x' ? road.coord : pos, 13)) continue
        const laneOff = (pos % 74) < 37 ? 2.4 : -2.4
        const mx = road.axis === 'x' ? pos : road.coord + laneOff
        const mz = road.axis === 'x' ? road.coord + laneOff : pos
        if (road.cls === 'arterial' && road.coord === 0 && Math.abs(laneOff) < 3.2) continue // keep the tram bed clean
        manholes.push({ x: mx, y: 0.026, z: mz })
        // curb drain grate every other spot, on the right edge
        if (Math.abs(pos % 74) < 2) {
          const gx = road.axis === 'x' ? pos + 6 : road.coord + (hw - 0.55) * (laneOff > 0 ? 1 : -1)
          const gz = road.axis === 'x' ? road.coord + (hw - 0.55) * (laneOff > 0 ? 1 : -1) : pos + 6
          grates.push({ x: gx, y: 0.024, z: gz, ry: road.axis === 'x' ? 0 : Math.PI / 2 })
        }
      }
    }
    const manholeGeo = mergeGeometries(
      [new THREE.CircleGeometry(0.42, 14).rotateX(-Math.PI / 2).translate(0, 0, 0), new THREE.RingGeometry(0.42, 0.5, 14).rotateX(-Math.PI / 2)],
      true,
    )!
    makeIM(manholeGeo, new THREE.MeshStandardMaterial({ color: '#4a4a4c', roughness: 0.5, metalness: 0.7 }), manholes, undefined, false)
    const grateGeo = mergeGeometries(
      [
        new THREE.BoxGeometry(0.7, 0.05, 0.4),
        new THREE.BoxGeometry(0.62, 0.06, 0.06).translate(0, 0.005, -0.12),
        new THREE.BoxGeometry(0.62, 0.06, 0.06).translate(0, 0.005, 0),
        new THREE.BoxGeometry(0.62, 0.06, 0.06).translate(0, 0.005, 0.12),
      ],
      false,
    )!
    makeIM(grateGeo, new THREE.MeshStandardMaterial({ color: '#3c3c3e', roughness: 0.55, metalness: 0.75 }), grates.map((g) => ({ x: g.x, y: g.y, z: g.z, ry: g.ry })), undefined, false)

    // --- street-name signs on two diagonal signal-pole corners per junction ---
    {
      const namePoles: { x: number; y: number; z: number }[] = []
      for (const tl of plan.trafficLights) {
        const ns = `${Math.abs(tl.z) || 'CENTRAL'} AVE`
        const ew = `${Math.abs(tl.x) || 'CENTRAL'} ST`
        for (const [px, pz, name] of [
          [tl.x - 12.5, tl.z - 12.5, ns],
          [tl.x + 12.5, tl.z + 12.5, ew],
        ] as const) {
          namePoles.push({ x: px, y: 2.6, z: pz })
          const board = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.4), mats.signMaterial(name, { bg: '#1f4d38', fg: '#f0f5e8', w: 256, h: 56 }))
          board.position.set(px, 5.0, pz)
          group.add(board)
          const board2 = board.clone()
          board2.rotation.y = Math.PI
          group.add(board2)
        }
      }
      makeIM(new THREE.CylinderGeometry(0.05, 0.06, 5.2, 6), mats.poleMetal, namePoles, undefined, false)
    }

    // --- flower boxes under windows of low/mid residential facades ---
    const fBoxes: { x: number; y: number; z: number; ry: number }[] = []
    const fBlooms: { x: number; y: number; z: number }[] = []
    for (const b of plan.buildings) {
      if (b.kind !== 'residential' && b.kind !== 'apartment') continue
      if (b.floors < 2 || b.floors > 7) continue
      const rot = (b.rotation * Math.PI) / 180
      const n = 2 + Math.floor(rng() * 3)
      for (let i = 0; i < n; i++) {
        if (rng() < 0.3) continue
        const lx = -b.w / 2 + 2 + (b.w - 4) * (i / Math.max(1, n - 1)) + (rng() - 0.5) * 1.4
        const ly = 2.35 + Math.floor(rng() * Math.min(3, b.floors - 1)) * 2.9
        const local = new THREE.Vector3(lx, ly, b.d / 2 + 0.22).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot)
        fBoxes.push({ x: b.x + local.x, y: ly, z: b.z + local.z, ry: rot })
        for (let fl = 0; fl < 3; fl++) {
          fBlooms.push({
            x: b.x + local.x + (rng() - 0.5) * 0.7,
            y: ly + 0.24,
            z: b.z + local.z + (rng() - 0.5) * 0.16,
          })
        }
      }
    }
    makeIM(
      mergeGeometries([new THREE.BoxGeometry(0.95, 0.26, 0.24), new THREE.BoxGeometry(0.85, 0.1, 0.18).translate(0, 0.16, 0)], false)!,
      mats.wood,
      fBoxes,
      undefined,
      false,
    )
    makeIM(new THREE.SphereGeometry(0.075, 6, 5), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }), fBlooms, (i) => new THREE.Color(['#d84a3a', '#e8a03a', '#e8e0d0', '#c94f7c'][i % 4]), false)

    // --- low hedges along the front edges of residential-low blocks ---
    const hedgeGeos: THREE.BufferGeometry[] = []
    for (const b of plan.blocks) {
      if (b.zone !== 'residential-low') continue
      for (const edge of [0, 1]) {
        // two front edges per block (south + north) with gaps for paths
        const z = edge === 0 ? b.z0 + 4.5 : b.z1 - 4.5
        for (let x = b.x0 + 8; x < b.x1 - 8; x += 5) {
          if (rng() < 0.22) continue
          if (inCorridor(x, z)) continue
          const seg = new THREE.BoxGeometry(4.2, 0.85, 0.7)
          seg.translate(x, 0.42, z)
          hedgeGeos.push(seg)
          colliders.push({ minX: x - 2.1, maxX: x + 2.1, minZ: z - 0.35, maxZ: z + 0.35, h: 0.9 })
        }
      }
    }
    addMerged(hedgeGeos, new THREE.MeshStandardMaterial({ color: '#3f6134', roughness: 1 }))

    // --- rain puddle sites (decals shown only while it rains; see weather.ts) ---
    // guaranteed downtown puddles (plaza, market front, car-free street)
    for (const [px, pz, ps] of [
      [45, -55, 1.6], [58, -44, 1.2], [36, -68, 1.4], [70, -38, 1.1],
      [-76, -32, 1.5], [-66, -42, 1.2], [30, 100, 1.6], [-42, 100, 1.3],
      [14, -18, 1.0], [84, -78, 1.3],
    ] as const) {
      puddleSpots.push({ x: px, z: pz, s: ps })
    }
    for (let i = 0; i < 46; i++) {
      const bx = -550 + rng() * 1100
      const bz = -550 + rng() * 1100
      if (inCorridor(bx, bz)) continue
      if (nearIntersection(bx, bz, 12)) continue
      puddleSpots.push({ x: bx, z: bz, s: 0.7 + rng() * 1.6 })
    }
  }

  /* ============================================================
   * 8b. GARBAGE & RECYCLING — realistic wheelie bins (body, lid,
   *     wheels) + steel dumpster containers at service spots.
   * ============================================================ */
  {
    const binBodies: { x: number; y: number; z: number; ry: number }[] = []
    const binLids: { x: number; y: number; z: number; ry: number }[] = []
    const addBin = (x: number, z: number, ry: number) => {
      if (inCorridor(x, z) || distToRoadCorridor(x, z) < 0.5) return // never on the street
      binBodies.push({ x, y: 0.5, z, ry })
      binLids.push({ x, y: 0.96, z, ry })
    }
    // rows of bins behind the market, at the depot, schools & apartments
    for (let i = 0; i < 5; i++) {
      addBin(-88 + i * 0.85, -34.5, 0) // market rear court
      addBin(340 + (i % 3) * 0.9, 356 + Math.floor(i / 3) * 1.2, 0.3) // depot
      addBin(-272 + (i % 2) * 0.9, -244 + Math.floor(i / 2) * 1.1, Math.PI / 2) // school west
      addBin(64 + (i % 3) * 0.9, -88 + Math.floor(i / 3) * 1.0, Math.PI) // downtown plaza rear
    }
    // wheelie bin: tapered body + lid + two rear wheels + handle bar
    const binGeo = mergeGeometries(
      [
        new THREE.BoxGeometry(0.58, 0.86, 0.5).translate(0, 0, 0.02),
        new THREE.BoxGeometry(0.5, 0.1, 0.08).translate(0, 0.38, -0.3), // handle bar
      ],
      false,
    )!
    const binLidGeo = mergeGeometries([new THREE.BoxGeometry(0.6, 0.09, 0.54).translate(0, 0, 0)], false)!
    const binWheelGeo = mergeGeometries(
      [new THREE.CylinderGeometry(0.09, 0.09, 0.06, 8).rotateZ(Math.PI / 2).translate(-0.22, -0.4, -0.18), new THREE.CylinderGeometry(0.09, 0.09, 0.06, 8).rotateZ(Math.PI / 2).translate(0.22, -0.4, -0.18)],
      false,
    )!
    const binMat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: getBinGrimeTexture(), roughness: 0.7, metalness: 0.05 })
    makeIM(binGeo, binMat, binBodies, (i) => new THREE.Color(['#3f6d54', '#4a5a50', '#5c5f4a', '#6a5a3a'][i % 4]))
    makeIM(binLidGeo, binMat, binLids, (i) => new THREE.Color(['#35594a', '#40504a', '#4f5240', '#5a4c32'][i % 4]))
    makeIM(binWheelGeo, mats.metalDark, binBodies, undefined, false)
    // steel front-load dumpsters at service yards — realistic build:
    // tapered two-part body, top rim, rear casters, front fork pockets and
    // two lids HINGED at the rear edge (open to per-dumpster angles).
    // Merged per material bucket, split into 3 paint schemes for variety.
    const dumpSpots = GARBAGE_SPOTS.filter(([qx, qz]) => distToRoadCorridor(qx, qz) > 0.5)
    {
      // 3 paint schemes × (body, lid) — grime texture is neutral so the
      // per-scheme color provides the hue
      const bodyGeos: THREE.BufferGeometry[][] = [[], [], []]
      const lidGeos: THREE.BufferGeometry[][] = [[], [], []]
      const casterGeos: THREE.BufferGeometry[] = []
      const darkGeos: THREE.BufferGeometry[] = []
      const rotM = new THREE.Matrix4()
      const paintSchemes = ['#3d5c4a', '#51605c', '#6e4a38'] // green / slate / rust
      const lidColors = ['#31493c', '#414e4a', '#593a2c']
      const grimeMat = new THREE.MeshStandardMaterial({ map: getBinGrimeTexture(), roughness: 0.78, metalness: 0.35 })
      dumpSpots.forEach(([dx0, dz0, dry], di) => {
        const rngD = mulberry32(4100 + di * 13)
        const scheme = di % 3
        // local translate → rotate about Y → place at the yard position
        const put = (g: THREE.BufferGeometry, ox: number, oy: number, oz: number) => {
          g.translate(ox, oy, oz)
          rotM.makeRotationY(dry)
          g.applyMatrix4(rotM)
          g.translate(dx0, 0, dz0)
          return g
        }
        // tapered body: lower box + slightly inset upper box + proud top rim
        const lower = new THREE.BoxGeometry(3.4, 0.98, 1.7)
        put(lower, 0, 0.64, 0)
        bodyGeos[scheme].push(lower)
        const upper = new THREE.BoxGeometry(3.26, 0.52, 1.58)
        put(upper, 0, 1.36, 0)
        bodyGeos[scheme].push(upper)
        const rim = new THREE.BoxGeometry(3.48, 0.12, 1.78)
        put(rim, 0, 1.67, 0)
        darkGeos.push(rim)
        // front fork pockets (two dark sleeves the truck's forks enter)
        for (const px of [-0.6, 0.6]) {
          const pocket = new THREE.BoxGeometry(0.6, 0.32, 0.4)
          put(pocket, px, 0.42, 0.85)
          darkGeos.push(pocket)
        }
        // rear swivel casters (wheel + fork bracket)
        for (const cx of [-1.15, 1.15]) {
          const wheel = new THREE.CylinderGeometry(0.13, 0.13, 0.09, 10)
          wheel.rotateZ(Math.PI / 2)
          put(wheel, cx, 0.13, -0.52)
          casterGeos.push(wheel)
          const bracket = new THREE.BoxGeometry(0.07, 0.24, 0.2)
          put(bracket, cx, 0.32, -0.52)
          casterGeos.push(bracket)
        }
        // two lids hinged along the REAR top edge, swung open — each
        // dumpster gets its own pair of angles so no two look identical
        const angL = 0.45 + rngD() * 0.55
        const angR = 0.2 + rngD() * 0.4
        for (const [hx, ang] of [
          [-0.82, angL],
          [0.82, angR],
        ] as const) {
          const lid = new THREE.BoxGeometry(1.6, 0.07, 1.8)
          lid.translate(0, 0.035, 0.9) // hinge axis at local z=0 (rear edge)
          lid.rotateX(-ang) // free edge lifts up toward the front
          put(lid, hx, 1.72, -0.9)
          lidGeos[scheme].push(lid)
        }
        colliders.push({ minX: dx0 - 1.8, maxX: dx0 + 1.8, minZ: dz0 - 1.0, maxZ: dz0 + 1.0, h: 1.75 })
      })
      bodyGeos.forEach((geos, i) => {
        const mat = grimeMat.clone()
        mat.color = new THREE.Color(paintSchemes[i])
        addMerged(geos, mat)
      })
      lidGeos.forEach((geos, i) => {
        const mat = grimeMat.clone()
        mat.color = new THREE.Color(lidColors[i])
        addMerged(geos, mat)
      })
      addMerged(casterGeos, mats.metalDark, false)
      addMerged(darkGeos, mats.metalDark)
    }
  }

  /* ============================================================
   * 8c. STREET LIFE PROPS — red pillar post boxes, lit poster
   *     columns, park drinking fountains, market banners across
   *     the car-free street. All corridor-validated.
   * ============================================================ */
  {
    const propOk = (x: number, z: number, clearance = 1.4) =>
      distToRoadCorridor(x, z) > clearance && !nearIntersection(x, z, 13) && !nearCrosswalk(x, z, 7)

    // --- red pillar post boxes (classic cylinder + dome + slot) ---
    const postboxSpots: { x: number; y: number; z: number; ry: number }[] = []
    for (const [px, pz, pr] of [
      [10, -18, Math.PI / 2], [88, -50, -Math.PI / 2], [-84, -28, Math.PI / 2],
      [-30, 92.5, 0], [60, 107.5, Math.PI], [130, -212, Math.PI / 2], [-228, 190, -Math.PI / 2], [58, -186, Math.PI],
    ] as const) {
      if (propOk(px, pz, 2.0)) postboxSpots.push({ x: px, y: 0, z: pz, ry: pr })
    }
    const postboxGeo = mergeGeometries(
      [
        new THREE.CylinderGeometry(0.34, 0.36, 1.12, 10).translate(0, 0.68, 0),
        new THREE.SphereGeometry(0.34, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.24, 0),
        new THREE.BoxGeometry(0.3, 0.05, 0.05).translate(0, 1.06, 0.335),
        new THREE.CylinderGeometry(0.4, 0.42, 0.14, 10).translate(0, 0.07, 0),
      ],
      false,
    )!
    makeIM(postboxGeo, new THREE.MeshStandardMaterial({ color: '#c23a2e', roughness: 0.45, metalness: 0.15 }), postboxSpots)
    for (const p of postboxSpots) colliders.push({ minX: p.x - 0.42, maxX: p.x + 0.42, minZ: p.z - 0.42, maxZ: p.z + 0.42, h: 1.4 })

    // --- lit poster columns (Litfaßsäule) — 3 rotating poster designs ---
    const posterSpots: { x: number; z: number; v: number }[] = []
    for (const [px, pz] of [[16, -22], [82, -70], [-64, 24], [-46, 92.5], [110, 107.5], [66, -140]] as const) {
      if (propOk(px, pz, 2.0)) posterSpots.push({ x: px, z: pz, v: posterSpots.length % 3 })
    }
    const posterMaterial = (v: number) => {
      const [c, ctx] = canvas(256, 384)
      const bgs = ['#e8e0cc', '#20342a', '#d8a832']
      ctx.fillStyle = bgs[v]
      ctx.fillRect(0, 0, 256, 384)
      if (v === 0) {
        ctx.fillStyle = '#1f4d38'
        ctx.fillRect(0, 0, 256, 84)
        ctx.fillStyle = '#f0f5e8'
        ctx.font = 'bold 40px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('SOLHEIM', 128, 56)
        ctx.fillStyle = '#3a3a3c'
        ctx.font = 'bold 26px Arial'
        ctx.fillText('MARKT', 128, 150)
        ctx.font = '20px Arial'
        ctx.fillText('every Saturday', 128, 186)
        ctx.fillText('09:00 – 15:00', 128, 214)
        ctx.fillStyle = '#8c2f26'
        ctx.fillRect(28, 250, 200, 4)
        ctx.font = '18px Arial'
        ctx.fillStyle = '#3a3a3c'
        ctx.fillText('local · seasonal · car-free', 128, 300)
      } else if (v === 1) {
        ctx.fillStyle = '#f0f5e8'
        ctx.font = 'bold 34px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('15-MINUTE', 128, 90)
        ctx.fillText('CITY', 128, 130)
        ctx.font = '19px Arial'
        ctx.fillText('work · shop · learn', 128, 180)
        ctx.fillText('within a short walk', 128, 208)
        ctx.fillStyle = '#d8a832'
        ctx.fillRect(64, 250, 128, 60)
        ctx.fillStyle = '#20342a'
        ctx.font = 'bold 30px Arial'
        ctx.fillText('SOLHEIM', 128, 290)
      } else {
        ctx.fillStyle = '#20342a'
        ctx.font = 'bold 30px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('TRAM & BUS', 128, 70)
        ctx.fillStyle = '#f0f5e8'
        ctx.font = 'bold 52px Arial'
        ctx.fillText('T1', 128, 150)
        ctx.fillText('T2', 128, 220)
        ctx.font = '20px Arial'
        ctx.fillStyle = '#d8a832'
        ctx.fillText('every 6 minutes', 128, 290)
      }
      const t3 = tex(c, false)
      return new THREE.MeshStandardMaterial({ map: t3, emissive: '#ffffff', emissiveMap: t3, emissiveIntensity: 0.42, roughness: 0.8 })
    }
    {
      const capGeos: THREE.BufferGeometry[] = []
      const colGeos: THREE.BufferGeometry[][] = [[], [], []]
      for (const p of posterSpots) {
        const cap = mergeGeometries(
          [
            new THREE.CylinderGeometry(0.56, 0.6, 0.22, 12).translate(0, 0.11, 0),
            new THREE.ConeGeometry(0.58, 0.42, 12).translate(0, 0.43, 0),
            new THREE.CylinderGeometry(0.62, 0.64, 0.16, 12).translate(0, 0.08, 0),
          ],
          false,
        )!
        cap.translate(p.x, 2.86, p.z)
        capGeos.push(cap)
        const col = new THREE.CylinderGeometry(0.46, 0.46, 2.6, 12, 1, true)
        col.translate(p.x, 1.56, p.z)
        colGeos[p.v].push(col)
        colliders.push({ minX: p.x - 0.6, maxX: p.x + 0.6, minZ: p.z - 0.6, maxZ: p.z + 0.6, h: 3.4 })
      }
      for (let v = 0; v < 3; v++) {
        if (!colGeos[v].length) continue
        const merged = mergeGeometries(colGeos[v], false)
        if (merged) {
          const m = new THREE.Mesh(merged, posterMaterial(v))
          m.castShadow = true
          group.add(m)
        }
      }
      addMerged(capGeos, mats.metalDark)
    }

    // --- drinking fountains (stone pedestal + basin + spout) ---
    const fountainSpots: { x: number; y: number; z: number }[] = []
    for (const [px, pz] of [
      [-61, -345], [49, -345], [-61, -255], [49, -255],
      [-20, -18], [-150, 352], [148, 52], [252, -66],
    ] as const) {
      if (propOk(px, pz, 1.6)) fountainSpots.push({ x: px, y: 0, z: pz })
    }
    const fountainGeo = mergeGeometries(
      [
        new THREE.CylinderGeometry(0.15, 0.2, 0.86, 8).translate(0, 0.43, 0),
        new THREE.CylinderGeometry(0.3, 0.24, 0.12, 10).translate(0, 0.9, 0),
        new THREE.TorusGeometry(0.1, 0.025, 5, 8, Math.PI / 2).rotateY(0).translate(0, 1.0, 0.16),
      ],
      false,
    )!
    makeIM(fountainGeo, mats.concreteLight, fountainSpots)
    const fountainWater: { x: number; y: number; z: number }[] = fountainSpots.map((f) => ({ x: f.x, y: 0.95, z: f.z }))
    makeIM(new THREE.CircleGeometry(0.24, 10).rotateX(-Math.PI / 2), mats.water, fountainWater, undefined, false)

    // --- banners across the car-free street (z = 100) ---
    {
      const [bc, bctx] = canvas(512, 72)
      bctx.fillStyle = '#1f4d38'
      bctx.fillRect(0, 0, 512, 72)
      bctx.fillStyle = '#d8a832'
      bctx.fillRect(0, 0, 14, 72)
      bctx.fillRect(498, 0, 14, 72)
      bctx.fillStyle = '#f0f5e8'
      bctx.font = 'bold 34px Arial'
      bctx.textAlign = 'center'
      bctx.textBaseline = 'middle'
      bctx.fillText('SOLHEIM  ·  CAR-FREE STREET  ·  SOLHEIM', 256, 38)
      const bannerMat = new THREE.MeshStandardMaterial({ map: tex(bc, false), roughness: 0.85, side: THREE.DoubleSide })
      const bannerPoles: { x: number; y: number; z: number }[] = []
      const bannerGeos: THREE.BufferGeometry[] = []
      for (const bx of [-150, 50, 150] as const) {
        // banners intentionally SPAN the car-free street — only avoid the
        // signalized crossings along it
        if (nearIntersection(bx, 100, 14)) continue
        for (const s of [-1, 1]) bannerPoles.push({ x: bx, y: 3.1, z: 100 + s * 3.6 })
        const b = new THREE.PlaneGeometry(6.9, 0.92)
        b.rotateY(Math.PI / 2)
        b.rotateZ(0.015)
        b.translate(bx, 5.62, 100)
        bannerGeos.push(b)
        // colliders for the two POLES only — the old single collider spanned
        // the whole street (minZ 96.2 → maxZ 103.8) = an invisible wall
        // across the car-free street at ground level while the banner is
        // 5.6 m overhead
        colliders.push({ minX: bx - 0.14, maxX: bx + 0.14, minZ: 100 - 3.6 - 0.14, maxZ: 100 - 3.6 + 0.14, h: 3.1 })
        colliders.push({ minX: bx - 0.14, maxX: bx + 0.14, minZ: 100 + 3.6 - 0.14, maxZ: 100 + 3.6 + 0.14, h: 3.1 })
      }
      if (bannerGeos.length) {
        const bannerMesh = new THREE.Mesh(mergeGeometries(bannerGeos, false)!, bannerMat)
        bannerMesh.castShadow = true
        group.add(bannerMesh)
        makeIM(new THREE.CylinderGeometry(0.07, 0.09, 6.2, 6), mats.metalDark, bannerPoles)
      }
    }
  }

  /* ============================================================
   * 8d. TRAFFIC SIGNS — speed-limit circles per street class +
   *     crossing-warning triangles, on thin posts facing oncoming
   *     traffic (visual layer of the transport hierarchy).
   * ============================================================ */
  {
    const signTexCircle = (label: string) => {
      const [c, ctx] = canvas(128, 128)
      ctx.fillStyle = '#f4f2ea'
      ctx.beginPath()
      ctx.arc(64, 64, 60, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#b0322a'
      ctx.lineWidth = 14
      ctx.beginPath()
      ctx.arc(64, 64, 51, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = '#1c1c1e'
      ctx.font = 'bold 52px Arial'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, 64, 68)
      const t2 = tex(c, false)
      return new THREE.MeshStandardMaterial({ map: t2, roughness: 0.5, emissive: '#ffffff', emissiveMap: t2, emissiveIntensity: 0.12 })
    }
    const limitMats: Record<string, THREE.MeshStandardMaterial> = {
      '50': signTexCircle('50'),
      '40': signTexCircle('40'),
      '30': signTexCircle('30'),
    }
    const crossingMat = (() => {
      const [c, ctx] = canvas(128, 116)
      ctx.fillStyle = '#f4f2ea'
      ctx.beginPath()
      ctx.moveTo(64, 6)
      ctx.lineTo(122, 108)
      ctx.lineTo(6, 108)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = '#b0322a'
      ctx.lineWidth = 9
      ctx.lineJoin = 'round'
      ctx.stroke()
      ctx.fillStyle = '#1c1c1e'
      ctx.beginPath()
      ctx.arc(64, 52, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillRect(58, 60, 12, 26)
      ctx.fillRect(48, 84, 12, 20)
      ctx.fillRect(68, 84, 12, 20)
      const t2 = tex(c, false)
      return new THREE.MeshStandardMaterial({ map: t2, roughness: 0.5, emissive: '#ffffff', emissiveMap: t2, emissiveIntensity: 0.12 })
    })()
    const signPoles: { x: number; y: number; z: number }[] = []
    const backs: { x: number; y: number; z: number; ry: number }[] = []
    const speed50: { x: number; y: number; z: number; ry: number }[] = []
    const speed40: { x: number; y: number; z: number; ry: number }[] = []
    const speed30: { x: number; y: number; z: number; ry: number }[] = []
    const crossSigns: { x: number; y: number; z: number; ry: number }[] = []
    const addSign = (x: number, z: number, ry: number, kind: '50' | '40' | '30' | 'cross') => {
      signPoles.push({ x, y: 1.35, z })
      backs.push({ x, y: 2.5, z, ry: ry + Math.PI })
      const item = { x, y: 2.5, z, ry }
      if (kind === '50') speed50.push(item)
      else if (kind === '40') speed40.push(item)
      else if (kind === '30') speed30.push(item)
      else crossSigns.push(item)
    }
    for (const road of plan.roads) {
      if (road.pedestrianOnly) continue
      const hw = roadHalfWidth(road.cls, road.coord)
      const kind = road.cls === 'arterial' ? '50' : road.cls === 'collector' ? '40' : '30'
      let n = 0
      for (let pos = road.from + 48; pos < road.to - 48; pos += 136, n++) {
        const cx = road.axis === 'x' ? pos : road.coord
        const cz = road.axis === 'x' ? road.coord : pos
        if (nearIntersection(cx, cz, 17)) continue
        // alternate travel direction each sign: side + facing follow right-hand rule
        const dir: 1 | -1 = n % 2 === 0 ? 1 : -1
        const off = hw + 0.75
        let sx: number, sz: number, ry: number
        if (road.axis === 'x') {
          sx = pos
          sz = road.coord - dir * off // right side of travel
          ry = dir > 0 ? -Math.PI / 2 : Math.PI / 2 // face oncoming (normal = -travel)
        } else {
          sx = road.coord + dir * off
          sz = pos
          ry = dir > 0 ? Math.PI : 0
        }
        if (distToRoadCorridor(sx, sz) < 0.3) continue
        addSign(sx, sz, ry, kind)
      }
    }
    // crossing-warning triangles upstream of each x-axis crosswalk
    // (facing +x traffic approaching the zebra)
    for (const cw of plan.crosswalks) {
      if (cw.axis !== 'x') continue
      if (crossSigns.length > 90) break
      const hw = roadHalfWidth(cw.roadCls, cw.x)
      const sx = cw.x - (hw + 8)
      const sz = cw.z - 3.1 // right side of +x travel
      if (distToRoadCorridor(sx, sz) < 0.2) continue
      if (nearIntersection(sx, sz, 5)) continue
      addSign(sx, sz, -Math.PI / 2, 'cross')
    }
    makeIM(new THREE.CylinderGeometry(0.035, 0.05, 2.7, 5), mats.metalDark, signPoles, undefined, false)
    const signPlane = new THREE.PlaneGeometry(0.66, 0.66)
    makeIM(signPlane, limitMats['50'], speed50, undefined, false)
    makeIM(signPlane, limitMats['40'], speed40, undefined, false)
    makeIM(signPlane, limitMats['30'], speed30, undefined, false)
    const triPlane = new THREE.PlaneGeometry(0.72, 0.66)
    makeIM(triPlane, crossingMat, crossSigns, undefined, false)
    const backMat = new THREE.MeshStandardMaterial({ color: '#9a9da1', roughness: 0.6, side: THREE.DoubleSide })
    makeIM(new THREE.PlaneGeometry(0.7, 0.7), backMat, backs, undefined, false)
  }

  /* ============================================================
   * 8. CITY BOUNDARY — visible barrier wall + hazard boards +
   *    city-limit signs, and ROLLING TERRAIN beyond the wall so
   *    the city sits in a believable landscape.
   * ============================================================ */
  {
    const wallGeos: THREE.BufferGeometry[] = []
    const mk = (w: number, d: number, x: number, z: number) => {
      const g = new THREE.BoxGeometry(w, 1.6, d)
      g.translate(x, 0.8, z)
      wallGeos.push(g)
    }
    mk(1240, 0.5, 0, -612)
    mk(1240, 0.5, 0, 612)
    mk(0.5, 1240, -612, 0)
    mk(0.5, 1240, 612, 0)
    addMerged(wallGeos, mats.concrete)
    // coping line along the top of the wall (no z-fight: sits proud)
    const capGeos: THREE.BufferGeometry[] = []
    const mkCap = (w: number, d: number, x: number, z: number) => {
      const g = new THREE.BoxGeometry(w, 0.14, d)
      g.translate(x, 1.66, z)
      capGeos.push(g)
    }
    mkCap(1240, 0.66, 0, -612)
    mkCap(1240, 0.66, 0, 612)
    mkCap(0.66, 1240, -612, 0)
    mkCap(0.66, 1240, 612, 0)
    addMerged(capGeos, mats.concreteLight, false)
    // hazard boards along the wall every 24 m (red/white, visible barrier)
    const hazardMat = new THREE.MeshStandardMaterial({ color: '#e8e4da', roughness: 0.6 })
    const hazardRed = new THREE.MeshStandardMaterial({ color: '#c23a2a', roughness: 0.6 })
    const boardMats = new Map<THREE.Material, THREE.BufferGeometry[]>()
    const pushBoard = (x: number, z: number, ry: number, stripe: number) => {
      const g = new THREE.BoxGeometry(2.6, 0.55, 0.08)
      g.rotateY(ry)
      g.translate(x, 1.95, z)
      const m = stripe === 0 ? hazardRed : hazardMat
      if (!boardMats.has(m)) boardMats.set(m, [])
      boardMats.get(m)!.push(g)
    }
    for (let x = -600; x <= 600; x += 24) {
      pushBoard(x, -611.6, 0, Math.abs(x / 24) % 2)
      pushBoard(x, 611.6, 0, Math.abs(x / 24) % 2)
    }
    for (let z = -600; z <= 600; z += 24) {
      pushBoard(-611.6, z, Math.PI / 2, Math.abs(z / 24) % 2)
      pushBoard(611.6, z, Math.PI / 2, Math.abs(z / 24) % 2)
    }
    for (const [m, geos] of boardMats) {
      const merged = mergeGeometries(geos, false)
      if (!merged) continue
      const mesh = new THREE.Mesh(merged, m)
      mesh.castShadow = true
      group.add(mesh)
    }
    // city-limit signs at the four road stubs
    for (const [sgnX, sgnZ, ry, txt] of [
      [0, -606, 0, 'LEAVING SOLHEIM'],
      [0, 606, Math.PI, 'LEAVING SOLHEIM'],
      [-606, 0, Math.PI / 2, 'LEAVING SOLHEIM'],
      [606, 0, -Math.PI / 2, 'LEAVING SOLHEIM'],
    ] as const) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.4, 6), mats.metalDark)
      pole.position.set(sgnX, 1.7, sgnZ)
      group.add(pole)
      const board = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.1), mats.signMaterial(txt, { bg: '#1f4d38', fg: '#f0f5e8', w: 512, h: 104 }))
      board.position.set(sgnX, 3.5, sgnZ)
      board.rotation.y = ry
      group.add(board)
      const board2 = board.clone()
      board2.rotation.y = ry + Math.PI
      group.add(board2)
    }
    // welcome signs
    for (const [sgnX, sgnZ, ry] of [[50, -608, 0], [-608, 50, Math.PI / 2]] as const) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 6), mats.metalDark)
      pole.position.set(sgnX, 1.5, sgnZ)
      group.add(pole)
      const board = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.2), mats.signMaterial('SOLHEIM', { bg: '#1f4d38', fg: '#f0f5e8', w: 512, h: 128 }))
      board.position.set(sgnX, 3.2, sgnZ)
      board.rotation.y = ry
      group.add(board)
      if (sgnX === 50) board.rotation.y = Math.PI
    }
  }

  /* ============================================================
   * 9. OUTSIDE TERRAIN — rolling hills, a lake, forest specks and
   *    distant mountains so the map reads as part of a world.
   * ============================================================ */
  {
    const TER = 2600
    const SEG = 120
    const tg = new THREE.PlaneGeometry(TER, TER, SEG, SEG)
    tg.rotateX(-Math.PI / 2)
    const pos = tg.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const cGrass = new THREE.Color('#5d7a45')
    const cGrass2 = new THREE.Color('#6f8a4c')
    const cRock = new THREE.Color('#8a8578')
    const cField = new THREE.Color('#9a9a58')
    const noise = (x: number, z: number) =>
      Math.sin(x * 0.0042 + 1.7) * Math.cos(z * 0.0051 + 0.6) +
      0.55 * Math.sin(x * 0.011 + 0.3) * Math.cos(z * 0.009 + 2.1) +
      0.25 * Math.sin(x * 0.027 + 2.2) * Math.cos(z * 0.023 + 1.1)
    for (let vi = 0; vi < pos.count; vi++) {
      const x = pos.getX(vi)
      const z = pos.getZ(vi)
      const r = Math.max(Math.abs(x), Math.abs(z))
      let y = -0.16
      if (r > 616) {
        const t = Math.min(1, (r - 616) / 260)
        const ease = t * t * (3 - 2 * t)
        const n = noise(x, z)
        y = -0.12 + ease * (5.5 + n * 7.5)
        if (y < -0.12) y = -0.12
        // gentle far mountains via a second, wider bump field
        const rm = Math.hypot(x, z)
        if (rm > 1050) {
          const mt = Math.min(1, (rm - 1050) / 320)
          y += mt * (18 + Math.abs(noise(x * 0.7 + 500, z * 0.7)) * 26)
        }
      }
      pos.setY(vi, y)
      let c = cGrass.clone().lerp(cGrass2, (noise(x * 1.7, z * 1.7) + 1) / 2)
      if (r > 900 && r <= 1050 && Math.abs(noise(x * 2.3 + 100, z * 2.3)) > 0.86) c = cField.clone()
      if (y > 16) c = c.lerp(cRock, Math.min(1, (y - 16) / 22))
      colors[vi * 3] = c.r
      colors[vi * 3 + 1] = c.g
      colors[vi * 3 + 2] = c.b
    }
    tg.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    tg.computeVertexNormals()
    const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }))
    terrain.receiveShadow = false
    group.add(terrain)
    // lake north-west beyond the wall
    const lake = new THREE.Mesh(new THREE.CircleGeometry(170, 40), mats.water)
    lake.rotation.x = -Math.PI / 2
    lake.position.set(-880, 1.1, -940)
    lake.scale.set(1.25, 0.85, 1)
    group.add(lake)
    const lakeShore = new THREE.Mesh(new THREE.RingGeometry(1, 1.04, 40), mats.gravel)
    lakeShore.rotation.x = -Math.PI / 2
    lakeShore.position.set(-880, 1.6, -940)
    lakeShore.scale.set(170 * 1.25, 170 * 0.85, 1)
    group.add(lakeShore)
    // forest specks on the hills (instanced cones + trunks)
    const hillTrees: { x: number; y: number; z: number; s: number }[] = []
    for (let i = 0; i < 340; i++) {
      const a = (i * 2.399963) % (Math.PI * 2)
      const rr = 640 + ((i * 977) % 380)
      const x = Math.cos(a) * rr
      const z = Math.sin(a) * rr
      if (Math.max(Math.abs(x), Math.abs(z)) > 1240) continue
      const n = noise(x, z)
      if (n < 0.15) continue
      const t = Math.min(1, (Math.max(Math.abs(x), Math.abs(z)) - 616) / 260)
      const y = -0.12 + t * t * (3 - 2 * t) * (5.5 + n * 7.5)
      if (y > 14) continue
      hillTrees.push({ x, y, z, s: 0.8 + ((i * 131) % 60) / 100 })
    }
    const hillTreeGeo = mergeGeometries(
      [
        new THREE.ConeGeometry(1.7, 5.2, 6).translate(0, 3.4, 0),
        new THREE.CylinderGeometry(0.16, 0.24, 1.6, 5).translate(0, 0.8, 0),
      ],
      false,
    )!
    makeIM(hillTreeGeo, new THREE.MeshStandardMaterial({ color: '#3f5c34', roughness: 1 }), hillTrees.map((t) => ({ x: t.x, y: t.y, z: t.z, s: t.s })), undefined, false)
  }

  void detailGeos
  void lineClass
  const animated = (t: number) => {
    for (const f of animators) f(t)
  }
  return { group, colliders, streetLights, puddleSpots, benchSpots, stopSpots, animated }
}

// task10: street life & transit riders
