import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { worldUVPlane, worldUVBox } from './materials'
import { GRID_LINES, LANE_OFFSET, SIDEWALK_WIDTH, SPEED_LIMIT } from './constants'
import { roadHalfWidth } from './planner'
import { redesignCrossroads } from './junctions'
import type { CityMaterials, CityPlan, ConnPath, CrosswalkSeg, CrosswalkSpec, LaneSeg, RoadClass, RoadNetworkData, SidewalkSeg, SignalGroup } from './types'

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

export function buildRoadNetwork(plan: CityPlan, options: { turnPockets?: boolean } = {}): RoadNetworkData {
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
    if (road.pedestrianOnly || road.transitOnly) continue
    // iterate grid lines within [from,to]
    const lines = GRID_LINES.filter((l) => l > road.from + 1 && l < road.to - 1)
    const bounds = [road.from, ...lines, road.to]
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i]
      const b2 = bounds[i + 1]
      if (b2 - a < 4) continue
      // pull the piece ends back to the edge of every crossing roadway so
      // vehicles cross the intersection on a connector path (straight or arc)
      // A fragmented road can start/end at an existing junction too. Leaving
      // that endpoint at the road centre puts its queue in crossing traffic.
      const hasCrossing = (at: number) => plan.roads.some(other => other.axis !== road.axis
        && !other.pedestrianOnly && !other.transitOnly && Math.abs(other.coord - at) < 0.1
        && road.coord >= other.from && road.coord <= other.to)
      const aCross = i > 0 || hasCrossing(a)
      const bCross = i < bounds.length - 2 || hasCrossing(b2)
      const ta = aCross ? a + roadHalfWidth(lineClsOf(a), a) + 1.2 : a
      const tb = bCross ? b2 - roadHalfWidth(lineClsOf(b2), b2) - 1.2 : b2
      if (tb - ta < 3) continue
      // tram streets: car lanes hug outside the 5.2 m track bed (±2.6)
      const laneOff = road.cls === 'arterial' && road.coord === 0 ? 5.0 : LANE_OFFSET
      // eastbound/southbound lane on positive offset side, opposite on negative
      if (road.axis === 'x') {
        // eastbound (+X) at z = coord + laneOff
        pieces.push({ id: `Lx${road.coord}e${i}:${road.id}`, axis: 'x', dir: 1, coord: road.coord + laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
        // westbound (−X) at z = coord − laneOff
        pieces.push({ id: `Lx${road.coord}w${i}:${road.id}`, axis: 'x', dir: -1, coord: road.coord - laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
      } else {
        // southbound (+Z) at x = coord − laneOff
        pieces.push({ id: `Lz${road.coord}s${i}:${road.id}`, axis: 'z', dir: 1, coord: road.coord - laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
        // northbound (−Z) at x = coord + laneOff
        pieces.push({ id: `Lz${road.coord}n${i}:${road.id}`, axis: 'z', dir: -1, coord: road.coord + laneOff, baseCoord: road.coord, from: ta, to: tb, cls: road.cls })
      }
    }
  }

  // lane endpoints & next connections
  for (const p of pieces) {
    const seg: LaneSeg = {
      id: p.id,
      x1: p.axis === 'x' ? (p.dir === 1 ? p.from : p.to) : p.coord,
      z1: p.axis === 'x' ? p.coord : (p.dir === 1 ? p.from : p.to),
      x2: p.axis === 'x' ? (p.dir === 1 ? p.to : p.from) : p.coord,
      z2: p.axis === 'x' ? p.coord : (p.dir === 1 ? p.to : p.from),
      cls: p.cls,
      speed: SPEED_LIMIT[p.cls],
      next: [],
    }
    lanes.set(p.id, seg)
  }
  // intersection node = (x of the crossing z-road, z of the crossing x-road)
  const endNode = (p: Piece) => (p.axis === 'x' ? `${nearestGrid(p.dir === 1 ? p.to : p.from)}_${p.baseCoord}` : `${p.baseCoord}_${nearestGrid(p.dir === 1 ? p.to : p.from)}`)
  const startNode = (p: Piece) => (p.axis === 'x' ? `${nearestGrid(p.dir === 1 ? p.from : p.to)}_${p.baseCoord}` : `${p.baseCoord}_${nearestGrid(p.dir === 1 ? p.from : p.to)}`)

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
    }
  }
  redesignCrossroads(plan, lanes, connectors, options.turnPockets !== false)
  void rng

  /* ---------------- sidewalks ---------------- */
  const spieces: { id: string; axis: 'x' | 'z'; coord: number; from: number; to: number; cls: RoadClass }[] = []
  for (const road of plan.roads) {
    if (road.transitOnly) continue
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
    const crossedHalf = roadHalfWidth(cw.roadCls, cw.axis === 'x' ? cw.x : cw.z)
    for (const seg of lanes.values()) {
      if (cw.axis === 'x') {
        // ped walks along x → crossing a road that runs along z → lane is axis z
        if (Math.abs(seg.x1 - seg.x2) < 0.5 && Math.abs(seg.x1 - cw.x) < crossedHalf + 0.5) {
          const lo = Math.min(seg.z1, seg.z2)
          const hi = Math.max(seg.z1, seg.z2)
          if (cw.z > lo - 4 && cw.z < hi + 4) laneIds.push(seg.id)
        }
      } else {
        if (Math.abs(seg.z1 - seg.z2) < 0.5 && Math.abs(seg.z1 - cw.z) < crossedHalf + 0.5) {
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
    const crossedRoadHalf = crossedHalf
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
    crosswalks.push({ id: `cw${cw.x}_${cw.z}_${cw.axis}`, x: cw.x, z: cw.z, axis: cw.axis, width: crossedHalf * 2, a, b, laneIds, signalId })
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
    const axes = tl.phase0Axis === 'x'
      ? [{ greenAxis: 'x' as const, duration: 9 }, { greenAxis: 'z' as const, duration: 9 }]
      : [{ greenAxis: 'z' as const, duration: 9 }, { greenAxis: 'x' as const, duration: 9 }]
    const phases = axes.flatMap(phase => {
      const hasPocket = [...lanes.values()].some(lane => lane.signalId === tl.id && lane.pocket === 'left'
        && (Math.abs(lane.x2 - lane.x1) > Math.abs(lane.z2 - lane.z1) ? 'x' : 'z') === phase.greenAxis)
      return hasPocket ? [{ ...phase, movement: 'through' as const }, { greenAxis: phase.greenAxis, duration: 6, movement: 'left' as const }] : [phase]
    })
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

export function createCrosswalkStripes(cw: CrosswalkSpec): THREE.PlaneGeometry[] {
  const half = roadHalfWidth(cw.roadCls, cw.axis === 'x' ? cw.x : cw.z)
  const count = Math.floor(half * 2 / 0.85)
  return Array.from({ length: count }, (_, i) => {
    const off = -half + (i + 0.5) * half * 2 / count
    return plate(cw.axis, cw.x + (cw.axis === 'x' ? off : 0), cw.z + (cw.axis === 'z' ? off : 0), 0.45, 2.8, 0.085)
  })
}

export function createRoadMeshes(plan: CityPlan, mats: CityMaterials, network = buildRoadNetwork(plan)): THREE.Group {
  const group = new THREE.Group()
  const rng = mulberry32(5150)
  const decalMaterial = <T extends THREE.Material>(source: T): T => {
    const material = source.clone()
    material.polygonOffset = true
    material.polygonOffsetFactor = -1
    material.polygonOffsetUnits = -1
    return material
  }

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
  const blockedAsphaltIntervals = (road: (typeof plan.roads)[number]): [number, number][] => {
    const iv: [number, number][] = []
    for (const other of plan.roads) {
      // The crossing must contribute its own asphalt. Pedestrian and terminal
      // roads use separate paving and are not owners of an asphalt junction.
      if (other.axis === road.axis || other.pedestrianOnly || other.transitOnly) continue
      if (road.coord < other.from - 0.5 || road.coord > other.to + 0.5) continue
      const half = roadHalfWidth(other.cls, other.coord)
      iv.push([other.coord - half, other.coord + half])
    }
    return iv
  }
  const blockedSidewalkIntervals = (road: (typeof plan.roads)[number]): [number, number][] => {
    const iv: [number, number][] = []
    for (const other of plan.roads) {
      if (other.axis === road.axis) continue
      if (road.coord < other.from - 0.5 || road.coord > other.to + 0.5) continue
      const half = roadHalfWidth(other.cls, other.coord) + SIDEWALK_WIDTH[other.cls]
      iv.push([other.coord - half, other.coord + half])
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
    // Keep the block base out of the road and sidewalk footprints. The previous
    // full 97 m slab sat directly beneath the asphalt (only 2 cm lower) and
    // every sidewalk, leaving two broad surfaces for the depth buffer to sort.
    let xs: [number, number][] = [[b.cx - 48.5, b.cx + 48.5]]
    let zs: [number, number][] = [[b.cz - 48.5, b.cz + 48.5]]
    const cut = (intervals: [number, number][], center: number, half: number): [number, number][] => {
      const out: [number, number][] = []
      for (const [a, end] of intervals) {
        const lo = center - half, hi = center + half
        if (hi <= a || lo >= end) out.push([a, end])
        else {
          if (lo > a) out.push([a, Math.min(lo, end)])
          if (hi < end) out.push([Math.max(hi, a), end])
        }
      }
      return out
    }
    for (const road of plan.roads) {
      if (road.transitOnly) continue // separate terminal paving owns this area
      const half = road.pedestrianOnly ? 4.2 : roadHalfWidth(road.cls, road.coord) + SIDEWALK_WIDTH[road.cls]
      if (road.axis === 'x' && road.to > b.cx - 48.5 && road.from < b.cx + 48.5) zs = cut(zs, road.coord, half)
      if (road.axis === 'z' && road.to > b.cz - 48.5 && road.from < b.cz + 48.5) xs = cut(xs, road.coord, half)
    }
    const pieces: THREE.BufferGeometry[] = []
    for (const [x0, x1] of xs) for (const [z0, z1] of zs) {
      if (x1 - x0 < 0.5 || z1 - z0 < 0.5) continue
      const g = new THREE.BoxGeometry(x1 - x0, 0.12, z1 - z0)
      g.translate((x0 + x1) / 2, -0.06, (z0 + z1) / 2)
      pieces.push(g)
    }
    const target = b.zone === 'park' ? slabGreen
      : b.zone === 'plaza' ? slabPlaza
      : b.zone === 'industrial' ? slabInd
      : b.zone === 'downtown' || b.zone === 'commercial' || b.zone === 'mixed' ? slabCourt
      : slabPaved
    target.push(...pieces)
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
    if (road.transitOnly) continue // terminal owns its continuous paving
    const width = roadHalfWidth(road.cls, road.coord) * 2
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
    // Give every junction's north/south (z-axis) road the continuous asphalt
    // surface. Cut the east/west (x-axis) strip out across it so two coplanar
    // road tops never compete for the same pixels at an intersection.
    if (road.axis === 'x') {
      emit(road.from, road.to, blockedAsphaltIntervals(road), (a, b) => {
        asphaltGeos.push(strip(road.axis, road.coord, a, b, width, 0.02, 0.16, 6))
      })
    } else {
      asphaltGeos.push(strip(road.axis, road.coord, road.from, road.to, width, 0.02, 0.16, 6))
    }
    // sidewalks + curbs on both sides, BROKEN at every crossing street.
    // margin 0: the strips end EXACTLY at the crossing asphalt edge — the
    // corner patch then continues the same band flush, so there is no
    // gutter sliver of double-drawn sidewalk (and no 1 cm step) at corners.
    const blocked0 = blockedIntervals(road, 0)
    for (const s of [-1, 1]) {
      const hw = roadHalfWidth(road.cls, road.coord)
      const off = hw + SIDEWALK_WIDTH[road.cls] / 2
      // Stop each sidewalk at the far edge of the crossing sidewalk band; the
      // corner patch fills that tile, so it is the only top surface there.
      const blockedSidewalk = blockedSidewalkIntervals(road)
      emit(road.from, road.to, blockedSidewalk, (a, b) => {
        sidewalkGeos.push(strip(road.axis, road.coord + s * off, a, b, SIDEWALK_WIDTH[road.cls], 0.14, 0.3, 2.4))
      })
      emit(road.from, road.to, blocked0, (a, b) => {
        curbGeos.push(strip(road.axis, road.coord + s * (hw + 0.09), a, b, 0.18, 0.16, 0.34))
      })
    }
    if (road.cls === 'arterial' && road.coord === 0) {
      // tram street: track bed + rails — DOUBLE TRACK (±1.6 m, one per direction)
      const hasCrossingTrack = road.axis === 'x' && plan.roads.some(other => other.axis === 'z' && other.cls === 'arterial' && other.coord === 0)
      if (hasCrossingTrack) {
        // The north/south bed owns the central crossing; avoid a second
        // coplanar 5.2 m plate over it.
        emit(road.from, road.to, [[-2.6, 2.6]], (a, b) => {
          trackBedGeos.push(strip(road.axis, road.coord, a, b, 5.2, 0.035, 0.12))
        })
      } else {
        trackBedGeos.push(strip(road.axis, road.coord, road.from, road.to, 5.2, 0.035, 0.12))
      }
      const hasCrossingRails = road.axis === 'x' && plan.roads.some(other => other.axis === 'z' && other.cls === 'arterial' && other.coord === 0)
      for (const t of [-1.6, 1.6]) {
        for (const s of [-0.75, 0.75]) {
          const addRail = (a: number, b: number) => railGeos.push(strip(road.axis, road.coord + t + s, a, b, 0.1, 0.11, 0.14))
          if (hasCrossingRails) {
            const crossings = [-2.35, -0.85, 0.85, 2.35].map(center => [center - 0.05, center + 0.05] as [number, number])
            emit(road.from, road.to, crossings, addRail)
          } else addRail(road.from, road.to)
        }
      }
    }
  }

  // markings per road
  for (const road of plan.roads) {
    if (road.pedestrianOnly || road.transitOnly) continue
    const width = roadHalfWidth(road.cls, road.coord) * 2
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
    whiteGeos.push(...createCrosswalkStripes(cw))
  }

  const polygon = (points: { x: number; z: number }[], geos = whiteGeos) => {
    const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z)))
    const geo = new THREE.ShapeGeometry(shape)
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, 0.09, 0)
    geos.push(geo)
  }
  const line = (a: { x: number; z: number }, b: { x: number; z: number }, width = 0.12, geos = whiteGeos) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    const rx = -(b.z - a.z) / length * width / 2, rz = (b.x - a.x) / length * width / 2
    polygon([{ x: a.x + rx, z: a.z + rz }, { x: b.x + rx, z: b.z + rz }, { x: b.x - rx, z: b.z - rz }, { x: a.x - rx, z: a.z - rz }], geos)
  }
  // Stop bars and lane arrows come from the same final lanes as the cars.
  // No paint crosses the tram bed or suggests a turn from the wrong pocket.
  for (const lane of network.lanes.values()) {
    if (!lane.signalId) continue
    const length = Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1)
    const fx = (lane.x2 - lane.x1) / length, fz = (lane.z2 - lane.z1) / length
    const point = (u: number, v: number) => ({ x: lane.x2 - fz * u + fx * v, z: lane.z2 + fx * u + fz * v })
    const half = (lane.laneWidth ?? 3) / 2 - 0.1
    line(point(-half, 0), point(half, 0), 0.45)
    if (!lane.pocket) continue
    for (const distance of [10, 21]) {
      const p = (u: number, v: number) => point(u, v - distance)
      line(p(0, -2), p(0, 0.8), 0.22)
      if (lane.pocket === 'left') {
        line(p(0, 0.8), p(-1.05, 0.8), 0.22)
        polygon([p(-1.3, 0.8), p(-0.65, 0.2), p(-0.65, 1.4)])
      } else {
        polygon([p(0, 1.8), p(-0.55, 0.7), p(0.55, 0.7)])
        line(p(0, -0.2), p(0.9, 0.8), 0.2)
        polygon([p(1.2, 1.1), p(0.35, 0.9), p(0.9, 0.25)])
      }
    }
    if (lane.pocket === 'left') {
      for (let d = 3; d < 27; d += 4) line(point((lane.laneWidth ?? 3) / 2, -d), point((lane.laneWidth ?? 3) / 2, -d - 2), 0.12)
    }
  }
  // Keep-clear boxes make the reserved junction area legible, with the rails
  // still continuous. Cycle crossings continue across each junction mouth.
  for (const signal of plan.trafficLights) {
    const hwX = roadHalfWidth(lineClsOf(signal.x), signal.x)
    const hwZ = roadHalfWidth(lineClsOf(signal.z), signal.z)
    const x0 = signal.x - hwX + 1, x1 = signal.x + hwX - 1
    const z0 = signal.z - hwZ + 1, z1 = signal.z + hwZ - 1
    line({ x: x0, z: z0 }, { x: x1, z: z0 }, 0.12, yellowGeos)
    line({ x: x1, z: z0 }, { x: x1, z: z1 }, 0.12, yellowGeos)
    line({ x: x1, z: z1 }, { x: x0, z: z1 }, 0.12, yellowGeos)
    line({ x: x0, z: z1 }, { x: x0, z: z0 }, 0.12, yellowGeos)
    for (let offset = -(z1 - z0) + 4; offset < x1 - x0; offset += 4) {
      const t0 = Math.max(0, -offset), t1 = Math.min(z1 - z0, x1 - x0 - offset)
      if (t1 > t0) line({ x: x0 + offset + t0, z: z0 + t0 }, { x: x0 + offset + t1, z: z0 + t1 }, 0.1, yellowGeos)
    }
    for (const side of [-1, 1]) {
      bikeGeos.push(strip('x', signal.z + side * (hwZ - 1), signal.x - hwX, signal.x + hwX, 1.6, 0.055, 0.02))
      bikeGeos.push(strip('z', signal.x + side * (hwX - 1), signal.z - hwZ, signal.z + hwZ, 1.6, 0.055, 0.02))
    }
  }

  // corner sidewalk patches — ONLY where two roads actually cross, and
  // flush with the sidewalk strips (top exactly 0.14): the old +0.15 top
  // left a 1 cm lip over every strip and patches spawned even where one of
  // the two streets never reaches the junction
  for (const x of GRID_LINES) {
    for (const z of GRID_LINES) {
      const roadAlongX = plan.roads.some((r) => r.axis === 'x' && r.coord === z && r.from <= x + 0.1 && r.to >= x - 0.1)
      const roadAlongZ = plan.roads.some((r) => r.axis === 'z' && r.coord === x && r.from <= z + 0.1 && r.to >= z - 0.1)
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
  // These are intentional overlays on road tops. A small polygon offset keeps
  // the paint stable at distance without changing the shared city materials.
  addMerged(whiteGeos, decalMaterial(mats.roadLine))
  addMerged(yellowGeos, decalMaterial(mats.roadLineYellow))
  addMerged(bikeGeos, decalMaterial(mats.bikeLane))
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
