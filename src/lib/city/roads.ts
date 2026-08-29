import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { worldUVPlane, worldUVBox } from './materials'
import { GRID_LINES, LANE_OFFSET, ROAD_WIDTH, SIDEWALK_WIDTH, SPEED_LIMIT } from './constants'
import { roadHalfWidth } from './planner'
import type { CityMaterials, CityPlan, ConnPath, CrosswalkSeg, LaneSeg, RoadClass, RoadNetworkData, SidewalkSeg, SignalGroup } from './types'

/* ============================================================
 * Road network: directed lane graph (right-hand traffic) with
 * turn connectors across intersections, sidewalk graph, crosswalk
 * links, signal groups + merged road surface meshes.
 * ============================================================ */

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildRoadNetwork(plan: CityPlan): RoadNetworkData {
  const lanes = new Map<string, LaneSeg>()
  const sidewalks = new Map<string, SidewalkSeg>()
  const crosswalks: CrosswalkSeg[] = []
  const signals: SignalGroup[] = []
  const connectors = new Map<string, ConnPath>()
  const rng = mulberry32(31337)

  /* ---------------- lanes ---------------- */
  interface Piece {
    id: string
    axis: 'x' | 'z'
    dir: 1 | -1
    coord: number // lane centerline offset from the road centerline
    baseCoord: number // the road centerline itself
    from: number
    to: number
    cls: RoadClass
  }
  const pieces: Piece[] = []

  const nearestGrid = (v: number) => {
    let best = GRID_LINES[0]
    for (const l of GRID_LINES) if (Math.abs(l - v) < Math.abs(best - v)) best = l
    return best
  }

  for (const road of plan.roads) {
    if (road.pedestrianOnly) continue
    // iterate grid lines within [from,to]
    const lines = GRID_LINES.filter((l) => l > road.from + 1 && l < road.to - 1)
    const bounds = [road.from, ...lines, road.to]
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i]
      const b2 = bounds[i + 1]
      if (b2 - a < 4) continue
      // pull the piece ends back to the edge of every crossing roadway so
      // vehicles cross the intersection on a connector path (straight or arc)
      const aCross = i > 0
      const bCross = i < bounds.length - 2
      const ta = aCross ? a + roadHalfWidth(lineClsOf(a), a) + 1.2 : a
      const tb = bCross ? b2 - roadHalfWidth(lineClsOf(b2), b2) - 1.2 : b2
      if (tb - ta < 3) continue
      // tram streets: car lanes hug outside the 5.2 m track bed (±2.6)
      const laneOff = road.cls === 'arterial' && road.coord === 0 ? 5.0 : LANE_OFFSET
      // eastbound/southbound lane on positive offset side, opposite on negative
      if (road.axis === 'x') {
        // eastbound (+X) at z = coord + laneOff
        pieces.push({ id: `Lx${road.coord}e${i}`, axis: 'x', dir: 1, coord: road.coord + laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
        // westbound (−X) at z = coord − laneOff
        pieces.push({ id: `Lx${road.coord}w${i}`, axis: 'x', dir: -1, coord: road.coord - laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
      } else {
        // southbound (+Z) at x = coord − laneOff
        pieces.push({ id: `Lz${road.coord}s${i}`, axis: 'z', dir: 1, coord: road.coord - laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
        // northbound (−Z) at x = coord + laneOff
        pieces.push({ id: `Lz${road.coord}n${i}`, axis: 'z', dir: -1, coord: road.coord + laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
      }
    }
  }

  // lane endpoints & next connections
  for (const p of pieces) {
    const seg: LaneSeg = {
      id: p.id,
      x1: p.axis === 'x' ? p.from : p.coord,
      z1: p.axis === 'x' ? p.coord : p.from,
      x2: p.axis === 'x' ? p.to : p.coord,
      z2: p.axis === 'x' ? p.coord : p.to,
      cls: p.cls,
      speed: SPEED_LIMIT[p.cls],
      next: [],
    }
    lanes.set(p.id, seg)
  }
  // intersection node = (x of the crossing z-road, z of the crossing x-road)
  const endNode = (p: Piece) => (p.axis === 'x' ? `${nearestGrid(p.to)}_${p.baseCoord}` : `${p.baseCoord}_${nearestGrid(p.to)}`)
  const startNode = (p: Piece) => (p.axis === 'x' ? `${nearestGrid(p.from)}_${p.baseCoord}` : `${p.baseCoord}_${nearestGrid(p.from)}`)

  const startsAt = new Map<string, Piece[]>()
  for (const p of pieces) {
    const k = startNode(p)
    if (!startsAt.has(k)) startsAt.set(k, [])
    startsAt.get(k)!.push(p)
  }
  for (const p of pieces) {
    const seg = lanes.get(p.id)!
    const node = endNode(p)
    const cands = startsAt.get(node) ?? []
    for (const q of cands) {
      if (q.id === p.id) continue
      // no U-turn: same road, opposite direction
      if (q.axis === p.axis && q.baseCoord === p.baseCoord && q.dir !== p.dir) continue
      seg.next.push(q.id)
      // build the connector path across the intersection
      const p1 = { x: seg.x2, z: seg.z2 }
      const qSeg = lanes.get(q.id)!
      const p2 = { x: qSeg.x1, z: qSeg.z1 }
      const d0 = { x: p.axis === 'x' ? p.dir : 0, z: p.axis === 'x' ? 0 : p.dir }
      const d1 = { x: q.axis === 'x' ? q.dir : 0, z: q.axis === 'x' ? 0 : q.dir }
      const dot = d0.x * d1.x + d0.z * d1.z
      const straight = dot > 0.9
      let pts: { x: number; z: number }[]
      if (straight) {
        pts = [p1, p2]
      } else {
        // cubic Bezier: out of p1 along d0, into p2 against d1
        const span = Math.hypot(p2.x - p1.x, p2.z - p1.z)
        const k = Math.min(9.5, Math.max(4, span * 0.45))
        const c0 = { x: p1.x + d0.x * k, z: p1.z + d0.z * k }
        const c1 = { x: p2.x - d1.x * k, z: p2.z - d1.z * k }
        pts = []
        const N = 9
        for (let s = 0; s <= N; s++) {
          const t = s / N
          const u = 1 - t
          pts.push({
            x: u * u * u * p1.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p2.x,
            z: u * u * u * p1.z + 3 * u * u * t * c0.z + 3 * u * t * t * c1.z + t * t * t * p2.z,
          })
        }
      }
      const cum: number[] = [0]
      let total = 0
      for (let s = 1; s < pts.length; s++) {
        total += Math.hypot(pts[s].x - pts[s - 1].x, pts[s].z - pts[s - 1].z)
        cum.push(total)
      }
      connectors.set(`${p.id}>${q.id}`, { pts, cum, len: total, straight })
    }
  }
  void rng

  /* ---------------- sidewalks ---------------- */
  const spieces: { id: string; axis: 'x' | 'z'; coord: number; from: number; to: number; cls: RoadClass }[] = []
  for (const road of plan.roads) {
    const hw = roadHalfWidth(road.cls, road.coord)
    const off = hw + SIDEWALK_WIDTH[road.cls] / 2
    const lines = GRID_LINES.filter((l) => l > road.from + 1 && l < road.to - 1)
    const bounds = [road.from, ...lines, road.to]
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i]
      const b2 = bounds[i + 1]
      if (b2 - a < 4) continue
      if (road.axis === 'x') {
        spieces.push({ id: `Sx${road.coord}p${i}`, axis: 'x', coord: road.coord + off, from: a, to: b2, cls: road.cls })
        spieces.push({ id: `Sx${road.coord}m${i}`, axis: 'x', coord: road.coord - off, from: a, to: b2, cls: road.cls })
      } else {
        spieces.push({ id: `Sz${road.coord}p${i}`, axis: 'z', coord: road.coord + off, from: a, to: b2, cls: road.cls })
        spieces.push({ id: `Sz${road.coord}m${i}`, axis: 'z', coord: road.coord - off, from: a, to: b2, cls: road.cls })
      }
    }
  }
  for (const p of spieces) {
    sidewalks.set(p.id, {
      id: p.id,
      x1: p.axis === 'x' ? p.from : p.coord,
      z1: p.axis === 'x' ? p.coord : p.from,
      x2: p.axis === 'x' ? p.to : p.coord,
      z2: p.axis === 'x' ? p.coord : p.to,
      cls: p.cls,
      next: [],
    })
  }
  // connect sidewalk pieces whose endpoints are within 2.3 m (0 included —
  // abutting pieces at junctions share the exact endpoint)
  const spList = [...sidewalks.values()]
  for (const a of spList) {
    for (const b2 of spList) {
      if (a.id === b2.id) continue
      const d = Math.hypot(a.x2 - b2.x1, a.z2 - b2.z1)
      if (d < 2.3) a.next.push(b2.id)
    }
  }
  // make traversal bidirectional: allow walking from either end by adding reverse links
  for (const a of spList) {
    for (const b2 of spList) {
      if (a.id === b2.id) continue
      const d = Math.hypot(a.x1 - b2.x1, a.z1 - b2.z1)
      if (d < 2.3 && d > 0.01) {
        // shared start: b can continue from a's start? For simplicity: link a.next from b too (walk both ways)
        if (!a.next.includes(b2.id) && Math.hypot(a.x1 - b2.x2, a.z1 - b2.z2) < 2.3) a.next.push(b2.id)
      }
    }
  }
  // straight continuation ACROSS junctions: pieces of the same street are split
  // by the crossing roadway (a 15-25 m gap) — link collinear end→start pairs so
  // the sidewalk graph is connected and peds decide at crosswalks, not teleport.
  for (const a of spList) {
    for (const b2 of spList) {
      if (a.id === b2.id) continue
      const gap = Math.hypot(a.x2 - b2.x1, a.z2 - b2.z1)
      if (gap < 3 || gap > 45) continue
      const aLat = Math.abs(a.x1 - a.x2) < 0.5 ? a.x1 : a.z1
      const bLat = Math.abs(b2.x1 - b2.x2) < 0.5 ? b2.x1 : b2.z1
      if (Math.abs(aLat - bLat) > 0.5) continue // must share the lateral line
      const aRunsX = Math.abs(a.z1 - a.z2) < 0.5
      const bRunsX = Math.abs(b2.z1 - b2.z2) < 0.5
      if (aRunsX !== bRunsX) continue
      if (!a.next.includes(b2.id)) a.next.push(b2.id)
    }
  }

  /* ---------------- crosswalks ---------------- */
  for (const cw of plan.crosswalks) {
    const laneIds: string[] = []
    for (const seg of lanes.values()) {
      if (cw.axis === 'x') {
        // ped walks along x → crossing a road that runs along z → lane is axis z
        if (Math.abs(seg.x1 - seg.x2) < 0.5 && Math.abs(seg.x1 - cw.x) < 3.5) {
          const lo = Math.min(seg.z1, seg.z2)
          const hi = Math.max(seg.z1, seg.z2)
          if (cw.z > lo - 4 && cw.z < hi + 4) laneIds.push(seg.id)
        }
      } else {
        if (Math.abs(seg.z1 - seg.z2) < 0.5 && Math.abs(seg.z1 - cw.z) < 3.5) {
          const lo = Math.min(seg.x1, seg.x2)
          const hi = Math.max(seg.x1, seg.x2)
          if (cw.x > lo - 4 && cw.x < hi + 4) laneIds.push(seg.id)
        }
      }
    }
    // attach the two FLANK sidewalk pieces — they run PARALLEL to the crossed
    // road (perpendicular to the ped's walking axis), one on each side, and
    // their span must cover the crossing coordinate. (The old nearest-endpoint
    // heuristic matched corner pieces of the perpendicular street, which made
    // peds "cross" in 0.3 m and never wait at signals.)
    const crossedRoadHalf = roadHalfWidth(cw.roadCls === 'arterial' ? 'arterial' : cw.roadCls, cw.axis === 'x' ? cw.z : cw.x)
    let a = ''
    let b = ''
    let bestA = Infinity
    let bestB = Infinity
    for (const s of sidewalks.values()) {
      const runsAlongZ = Math.abs(s.x1 - s.x2) < 0.5
      const wantAlongZ = cw.axis === 'x' // crossing along x → flanks run along z
      if (runsAlongZ !== wantAlongZ) continue
      const lat = runsAlongZ ? s.x1 : s.z1
      const cwLat = cw.axis === 'x' ? cw.x : cw.z
      const along = runsAlongZ ? s.z1 : s.x1
      const along2 = runsAlongZ ? s.z2 : s.x2
      const cwAlong = cw.axis === 'x' ? cw.z : cw.x
      const latDist = Math.abs(lat - cwLat)
      // flank piece sits just outside the crossed asphalt (min 2 m) and within one sidewalk band
      if (latDist < crossedRoadHalf + 1 || latDist > crossedRoadHalf + 9) continue
      // must span (or nearly span) the crossing position
      const lo = Math.min(along, along2) - 4
      const hi = Math.max(along, along2) + 4
      if (cwAlong < lo || cwAlong > hi) continue
      const side = lat < cwLat ? 0 : 1
      const d = Math.min(Math.abs(along - cwAlong), Math.abs(along2 - cwAlong))
      if (side === 0) {
        if (d < bestA) { bestA = d; a = s.id }
      } else {
        if (d < bestB) { bestB = d; b = s.id }
      }
    }
    let signalId: string | undefined
    let bestS = 30
    for (const tl of plan.trafficLights) {
      const d = Math.hypot(tl.x - cw.x, tl.z - cw.z)
      if (d < bestS) { bestS = d; signalId = tl.id }
    }
    crosswalks.push({ id: `cw${cw.x}_${cw.z}_${cw.axis}`, x: cw.x, z: cw.z, axis: cw.axis, width: 16, a, b, laneIds, signalId })
  }

  /* ---------------- signals ---------------- */
  for (const tl of plan.trafficLights) {
    const hwX = roadHalfWidth('arterial', 0) // corner offsets fixed for visibility
    void hwX
    const heads = [
      { x: tl.x - 12.5, z: tl.z - 12.5, axis: 'x' as const, dir: 1 as const },
      { x: tl.x + 12.5, z: tl.z + 12.5, axis: 'x' as const, dir: -1 as const },
      { x: tl.x + 12.5, z: tl.z - 12.5, axis: 'z' as const, dir: 1 as const },
      { x: tl.x - 12.5, z: tl.z + 12.5, axis: 'z' as const, dir: -1 as const },
    ]
    const phases = tl.phase0Axis === 'x'
      ? [{ greenAxis: 'x' as const, duration: 9 }, { greenAxis: 'z' as const, duration: 9 }]
      : [{ greenAxis: 'z' as const, duration: 9 }, { greenAxis: 'x' as const, duration: 9 }]
    signals.push({ id: tl.id, x: tl.x, z: tl.z, phases, heads })
  }

  return { lanes, sidewalks, crosswalks, signals, connectors }
}

/* ============================================================
 * Road meshes
 * ============================================================ */

function strip(axis: 'x' | 'z', coord: number, from: number, to: number, width: number, topY: number, thick = 0.3, tile = 0): THREE.BoxGeometry {
  const len = to - from
  const mid = (from + to) / 2
  const g = new THREE.BoxGeometry(axis === 'x' ? len : width, thick, axis === 'x' ? width : len)
  g.translate(axis === 'x' ? mid : coord, topY - thick / 2, axis === 'x' ? coord : mid)
  // bake world-scale texture tiling into the face UVs (texture.repeat stays 1,1)
  if (tile > 0) worldUVBox(g, axis === 'x' ? len : width, axis === 'x' ? width : len, tile)
  return g
}

function plate(axis: 'x' | 'z', x: number, z: number, along: number, across: number, y: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(axis === 'x' ? along : across, axis === 'x' ? across : along)
  g.rotateX(-Math.PI / 2)
  g.translate(x, y, z)
  return g
}

export function createRoadMeshes(plan: CityPlan, mats: CityMaterials): THREE.Group {
  const group = new THREE.Group()
  const rng = mulberry32(5150)

  /* ---- intervals along a road that are occupied by a CROSSING street
         (its asphalt + 0.6 m gutter margin). Sidewalks, curbs, bike lanes
         and edge lines are broken there so nothing is painted onto the
         asphalt of a crossroad. ---- */
  const blockedIntervals = (road: (typeof plan.roads)[number], margin = 0.6): [number, number][] => {
    const iv: [number, number][] = []
    for (const other of plan.roads) {
      if (other.axis === road.axis) continue
      if (road.coord < other.from - 0.5 || road.coord > other.to + 0.5) continue
      const hwO = roadHalfWidth(other.cls, other.coord)
      iv.push([other.coord - hwO - margin, other.coord + hwO + margin])
    }
    return iv
  }
  const emit = (from: number, to: number, iv: [number, number][], out: (a: number, b: number) => void) => {
    let cur = from
    const sorted = [...iv].filter(([a, b]) => b > from + 0.4 && a < to - 0.4).sort((p, q) => p[0] - q[0])
    for (const [a, b] of sorted) {
      const s = Math.max(a, from)
      const e = Math.min(b, to)
      if (s - cur > 0.4) out(cur, s)
      if (e > cur) cur = e
    }
    if (to - cur > 0.4) out(cur, to)
  }

  const asphaltGeos: THREE.BufferGeometry[] = []
  const paverGeos: THREE.BufferGeometry[] = []
  const sidewalkGeos: THREE.BufferGeometry[] = []
  const curbGeos: THREE.BufferGeometry[] = []
  const whiteGeos: THREE.BufferGeometry[] = []
  const yellowGeos: THREE.BufferGeometry[] = []
  const bikeGeos: THREE.BufferGeometry[] = []
  const trackBedGeos: THREE.BufferGeometry[] = []
  const railGeos: THREE.BufferGeometry[] = []

  // 1. base ground — 7 m grass tile baked into the UVs (was a global repeat
  //    that read as flat noise from street level)
  const groundGeo = worldUVPlane(new THREE.PlaneGeometry(1260, 1260), 1260, 1260, 7)
  const ground = new THREE.Mesh(groundGeo, mats.grass)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.08
  ground.receiveShadow = true
  group.add(ground)

  // 2. block slabs
  const slabPaved: THREE.BufferGeometry[] = []
  const slabGreen: THREE.BufferGeometry[] = []
  const slabInd: THREE.BufferGeometry[] = []
  const slabPlaza: THREE.BufferGeometry[] = []
  const slabCourt: THREE.BufferGeometry[] = []
  for (const b of plan.blocks) {
    const g = new THREE.BoxGeometry(97, 0.12, 97)
    g.translate(b.cx, -0.06, b.cz)
    if (b.zone === 'park') slabGreen.push(g)
    else if (b.zone === 'plaza') slabPlaza.push(g)
    else if (b.zone === 'industrial') slabInd.push(g)
    else if (b.zone === 'downtown' || b.zone === 'commercial' || b.zone === 'mixed') slabCourt.push(g)
    else slabPaved.push(g)
  }
  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, receive = true, cast = false) => {
    if (!geos.length) return
    const merged = mergeGeometries(geos, false)
    if (!merged) return
    const mesh = new THREE.Mesh(merged, mat)
    mesh.receiveShadow = receive
    mesh.castShadow = cast
    group.add(mesh)
    geos.forEach((g) => g.dispose())
  }
  addMerged(slabPaved, mats.sidewalk)
  addMerged(slabGreen, mats.grassDark)
  addMerged(slabInd, mats.asphaltRough)
  addMerged(slabPlaza, mats.plaza)
  // downtown / commercial / mixed block interiors: big precast court panels —
  // the old light 0.6 m sidewalk texture read as a blank white expanse at
  // street scale (the "town center is textureless" report)
  addMerged(slabCourt, mats.court)

  // 3. road strips
  for (const road of plan.roads) {
    const width = road.cls === 'arterial' ? (road.coord === 0 ? 20 : ROAD_WIDTH.arterial) : ROAD_WIDTH[road.cls]
    if (road.pedestrianOnly) {
      const g = strip(road.axis, road.coord, road.from, road.to, 8, 0.1, 0.24, 3)
      paverGeos.push(g)
      // curbs on ped street edges — broken where a crossing street passes
      const blockedPed = blockedIntervals(road)
      for (const s of [-1, 1]) {
        emit(road.from, road.to, blockedPed, (a, b) => {
          curbGeos.push(strip(road.axis, road.coord + s * 4, a, b, 0.22, 0.16, 0.34))
        })
      }
      continue
    }
    asphaltGeos.push(strip(road.axis, road.coord, road.from, road.to, width, 0.02, 0.16, 6))
    // sidewalks + curbs on both sides, BROKEN at every crossing street.
    // margin 0: the strips end EXACTLY at the crossing asphalt edge — the
    // corner patch then continues the same band flush, so there is no
    // gutter sliver of double-drawn sidewalk (and no 1 cm step) at corners.
    const blocked0 = blockedIntervals(road, 0)
    for (const s of [-1, 1]) {
      const hw = roadHalfWidth(road.cls, road.coord)
      const off = hw + SIDEWALK_WIDTH[road.cls] / 2
      emit(road.from, road.to, blocked0, (a, b) => {
        sidewalkGeos.push(strip(road.axis, road.coord + s * off, a, b, SIDEWALK_WIDTH[road.cls], 0.14, 0.3, 2.4))
      })
      emit(road.from, road.to, blocked0, (a, b) => {
        curbGeos.push(strip(road.axis, road.coord + s * (hw + 0.09), a, b, 0.18, 0.16, 0.34))
      })
    }
    if (road.cls === 'arterial' && road.coord === 0) {
      // tram street: track bed + rails — DOUBLE TRACK (±1.6 m, one per direction)
      trackBedGeos.push(strip(road.axis, road.coord, road.from, road.to, 5.2, 0.035, 0.12))
      for (const t of [-1.6, 1.6]) {
        for (const s of [-0.75, 0.75]) {
          railGeos.push(strip(road.axis, road.coord + t + s, road.from, road.to, 0.1, 0.11, 0.14))
        }
      }
    }
  }

  // markings per road
  for (const road of plan.roads) {
    if (road.pedestrianOnly) continue
    const width = road.cls === 'arterial' ? (road.coord === 0 ? 20 : ROAD_WIDTH.arterial) : ROAD_WIDTH[road.cls]
    const hw = width / 2
    const skipZones = GRID_LINES.map((l) => ({ c: l, r: roadHalfWidth(lineClsOf(l), l) + 2.5 }))
    const clear = (pos: number) => !skipZones.some((z) => Math.abs(pos - z.c) < z.r)
    if (road.cls === 'arterial' && road.coord === 0) {
      // yellow flanks of tram bed (skip intersection zones)
      for (const s of [-1, 1]) {
        for (let pos = road.from + 2; pos < road.to - 2; pos += 4) {
          if (!clear(pos + 1.5)) continue
          const mid = pos + 1.5
          const g = plate(road.axis, road.axis === 'x' ? mid : road.coord + s * 2.6, road.axis === 'x' ? road.coord + s * 2.6 : mid, 3, 0.13, 0.065)
          yellowGeos.push(g)
        }
      }
    } else if (road.cls === 'arterial') {
      for (const s of [-1, 1]) {
        for (let pos = road.from + 2; pos < road.to - 2; pos += 4) {
          if (!clear(pos)) continue
          const mid = pos + 1.5
          const g = plate(road.axis, road.axis === 'x' ? mid : road.coord, road.axis === 'x' ? road.coord : mid, 3, 0.14, 0.065)
          whiteGeos.push(g)
        }
      }
      // edge lines (broken at crossings)
      for (const s of [-1, 1]) {
        emit(road.from + 2, road.to - 2, blockedIntervals(road), (a, b) => {
          const len = b - a
          if (len < 4) return
          const mid = a + len / 2
          const g = plate(road.axis, road.axis === 'x' ? mid : road.coord + s * (hw - 0.4), road.axis === 'x' ? road.coord + s * (hw - 0.4) : mid, len, 0.12, 0.065)
          whiteGeos.push(g)
        })
      }
    } else {
      // dashed center
      for (let pos = road.from + 2; pos < road.to - 2; pos += 6) {
        if (!clear(pos + 1.5)) continue
        const mid = pos + 1.5
        const g = plate(road.axis, road.axis === 'x' ? mid : road.coord, road.axis === 'x' ? road.coord : mid, 3, 0.13, 0.065)
        whiteGeos.push(g)
      }
    }
    // bike lanes on arterials + collectors (broken at crossings)
    if (road.cls === 'arterial' || road.cls === 'collector') {
      for (const s of [-1, 1]) {
        const off = hw - 1.0
        emit(road.from + 1, road.to - 1, blockedIntervals(road), (a, b) => {
          bikeGeos.push(strip(road.axis, road.coord + s * off, a, b, 1.6, 0.05, 0.05))
        })
      }
    }
  }

  // crosswalk zebras
  for (const cw of plan.crosswalks) {
    const roadHalf = roadHalfWidth(cw.roadCls === 'arterial' ? 'arterial' : cw.roadCls, cw.axis === 'x' ? cw.z : cw.x)
    const crossLen = roadHalf * 2
    const stripeCount = 5
    for (let i = 0; i < stripeCount; i++) {
      const off = -1.2 + i * 0.6
      const g = plate(cw.axis === 'x' ? 'z' : 'x', cw.x + (cw.axis === 'x' ? off : 0), cw.z + (cw.axis === 'x' ? 0 : off), crossLen, 0.42, 0.085)
      whiteGeos.push(g)
    }
  }

  // stop lines at signalized intersections — right at the piece end
  // (pieces are pulled back to the crossing edge + 1.2 m)
  for (const tl of plan.trafficLights) {
    const hwA = roadHalfWidth('arterial', 0)
    const edge = hwA + 2.0
    for (const s of [-1, 1]) {
      // x-approach stop line (spanning both approach lanes)
      const g1 = plate('z', tl.x + s * edge, tl.z, 0.45, 7.4, 0.1)
      whiteGeos.push(g1)
      // z-approach stop line
      const g2 = plate('x', tl.x, tl.z + s * edge, 7.4, 0.45, 0.1)
      whiteGeos.push(g2)
    }
  }

  // corner sidewalk patches — ONLY where two roads actually cross, and
  // flush with the sidewalk strips (top exactly 0.14): the old +0.15 top
  // left a 1 cm lip over every strip and patches spawned even where one of
  // the two streets never reaches the junction
  for (const x of GRID_LINES) {
    for (const z of GRID_LINES) {
      const roadAlongX = plan.roads.some((r) => r.axis === 'x' && r.coord === z && r.from < x && r.to > x)
      const roadAlongZ = plan.roads.some((r) => r.axis === 'z' && r.coord === x && r.from < z && r.to > z)
      if (!roadAlongX || !roadAlongZ) continue
      const hwX = roadHalfWidth(lineClsOf(x), x)
      const hwZ = roadHalfWidth(lineClsOf(z), z)
      const swX = SIDEWALK_WIDTH[lineClsOf(x)]
      const swZ = SIDEWALK_WIDTH[lineClsOf(z)]
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const cx = x + sx * (hwX + swX / 2)
          const cz = z + sz * (hwZ + swZ / 2)
          const g = new THREE.BoxGeometry(swX, 0.3, swZ)
          // top flush with the sidewalk strips at 0.14 (box centered -0.01)
          g.translate(cx, -0.01, cz)
          worldUVBox(g, swX, swZ, 2.4)
          sidewalkGeos.push(g)
        }
      }
    }
  }

  addMerged(asphaltGeos, mats.asphalt, true, false)
  addMerged(paverGeos, mats.parkPath, true, false)
  addMerged(sidewalkGeos, mats.sidewalk, true, false)
  addMerged(curbGeos, mats.curb, true, false)
  addMerged(whiteGeos, mats.roadLine)
  addMerged(yellowGeos, mats.roadLineYellow)
  addMerged(bikeGeos, mats.bikeLane)
  addMerged(trackBedGeos, mats.tramTrack)
  addMerged(railGeos, mats.metalDark)
  void rng

  return group
}

function lineClsOf(coord: number): 'arterial' | 'collector' | 'local' {
  const c = Math.abs(coord)
  if (c === 400 || c === 0) return 'arterial'
  if (c === 600 || c === 200) return 'collector'
  return 'local'
}
