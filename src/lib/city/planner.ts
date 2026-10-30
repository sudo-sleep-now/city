import { CITY, GRID_LINES, SIDEWALK_WIDTH, lineClass } from './constants'
import type {
  AABB,
  Block,
  BuildingSpec,
  CityPlan,
  CityStats,
  CrosswalkSpec,
  EnterableSpec,
  ParkSpec,
  POI,
  RoadSpec,
  TrafficLightSpec,
  TransitRoute,
  TransitStop,
  ZoneKind,
} from './types'

/* ============================================================
 * SOLHEIM CityPlanner
 *
 * The city is INTENTIONALLY designed. Layout rationale (used by
 * POI panels + stats):
 *  - Downtown (high density, offices + mixed towers) within the
 *    arterial square [-200,200]², so through-traffic can bypass it.
 *  - Central Park 200×200 m directly north of downtown, near
 *    downtown and Parkside destinations.
 *  - Tram lines on both central arterials (x=0, z=0) connect all
 *    districts; density decreases with distance from tram stops.
 *  - One car-free shopping street (x=100 through downtown).
 *  - Industrial SE corner: downwind edge, rail-served, direct
 *    arterial (x=400) + ring access, far from most homes.
 *  - Schools and services are distributed through residential areas;
 *    straight-line distances are planning indicators, not walking routes.
 *  - Emergency-service sites connect to streets; response times are not simulated.
 *  - Pocket parks + gardens are distributed through residential areas;
 *    computed proximity figures use straight-line distance.
 * ============================================================ */

/** half road width incl. tram median on central arterials */
export function roadHalfWidth(cls: string, coord: number): number {
  if (cls === 'arterial') return coord === 0 ? 11 : 8
  if (cls === 'collector') return 5.5
  return 3.5
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20250417)
const rr = (a: number, b: number) => a + rand() * (b - a)
const ri = (a: number, b: number) => Math.floor(rr(a, b + 1))
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]

function distToRect(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = Math.max(x0 - px, 0, px - x1)
  const dz = Math.max(z0 - pz, 0, pz - z1)
  return Math.hypot(dx, dz)
}

export function planCity(): CityPlan {
  const blocks: Block[] = []
  const roads: RoadSpec[] = []
  const buildings: BuildingSpec[] = []
  const parks: ParkSpec[] = []
  const colliders: AABB[] = []
  const pois: POI[] = []
  const stops: TransitStop[] = []
  const routes: TransitRoute[] = []
  const trafficLights: TrafficLightSpec[] = []
  const crosswalks: CrosswalkSpec[] = []
  const enterables: EnterableSpec[] = []
  let bid = 0

  /* ---------------- roads ---------------- */
  for (const coord of GRID_LINES) {
    const cls = lineClass(coord)
    if (coord === 100) {
      // car-free shopping street through downtown + vehicle parts outside
      roads.push({ id: `rx100a`, axis: 'x', coord, from: -600, to: -200, cls: 'local' })
      roads.push({ id: `rx100b`, axis: 'x', coord, from: -200, to: 200, cls: 'local', pedestrianOnly: true })
      roads.push({ id: `rx100c`, axis: 'x', coord, from: 200, to: 600, cls: 'local' })
    } else {
      roads.push({ id: `r${coord < 0 ? 'n' : coord > 0 ? 'p' : 'c'}${Math.abs(coord)}-${'z'}`, axis: 'x', coord, from: -600, to: 600, cls })
      roads.push({ id: `r${coord < 0 ? 'n' : coord > 0 ? 'p' : 'c'}${Math.abs(coord)}-${'x'}`, axis: 'z', coord, from: -600, to: 600, cls })
    }
  }
  // A one-way bus loop stays inside the forecourt, leaving the tram avenue
  // and its pavement clear. The east street supplies both access points.
  roads.push(
    { id: 'solheim-bus-in', axis: 'x', coord: -124, from: 35, to: 100, cls: 'local', transitOnly: true },
    { id: 'solheim-bus-out', axis: 'x', coord: -108, from: 35, to: 100, cls: 'local', transitOnly: true },
  )

  /* ---------------- block classification ---------------- */
  const pocketParks = new Set(['1,5', '2,10', '9,3', '10,7', '4,2', '7,10', '1,8', '8,10'])
  const special: Record<string, ZoneKind> = {
    '5,2': 'park', '6,2': 'park', '5,3': 'park', '6,3': 'park', // central park 2×2
    '6,5': 'plaza',
    '6,4': 'special', // transit hub (hub building at 50,-148 → block 6,4)
    '5,5': 'special', // market hall (-52,-50 → block 5,5)
    '8,5': 'civic', // hospital (250,-62/-18 → block 8,5)
    '3,7': 'civic', // fire station (-252,148 → block 3,7)
    '9,5': 'civic', // Fire Station 1 + emergency depot bay (330,-2.4 → block 9,5)
    '8,6': 'civic', // police (252,52 → block 8,6)
    '3,3': 'civic', // school NW (-252,-266 → block 3,3)
    '8,3': 'civic', // school NE (252,-266 → block 8,3)
    '3,9': 'civic', // school SW (-252,338 → block 3,9)
    '5,9': 'park', // sports park
    '8,8': 'park', // community garden
    '3,5': 'commercial',
    '7,6': 'commercial',
    '3,6': 'civic', // grocery block (-252,48 → block 3,6)
    '5,7': 'special', // office with enterable lobby (-52,148 → block 5,7)
    '7,3': 'civic', // city library (150,-252 → block 7,3, by Central Park)
    '10,3': 'civic', // walk-in clinic (352,-250 → block 10,3, by pocket park + school)
    '7,4': 'special', // Skylink Towers — twin-tower landmark with sky bridge (block 7,4)
  }
  for (let bj = 9; bj <= 11; bj++) for (let bi = 9; bi <= 11; bi++) special[`${bi},${bj}`] = 'industrial'

  function districtName(bi: number, bj: number): string {
    if (bi >= 9 && bj >= 9) return 'Ironworks (Industrial)'
    if (bi >= 4 && bi <= 7 && bj >= 4 && bj <= 7) return 'Downtown Core'
    if (bj <= 3) return bi <= 3 ? 'Maple Heights (NW)' : bi <= 8 ? 'Parkside (N)' : 'Northgate (NE)'
    if (bj >= 8) return bi <= 4 ? 'Greenfield South (SW)' : 'Southfield (S)'
    return bi <= 3 ? 'Westbrook (W)' : 'Eastgate (E)'
  }

  for (let bj = 0; bj < CITY.blocks; bj++) {
    for (let bi = 0; bi < CITY.blocks; bi++) {
      const x0 = -600 + bi * CITY.pitch
      const z0 = -600 + bj * CITY.pitch
      const cx = x0 + 50
      const cz = z0 + 50
      let zone: ZoneKind
      if (special[`${bi},${bj}`]) zone = special[`${bi},${bj}`]
      else if (pocketParks.has(`${bi},${bj}`)) zone = 'park'
      else if (bi >= 4 && bi <= 7 && bj >= 4 && bj <= 7) zone = 'downtown'
      else if (bi <= 1 || bi >= 10 || bj <= 1 || bj >= 10) zone = 'residential-low'
      else if (bi >= 3 && bi <= 8 && bj >= 3 && bj <= 8) zone = rand() < 0.45 ? 'mixed' : 'residential-medium'
      else zone = 'residential-medium'
      blocks.push({ bi, bj, x0, z0, x1: x0 + 100, z1: z0 + 100, cx, cz, zone, district: districtName(bi, bj) })
    }
  }

  /* ---------------- helper: usable rect of a block ---------------- */
  function usable(b: Block) {
    const hwW = roadHalfWidth(lineClass(b.x0), b.x0) // west edge road
    const hwE = roadHalfWidth(lineClass(b.x1), b.x1)
    const hwN = roadHalfWidth(lineClass(b.z0), b.z0)
    const hwS = roadHalfWidth(lineClass(b.z1), b.z1)
    const set = 2.2
    return {
      x0: b.x0 + hwW + set,
      x1: b.x1 - hwE - set,
      z0: b.z0 + hwN + set,
      z1: b.z1 - hwS - set,
    }
  }

  function addBuilding(spec: Omit<BuildingSpec, 'id'>) {
    const id = `b${bid++}`
    buildings.push({ ...spec, id })
    const swap = spec.rotation === 90 || spec.rotation === 270
    const w = swap ? spec.d : spec.w
    const d = swap ? spec.w : spec.d
    if (spec.kind !== 'transit-hub') colliders.push({ minX: spec.x - w / 2, maxX: spec.x + w / 2, minZ: spec.z - d / 2, maxZ: spec.z + d / 2, h: spec.height })
    return id
  }

  function facingNearestStreet(b: Block, x: number, z: number): BuildingSpec['rotation'] {
    const dl = x - b.x0
    const dr = b.x1 - x
    const dn = z - b.z0
    const ds = b.z1 - z
    const m = Math.min(dl, dr, dn, ds)
    if (m === ds) return 0 // south (+Z)
    if (m === dn) return 180
    if (m === dr) return 90 // east (+X)
    return 270
  }

  /* ---------------- per-zone building generation ---------------- */
  for (const b of blocks) {
    const u = usable(b)
    const uw = u.x1 - u.x0
    const ud = u.z1 - u.z0
    const dCenter = Math.max(Math.abs(b.cx), Math.abs(b.cz))

    switch (b.zone) {
      case 'downtown': {
        // subdivide into 2×2 lots; tall towers near center
        const gap = 6
        const lotW = (uw - gap) / 2
        const lotD = (ud - gap) / 2
        const baseFloors = Math.round(26 - (dCenter / 200) * 16) // 26 center → 10 edge
        for (let li = 0; li < 2; li++) {
          for (let lj = 0; lj < 2; lj++) {
            if (rand() < 0.12) continue // small plaza gap downtown
            const lx = u.x0 + lotW / 2 + li * (lotW + gap)
            const lz = u.z0 + lotD / 2 + lj * (lotD + gap)
            const w = rr(lotW * 0.58, lotW * 0.82)
            const d = rr(lotD * 0.58, lotD * 0.82)
            const floors = Math.max(6, Math.min(32, Math.round(baseFloors * rr(0.7, 1.35))))
            const kind = rand() < 0.55 ? 'office' : 'mixed'
            addBuilding({
              kind, x: lx, z: lz, w: Math.round(w), d: Math.round(d), rotation: 0,
              floors, height: floors * 3.1 + 4,
              // ≥14 floors render as glass towers; below that spread SEVEN
              // facade families (bronze curtain 18, green glass grid 20,
              // limestone 15, stone 7 added to the old pale panel trio)
              facadeVariant: floors >= 14 ? 6 : pick([5, 6, 16, 18, 20, 15, 7]),
              units: kind === 'mixed' ? Math.min(160, floors * Math.max(3, Math.round((w * d) / 85))) : 0,
              jobs: Math.round(((w * d * floors) / 22) * (kind === 'mixed' ? 0.4 : 1)),
            })
          }
        }
        break
      }
      case 'commercial': {
        const n = 3
        for (let i = 0; i < n; i++) {
          const lx = u.x0 + uw * (0.22 + 0.28 * i) + rr(-3, 3)
          const lz = u.z0 + ud * rr(0.3, 0.7)
          addBuilding({
            kind: i === 0 ? 'retail' : 'office', x: Math.round(lx), z: Math.round(lz),
            w: ri(26, 32), d: ri(22, 28), rotation: pick([0, 90, 180, 270] as const),
            floors: ri(5, 9), height: rr(5, 9) * 3.2 + 4, facadeVariant: pick([5, 6, 16, 18, 20]),
            units: 0, jobs: ri(40, 90),
          })
        }
        break
      }
      case 'mixed': {
        for (let li = 0; li < 2; li++) {
          for (let lj = 0; lj < 2; lj++) {
            if (rand() < 0.15) continue
            const lx = u.x0 + uw * (0.27 + 0.46 * li)
            const lz = u.z0 + ud * (0.27 + 0.46 * lj)
            const w = rr(20, 27), d = rr(16, 22)
            const floors = ri(5, 9)
            addBuilding({
              kind: 'mixed', x: Math.round(lx), z: Math.round(lz), w: Math.round(w), d: Math.round(d),
              rotation: facingNearestStreet(b, lx, lz),
              floors, height: floors * 3 + 4, facadeVariant: pick([5, 6, 0, 12, 19]),
              units: Math.min(70, floors * Math.max(2, Math.round((w * d) / 60))), jobs: ri(8, 24),
            })
          }
        }
        break
      }
      case 'residential-medium': {
        const pattern = pick(['apts', 'apts', 'rows', 'aptsgarden'])
        if (pattern === 'apts') {
          for (let li = 0; li < 2; li++) {
            for (let lj = 0; lj < 2; lj++) {
              const lx = u.x0 + uw * (0.27 + 0.46 * li)
              const lz = u.z0 + ud * (0.27 + 0.46 * lj)
              const w = rr(19, 26), d = rr(15, 21)
              const floors = ri(4, 8)
              addBuilding({
                kind: 'apartment', x: Math.round(lx), z: Math.round(lz), w: Math.round(w), d: Math.round(d),
                rotation: facingNearestStreet(b, lx, lz),
                floors, height: floors * 2.9 + 3.5, facadeVariant: pick([0, 1, 2, 10, 12, 19]),
                units: Math.min(64, floors * Math.max(2, Math.round((w * d) / 52))), jobs: 0,
              })
            }
          }
        } else if (pattern === 'rows') {
          for (let row = 0; row < 2; row++) {
            for (let i = 0; i < 2; i++) {
              const lx = u.x0 + uw * (0.28 + 0.44 * i)
              const lz = u.z0 + ud * (0.26 + 0.48 * row)
              addBuilding({
                kind: 'residential', x: Math.round(lx + rr(-2, 2)), z: Math.round(lz), w: ri(24, 32), d: ri(9, 12),
                rotation: row === 0 ? 180 : 0, floors: 3, height: 3 * 2.8 + 3,
                facadeVariant: pick([0, 1, 9, 10, 11]), units: Math.round(ri(24, 32) / 3.4), jobs: 0,
              })
            }
          }
        } else {
          for (let li = 0; li < 2; li++) {
            const lx = u.x0 + uw * (0.3 + 0.4 * li)
            const lz = u.z0 + ud * 0.3
            const floors = ri(5, 7)
            const w2 = ri(20, 25)
            const d2 = ri(15, 19)
            addBuilding({
              kind: 'apartment', x: Math.round(lx), z: Math.round(lz), w: w2, d: d2,
              rotation: 180, floors, height: floors * 2.9 + 3.5, facadeVariant: pick([1, 2, 13, 14]),
              units: Math.min(52, floors * Math.max(2, Math.round((w2 * d2) / 52))), jobs: 0,
            })
          }
        }
        break
      }
      case 'residential-low': {
        for (let row = 0; row < 2; row++) {
          for (let i = 0; i < 3; i++) {
            const lx = u.x0 + uw * (0.2 + 0.3 * i) + rr(-3, 3)
            const lz = u.z0 + ud * (0.28 + 0.44 * row) + rr(-2, 2)
            if (rand() < 0.1) continue
            addBuilding({
              kind: 'residential', x: Math.round(lx), z: Math.round(lz), w: ri(11, 14), d: ri(8, 10),
              rotation: facingNearestStreet(b, lx, lz),
              floors: 2, height: 2 * 2.8 + 3, facadeVariant: pick([3, 4, 9, 12, 13, 14, 17]),
              units: 2, jobs: 0,
            })
          }
        }
        break
      }
      case 'industrial': {
        if (b.bi === 9 && b.bj === 9) {
          addBuilding({ kind: 'depot', x: b.cx, z: b.cz - 12, w: 52, d: 30, rotation: 0, floors: 1, height: 9, facadeVariant: 8, units: 0, jobs: 30, label: 'BUS DEPOT' })
          addBuilding({ kind: 'industrial', x: b.cx - 20, z: b.cz + 22, w: 30, d: 18, rotation: 0, floors: 1, height: 7, facadeVariant: 8, units: 0, jobs: 14 })
        } else if (b.bi === 10 && b.bj === 10) {
          addBuilding({ kind: 'utility', x: b.cx, z: b.cz - 10, w: 40, d: 24, rotation: 0, floors: 1, height: 8, facadeVariant: 8, units: 0, jobs: 18, label: 'UTILITY YARD' })
          addBuilding({ kind: 'industrial', x: b.cx, z: b.cz + 24, w: 34, d: 16, rotation: 0, floors: 1, height: 6.5, facadeVariant: 8, units: 0, jobs: 10, label: 'RECYCLING' })
        } else if (b.bi === 10 && b.bj === 9) {
          addBuilding({ kind: 'industrial', x: b.cx, z: b.cz, w: 58, d: 36, rotation: 0, floors: 1, height: 12, facadeVariant: 8, units: 0, jobs: 55, label: 'FACTORY' })
        } else {
          const n = b.bi === 9 && b.bj === 10 ? 2 : rand() < 0.5 ? 2 : 1
          if (n === 2) {
            addBuilding({ kind: 'industrial', x: Math.round(u.x0 + uw * 0.3), z: b.cz - 16, w: 44, d: 26, rotation: 0, floors: 1, height: rr(9, 12), facadeVariant: 8, units: 0, jobs: ri(30, 45) })
            addBuilding({ kind: 'industrial', x: Math.round(u.x0 + uw * 0.72), z: b.cz + 16, w: 40, d: 24, rotation: 0, floors: 1, height: rr(8, 11), facadeVariant: 8, units: 0, jobs: ri(25, 40) })
          } else {
            addBuilding({ kind: 'industrial', x: b.cx, z: b.cz, w: ri(48, 58), d: ri(28, 38), rotation: 0, floors: 1, height: rr(9, 13), facadeVariant: 8, units: 0, jobs: ri(40, 70) })
          }
        }
        break
      }
      default:
        break // parks/plaza/special-civic handled below
    }
  }

  /* ---------------- special buildings ---------------- */
  // Central Transit Hub (block 6,4: x 0..100, z -200..-100)
  {
    const id = addBuilding({ kind: 'transit-hub', x: 50, z: -148, w: 64, d: 30, rotation: 0, floors: 3, height: 13, facadeVariant: 6, units: 0, jobs: 45, label: 'SOLHEIM INTERCHANGE' })
    // Walk through the real glazed hall. No detached interior teleport.
    // The tram lines remain on the central arterials. The nearby T1 stop is
    // linked to this hall by a signed pedestrian path, not a station platform.
  }
  // Market Hall (block 5,5: x -100..0, z -100..0)
  {
    const id = addBuilding({ kind: 'market', x: -52, z: -50, w: 56, d: 36, rotation: 0, floors: 2, height: 14, facadeVariant: 7, units: 0, jobs: 60, label: 'MARKET HALL', enterableId: 'market' })
    enterables.push({ id, buildingId: id, name: 'Market Hall', interiorKind: 'market', doorX: -52, doorZ: -32, facing: 0, w: 52, d: 32, h: 13 })
  }
  // Café pavilion on the plaza (block 6,5)
  {
    const id = addBuilding({ kind: 'retail', x: 78, z: -22, w: 14, d: 11, rotation: 180, floors: 1, height: 4.6, facadeVariant: 5, units: 0, jobs: 8, label: 'CAFÉ VERDE', enterableId: 'cafe' })
    enterables.push({ id, buildingId: id, name: 'Café Verde', interiorKind: 'cafe', doorX: 78, doorZ: -27.5, facing: 180, w: 13, d: 10, h: 4.2 })
  }
  // Grocery (block 4,6)
  {
    const id = addBuilding({ kind: 'retail', x: -252, z: 48, w: 22, d: 16, rotation: 0, floors: 1, height: 6, facadeVariant: 5, units: 0, jobs: 22, label: 'NEIGHBORHOOD MARKET', enterableId: 'grocery' })
    enterables.push({ id, buildingId: id, name: 'Neighborhood Market', interiorKind: 'grocery', doorX: -252, doorZ: 56, facing: 0, w: 21, d: 15, h: 5.6 })
  }
  // Office with enterable lobby (block 5,7)
  {
    const id = addBuilding({ kind: 'office', x: -52, z: 148, w: 26, d: 22, rotation: 0, floors: 9, height: 9 * 3.2 + 4, facadeVariant: 6, units: 0, jobs: 120, label: 'GREENWORKS TOWER', enterableId: 'office' })
    enterables.push({ id, buildingId: id, name: 'Greenworks Tower — Lobby', interiorKind: 'office', doorX: -52, doorZ: 159, facing: 0, w: 25, d: 21, h: 8 })
  }
  // Hospital (block 8,5)
  {
    // rotation 180: the entrance decor (canopy, mural, glass bands) is built
    // on the local +z face — with the default rotation it faced the arterial
    // side where the TOWER (z=-28) stands 21 m away and buried the entrance
    // in a dead courtyard. Flipped, it faces the z=-100 street + plaza.
    addBuilding({ kind: 'hospital', x: 250, z: -62, w: 58, d: 26, rotation: 180, floors: 3, height: 12, facadeVariant: 7, units: 0, jobs: 90, label: 'CITY HOSPITAL' })
    // Keep the entire pavement clear when the central avenue gains turn-lane
    // width. The tower's south facade starts beyond the 5m walking strip.
    const towerZ = -(roadHalfWidth('arterial', 0) + SIDEWALK_WIDTH.arterial + 13)
    addBuilding({ kind: 'hospital', x: 250, z: towerZ, w: 30, d: 26, rotation: 0, floors: 9, height: 32, facadeVariant: 6, units: 0, jobs: 120, label: '' })
  }
  // City Library (block 7,3 — beside Central Park, on the school walk-route)
  {
    const id = addBuilding({ kind: 'library', x: 150, z: -252, w: 46, d: 30, rotation: 0, floors: 2, height: 12, facadeVariant: 7, units: 0, jobs: 24, label: 'CITY LIBRARY', enterableId: 'library' })
    enterables.push({ id, buildingId: id, name: 'City Library — Reading Hall', interiorKind: 'library', doorX: 150, doorZ: -237, facing: 0, w: 44, d: 28, h: 10.5 })
  }
  // Northgate Walk-in Clinic (block 10,3 — pocket park + school + homes)
  {
    const id = addBuilding({ kind: 'clinic', x: 352, z: -250, w: 26, d: 18, rotation: 0, floors: 1, height: 5.6, facadeVariant: 6, units: 0, jobs: 16, label: 'NORTHGATE CLINIC', enterableId: 'clinic' })
    enterables.push({ id, buildingId: id, name: 'Northgate Walk-in Clinic', interiorKind: 'clinic', doorX: 352, doorZ: -241, facing: 0, w: 24, d: 16, h: 5.2 })
  }
  // SKYLINK TOWERS (block 7,4 — downtown landmark, one block east of the
  // Central Station plaza): two DIFFERENT-height glass towers on a shared
  // retail podium, connected by a glazed sky bridge at level ~18. The
  // bridge lands high on the SHORTER tower's top third — the pair reads as
  // one gate over the x=100 car-free street from the station steps.
  {
    const twId = addBuilding({ kind: 'twinTowers', x: 149, z: -148, w: 62, d: 36, rotation: 0, floors: 30, height: 101, facadeVariant: 6, units: 0, jobs: 520, label: 'SKYLINK TOWERS' })
    // public podium lobby — and the panoramic elevator to the 79 m sky deck
    enterables.push({ id: twId, buildingId: twId, name: 'Skylink Towers — Lobby', interiorKind: 'skylink', doorX: 149, doorZ: -130, facing: 0, w: 30, d: 20, h: 9 })
  }
  // Fire stations — dispatch toasts say "Station 1", so the station the
  // EmergencySystem drives out of (depot bay at 330,-2.4) carries the name;
  // the Westbrook house is the second-alarm battalion
  addBuilding({ kind: 'fire', x: -252, z: 148, w: 42, d: 20, rotation: 0, floors: 2, height: 10, facadeVariant: 8, units: 0, jobs: 24, label: 'FIRE STATION 2' })
  addBuilding({ kind: 'fire', x: 330, z: -27, w: 42, d: 20, rotation: 0, floors: 2, height: 10, facadeVariant: 8, units: 0, jobs: 24, label: 'FIRE STATION 1' })
  // Police (block 8,6)
  addBuilding({ kind: 'police', x: 252, z: 52, w: 34, d: 22, rotation: 0, floors: 3, height: 12, facadeVariant: 7, units: 0, jobs: 30, label: 'POLICE HQ' })
  // Schools ×3
  const schools: [number, number, string][] = [
    [-252, -252, 'Maple Elementary'],
    [252, -252, 'Northgate Elementary'],
    [-252, 352, 'Greenfield Elementary'],
  ]
  for (const [sx, sz, name] of schools) {
    addBuilding({ kind: 'school', x: sx, z: sz - 14, w: 46, d: 20, rotation: 0, floors: 3, height: 11, facadeVariant: 7, units: 0, jobs: 28, label: name.toUpperCase() })
  }

  /* ---------------- parks ---------------- */
  parks.push({ id: 'park-central', kind: 'central-park', x0: -100, z0: -400, x1: 100, z1: -200, name: 'Central Park' })
  parks.push({ id: 'park-plaza', kind: 'plaza', x0: 0, z0: -100, x1: 100, z1: 0, name: 'Solheim Square' })
  parks.push({ id: 'park-sports', kind: 'sports', x0: -100, z0: 300, x1: 0, z1: 400, name: 'Southfield Sports Park' })
  parks.push({ id: 'park-garden', kind: 'garden', x0: 200, z0: 200, x1: 300, z1: 300, name: 'Community Gardens' })
  const pocketCoords: [number, number][] = [[1, 5], [2, 10], [9, 3], [10, 7], [4, 2], [7, 10], [1, 8], [8, 10]]
  pocketCoords.forEach(([bi, bj], i) => {
    const x0 = -600 + bi * 100
    const z0 = -600 + bj * 100
    parks.push({ id: `park-pocket-${i}`, kind: 'pocket-park', x0, z0, x1: x0 + 100, z1: z0 + 100, name: `Pocket Park ${i + 1}` })
  })

  /* ---------------- transit routes & stops ---------------- */
  const tramStopsT1: [number, string][] = [
    [-400, 'North Terminal'], [-300, 'Park North'], [-200, 'Central Park'], [-182, 'Interchange Walk'], [0, 'Central Hub'], [200, 'Civic Plaza'], [400, 'Southfield'], [580, 'South Terminal'],
  ]
  tramStopsT1.forEach(([z, name]) => stops.push({ id: `t1-${z}`, x: 0, z, mode: 'tram', name, routeIds: ['T1'] }))
  const tramStopsT2: [number, string][] = [
    [-580, 'West Terminal'], [-400, 'Westbrook'], [-200, 'Westgate'], [0, 'Central Hub'], [200, 'Eastgate'], [400, 'Hospital'], [580, 'East Terminal'],
  ]
  tramStopsT2.forEach(([x, name]) => stops.push({ id: `t2-${x}`, x, z: 0, mode: 'tram', name, routeIds: ['T2'] }))
  routes.push({ id: 'T1', mode: 'tram', name: 'Tram T1 — Green Line', color: '#16a34a', points: [{ x: 0, z: -580 }, { x: 0, z: 580 }], stopIds: tramStopsT1.map(([z]) => `t1-${z}`) })
  routes.push({ id: 'T2', mode: 'tram', name: 'Tram T2 — Sun Line', color: '#ea580c', points: [{ x: -580, z: 0 }, { x: 580, z: 0 }], stopIds: tramStopsT2.map(([x]) => `t2-${x}`) })

  const busStopsB1: [number, number, string][] = [
    [0, -200, 'North Inner'], [200, 0, 'East Inner'], [0, 200, 'South Inner'], [-200, 0, 'West Inner'],
    [55, -124, 'Solheim Interchange — B1 City Loop'],
  ]
  busStopsB1.forEach(([x, z, name]) => stops.push({ id: `b1-${x}-${z}`, x, z, mode: 'bus', name, routeIds: ['B1'] }))
  routes.push({ id: 'B1', mode: 'bus', name: 'Bus B1 — Inner Loop', color: '#a16207', points: [
    // Arrive from the north, stop beside the hall, turn inside the forecourt,
    // then leave to the south. An 8 m centreline radius fits the bus turn.
    { x: -200, z: -200 }, { x: 100, z: -200 },
    { x: 100, z: -132 }, { x: 92, z: -124 }, { x: 55, z: -124 },
    { x: 35, z: -124 }, { x: 29.34, z: -121.66 }, { x: 27, z: -116 },
    { x: 29.34, z: -110.34 }, { x: 35, z: -108 },
    { x: 92, z: -108 }, { x: 100, z: -100 }, { x: 200, z: -100 },
    { x: 200, z: 200 }, { x: -200, z: 200 }, { x: -200, z: -200 },
  ], stopIds: busStopsB1.map(([x, z]) => `b1-${x}-${z}`) })

  const busStopsB2: [number, number, string][] = [
    [0, -600, 'North Terminal Bus'], [300, -600, 'Northgate East'], [600, 0, 'East Terminal'], [600, 300, 'Ironworks East'],
    [0, 600, 'South Terminal'], [-600, 0, 'West Terminal'],
  ]
  busStopsB2.forEach(([x, z, name]) => stops.push({ id: `b2-${x}-${z}`, x, z, mode: 'bus', name, routeIds: ['B2'] }))
  routes.push({ id: 'B2', mode: 'bus', name: 'Bus B2 — Ring Loop', color: '#b45309', points: [
    { x: -600, z: -600 }, { x: 600, z: -600 }, { x: 600, z: 600 }, { x: -600, z: 600 }, { x: -600, z: -600 },
  ], stopIds: busStopsB2.map(([x, z]) => `b2-${x}-${z}`) })

  const busStopsB3: [number, number, string][] = [
    [200, 0, 'Southeast Junction'], [400, 200, 'Foundry West'], [300, 400, 'Ironworks North'],
  ]
  busStopsB3.forEach(([x, z, name]) => stops.push({ id: `b3-${x}-${z}`, x, z, mode: 'bus', name, routeIds: ['B3'] }))
  routes.push({ id: 'B3', mode: 'bus', name: 'Bus B3 — Industrial Shuttle', color: '#78716c', points: [
    { x: 200, z: 0 }, { x: 400, z: 0 }, { x: 400, z: 400 }, { x: 200, z: 400 }, { x: 200, z: 0 },
  ], stopIds: busStopsB3.map(([x, z]) => `b3-${x}-${z}`) })

  /* -------- pull junction stops clear of the crossing road --------
   * Stops that sit exactly on an intersection block trams/buses and put
   * shelters/platforms inside the crossing roadway. Move each such stop
   * ~18 m past the crossing, along its route's direction of travel.     */
  {
    const dirOf = new Map<string, { dx: number; dz: number }>()
    for (const r of routes) {
      const pts = r.points
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 1
        const ux = (b.x - a.x) / segLen
        const uz = (b.z - a.z) / segLen
        for (const s of stops) {
          if (!r.stopIds.includes(s.id) || dirOf.has(s.id)) continue
          const t = Math.max(0, Math.min(segLen, (s.x - a.x) * ux + (s.z - a.z) * uz))
          const px = a.x + ux * t
          const pz = a.z + uz * t
          if (Math.hypot(s.x - px, s.z - pz) < 14) dirOf.set(s.id, { dx: ux, dz: uz })
        }
      }
    }
    for (const s of stops) {
      // junction = near a grid line on BOTH axes
      const nearX = GRID_LINES.find((l) => Math.abs(s.x - l) < 6)
      const nearZ = GRID_LINES.find((l) => Math.abs(s.z - l) < 6)
      if (nearX === undefined || nearZ === undefined) continue
      let dir = dirOf.get(s.id)
      if (!dir) dir = Math.abs(s.x) < 1 && Math.abs(s.z) < 1 ? { dx: 1, dz: 0 } : Math.abs(s.x) < 1 ? { dx: 0, dz: 1 } : { dx: 1, dz: 0 }
      // the crossing road is perpendicular to travel → nearest line on the travel axis
      if (Math.abs(dir.dx) > Math.abs(dir.dz)) {
        const cross = GRID_LINES.reduce((p, l) => (Math.abs(s.x - l) < Math.abs(s.x - p) ? l : p), GRID_LINES[0])
        s.x = cross + Math.sign(dir.dx) * (roadHalfWidth(lineClass(cross), cross) + 18)
      } else {
        const cross = GRID_LINES.reduce((p, l) => (Math.abs(s.z - l) < Math.abs(s.z - p) ? l : p), GRID_LINES[0])
        s.z = cross + Math.sign(dir.dz) * (roadHalfWidth(lineClass(cross), cross) + 18)
      }
    }
  }

  /* ---------------- traffic lights (signalized intersections) ---------------- */
  const arterialCoords = [-400, 0, 400]
  const innerCollectorCoords = [-200, 200]
  let tlid = 0
  for (const x of arterialCoords) {
    for (const z of arterialCoords) trafficLights.push({ id: `tl${tlid++}`, x, z, phase0Axis: 'x' })
  }
  for (const x of arterialCoords) {
    for (const z of innerCollectorCoords) trafficLights.push({ id: `tl${tlid++}`, x, z, phase0Axis: 'x' })
  }
  for (const z of arterialCoords) {
    for (const x of innerCollectorCoords) trafficLights.push({ id: `tl${tlid++}`, x, z, phase0Axis: 'z' })
  }

  /* ---------------- crosswalks at signalized intersections ---------------- */
  for (const tl of trafficLights) {
    const hwX = roadHalfWidth(lineClass(tl.x), tl.x)
    const hwZ = roadHalfWidth(lineClass(tl.z), tl.z)
    // two crossings per intersection (one across each road), offset from center
    crosswalks.push({ x: tl.x, z: tl.z - hwZ - 2.2, axis: 'x', roadCls: lineClass(tl.x) })
    crosswalks.push({ x: tl.x, z: tl.z + hwZ + 2.2, axis: 'x', roadCls: lineClass(tl.x) })
    crosswalks.push({ x: tl.x - hwX - 2.2, z: tl.z, axis: 'z', roadCls: lineClass(tl.z) })
    crosswalks.push({ x: tl.x + hwX + 2.2, z: tl.z, axis: 'z', roadCls: lineClass(tl.z) })
  }

  /* ---------------- POIs ---------------- */
  pois.push(
    {
      id: 'poi-park', x: -55, z: -345, radius: 60, title: 'Central Park', category: 'Green Infrastructure',
      description: 'A 200×200 m park directly north of downtown. Its central location and surrounding paths support nearby trips on foot, though actual walking distance depends on entrances and crossings. Citywide distance figures are straight-line estimates.',
      facts: [['Size', '200 × 200 m (4 ha)'], ['Features', 'Pond, playground, lawns, pavilion'], ['Nearby', 'Downtown + Parkside'], ['Access', 'Paths and tram stops at two edges']],
    },
    {
      id: 'poi-plaza', x: 50, z: -50, radius: 45, title: 'Solheim Square & Interchange', category: 'Transport / Public Space',
      description: 'The heart of the proposed district: a fountain and clock landmark, shaded garden seating, market kiosks and a café terrace facing the square. Open walking routes connect these meeting places to the surrounding streets. B1 buses board at the interchange across the northern street, with T1 on the neighbouring avenue. This illustrates a more inviting transit centre; it does not predict how people will travel.',
      facts: [['Transit', 'B1 City Loop; walk to T1'], ['Square', 'Fountain, clock landmark and shaded garden'], ['Street life', 'Market kiosks + a café terrace'], ['Access', 'Open walking routes around the fountain']],
    },
    {
      id: 'poi-skylink', x: 149, z: -148, radius: 50, title: 'Skylink Towers', category: 'Landmark / Density Done Right',
      description: 'A proposed mixed-use landmark near the central transit hub. The modeled towers and podium represent an infill option that could put offices and services near transit. Proximity alone cannot guarantee low car use; service frequency, affordability and access from outer neighbourhoods also matter.',
      facts: [['Towers', '101 m + 74 m, bridged at 56 m'], ['Public', 'Lobby + panoramic lift + sky deck at 79 m'], ['Employment', 'Illustrative capacity, not a forecast'], ['Transit', 'Tram T1/T2 + B1 one block west']],
    },
    {
      id: 'poi-market', x: -52, z: -50, radius: 35, title: 'Market Hall', category: 'Essential Services',
      description: 'A central market hall concept for fresh food and daily goods. Adding convenient local services can reduce the need for some longer errands, though the scene does not guarantee store availability or car-free shopping for every household.',
      facts: [['Enterable', 'Yes — walk in (E)'], ['Jobs', 'Illustrative estimate'], ['Nearby', 'Downtown and adjacent districts']],
    },
    {
      id: 'poi-hospital', x: 250, z: -40, radius: 55, title: 'City Hospital', category: 'Essential Services',
      description: 'The hospital sits beside arterial z=0 and tram T2, giving staff, visitors and emergency services more than one modeled access option. Its position is a land-use concept, not an emergency response plan.',
      facts: [['Access', 'Tram T2 "Hospital" stop'], ['Emergency', 'Direct arterial + ring access'], ['Roof', 'Helipad']],
    },
    {
      id: 'poi-fire', x: -252, z: 148, radius: 40, title: 'Fire Station 2', category: 'Essential Services',
      description: 'A fire station site beside a collector, illustrating how emergency facilities can connect to the street network. Detailed coverage planning would pair station locations with local operational and traffic data.',
      facts: [['Vehicles', 'Illustrative engines + ladder'], ['Access', 'Collector street connection']],
    },
    {
      id: 'poi-fire1', x: 330, z: -40, radius: 45, title: 'Fire Station 1 — East Battalion', category: 'Essential Services',
      description: 'A second emergency-service site beside arterial z=0 and near the hospital. Together the two sites illustrate possible locations to evaluate in a citywide service plan.',
      facts: [['Responds with', 'Engine + ambulance'], ['Access', 'Arterial z=0, westbound lane'], ['Bays', '3 drive-through doors']],
    },
    {
      id: 'poi-police', x: 252, z: 52, radius: 40, title: 'Police HQ', category: 'Essential Services',
      description: 'A police HQ site east of downtown with access to the arterial and collector street network. The layout alone does not establish response coverage.',
      facts: [['Access', 'Arterial z=0 + collector x=200']],
    },
    {
      id: 'poi-school-maple', x: -252, z: -266, radius: 45, title: 'Maple Elementary', category: 'Education',
      description: 'A neighborhood school site with nearby local streets. Safe crossings, supervised routes and school travel planning would help families choose walking or cycling; the model cannot assume that school trips generate no car traffic.',
      facts: [['Distance', 'Straight-line indicator, not a route'], ['Proposal', 'Traffic-calmed school approaches'], ['Yard', 'Sports pitch, public after hours']],
    },
    {
      id: 'poi-school-northgate', x: 252, z: -266, radius: 45, title: 'Northgate Elementary', category: 'Education',
      description: 'A school site inside the Northgate neighborhood. A walking bus, safer crossings and traffic-calmed streets are possible supporting measures; they would need to be planned with families and local operators.',
      facts: [['Distance', 'Straight-line indicator, not a route'], ['Proposal', 'Walking bus and safer crossings']],
    },
    {
      id: 'poi-school-greenfield', x: -252, z: 338, radius: 45, title: 'Greenfield Elementary', category: 'Education',
      description: 'South quadrant elementary school. Note the pocket park one block away — school + park + homes form a walkable "neighborhood unit".',
      facts: [['Distance', 'Straight-line indicator, not a route']],
    },
    {
      id: 'poi-library', x: 150, z: -240, radius: 42, title: 'City Library', category: 'Education / Third Places',
      description: 'A library concept between Central Park, the Northgate school and the tram avenue. A nearby public destination adds another local option for study, events and community use. Its actual catchment depends on opening hours and the street network.',
      facts: [['Enterable', 'Yes — reading hall (E)'], ['Nearby', 'Park and Northgate school'], ['Transit', 'T1 Central Park stop nearby'], ['Access', 'Public service concept']],
    },
    {
      id: 'poi-clinic', x: 352, z: -244, radius: 40, title: 'Northgate Walk-in Clinic', category: 'Essential Services',
      description: 'A small clinic concept in the NE neighborhood for everyday care. A local option may shorten some trips, but service availability and travel choices depend on staffing, opening hours and actual route connections.',
      facts: [['Enterable', 'Yes — waiting room (E)'], ['Neighbors', 'Pocket park + Northgate Elementary'], ['Role', 'Non-urgent care, vaccines, check-ups'], ['Hospital', 'City Hospital is on tram T2']],
    },
    {
      id: 'poi-industrial', x: 420, z: 420, radius: 80, title: 'Ironworks — Industrial District', category: 'Economy',
      description: 'Industry is placed in the SE corner with modeled rail and arterial connections. A detailed freight plan would still be needed to route trucks and manage noise, air quality and impacts on nearby streets.',
      facts: [['Jobs', '≈350'], ['Freight', 'Rail siding + truck route'], ['Buffer', 'Tree belt + no homes adjacent']],
    },
    {
      id: 'poi-sports', x: -50, z: 350, radius: 50, title: 'Southfield Sports Park', category: 'Green Infrastructure',
      description: 'Playing fields for schools and clubs. Bigger sports needs are served by one dedicated park per quadrant rather than huge distances to a single stadium.',
      facts: [['Fields', 'Football + multi-use court'], ['Shared', 'Schools by day, clubs evenings']],
    },
    {
      id: 'poi-garden', x: 250, z: 250, radius: 45, title: 'Community Gardens', category: 'Green Infrastructure',
      description: 'Allotment gardens run by residents. Small green spaces woven INTO neighborhoods create social ties — a key ingredient of subjective wellbeing that big parks alone cannot provide.',
      facts: [['Plots', '36 allotments'], ['Managed by', 'Residents’ association']],
    },
    {
      id: 'poi-pedstreet', x: 0, z: 100, radius: 55, title: 'Car-free Shopping Street', category: 'Walkability',
      description: 'The modeled car-free street through downtown uses bollards, trees and benches. This proposal prioritizes pedestrian access while retaining scheduled delivery access; outcomes for local businesses would depend on implementation and access arrangements.',
      facts: [['Length', '400 m'], ['Access', 'Pedestrians + delivery before 9 am'], ['Shops', '≈24 ground-floor units']],
    },
    {
      id: 'poi-north-transfer', x: 325, z: -580, radius: 30, title: 'Northgate Ring Transfer Point', category: 'Mobility Pilot',
      description: 'A proposed neighborhood transfer point beside the existing B2 ring stop. The compact canopy, seating, bicycle hoops and route marker are intended to make transfers to outer-neighborhood bus routes more comfortable. A timed connection and reliable service would need to be agreed with the wider network operator.',
      facts: [['Existing service', 'B2 ring bus stop nearby'], ['Proposal', 'Shelter, seating, cycle parking, wayfinding'], ['Future option', 'Test accessible drop-off or car-share bay if curb space allows']],
    },
    {
      id: 'poi-cycle-network', x: -585, z: -25, radius: 30, title: 'West Ring Safe Routes Link', category: 'Active Travel Proposal',
      description: 'This edge point marks a proposed safe-route connection from the ring stop into Westbrook. Continuous protected cycling links, safe arterial crossings and clear wayfinding would connect outer neighbourhoods to local services and transit.',
      facts: [['Connection', 'B2 West Terminal to local streets'], ['Priority', 'Protected links and safer crossings'], ['Measure', 'Check continuity and access in detailed design']],
    },
    {
      id: 'poi-east-infill', x: 585, z: 21, radius: 34, title: 'Eastgate Local Services Infill', category: 'Neighbourhood Planning',
      description: 'A suggested infill area near the East Terminal bus stop for small shops, daily services or flexible community space. Locating useful destinations near an existing route could shorten some errands and support car-independent options while retaining access for residents who still need to drive.',
      facts: [['Nearby service', 'B2 East Terminal'], ['Concept', 'Small-scale mixed-use infill'], ['Next step', 'Test demand, access, servicing and affordability']],
    },
  )

  /* ---------------- statistics (computed, not faked) ---------------- */
  const stats = computeStats(buildings, parks, stops, roads, schools)

  return {
    bounds: CITY.half,
    blocks,
    roads,
    buildings,
    parks,
    colliders,
    pois,
    stops,
    routes,
    trafficLights,
    crosswalks,
    enterables,
    stats,
    spawn: { x: 50, z: -20 },
    minimapSeeds: pois.map((p) => ({ x: p.x, z: p.z, color: '#f59e0b' })),
  }
}

function computeStats(
  buildings: BuildingSpec[],
  parks: ParkSpec[],
  stops: TransitStop[],
  roads: RoadSpec[],
  schools: [number, number, string][],
): CityStats {
  // Proximity outputs are Euclidean estimates from point locations, not
  // route distances, travel times, or measured walking catchments.
  let units = 0
  let jobs = 0
  const residentialCenters: { x: number; z: number; units: number }[] = []
  for (const b of buildings) {
    units += b.units
    jobs += Math.round(b.jobs)
    if (b.units > 0) residentialCenters.push({ x: b.x, z: b.z, units: b.units })
  }
  const population = Math.round(units * 1.85 / 10) * 10

  let greenArea = 0
  for (const p of parks) {
    // park blocks are full 100 m blocks minus surrounding street halves ≈ 93×93
    const w = Math.min(200, p.x1 - p.x0) - (p.kind === 'central-park' ? 14 : 12)
    const d = Math.min(200, p.z1 - p.z0) - (p.kind === 'central-park' ? 14 : 12)
    greenArea += w * d
  }

  let parkDistSum = 0
  let transitDistSum = 0
  let in300Park = 0
  let in400Transit = 0
  let in500School = 0
  let unitWeight = 0
  for (const r of residentialCenters) {
    let minPark = Infinity
    for (const p of parks) minPark = Math.min(minPark, distToRect(r.x, r.z, p.x0, p.z0, p.x1, p.z1))
    let minStop = Infinity
    for (const s of stops) minStop = Math.min(minStop, Math.hypot(s.x - r.x, s.z - r.z))
    let minSchool = Infinity
    for (const [sx, sz] of schools) minSchool = Math.min(minSchool, Math.hypot(sx - r.x, sz - r.z))
    parkDistSum += minPark * r.units
    transitDistSum += minStop * r.units
    unitWeight += r.units
    if (minPark <= 300) in300Park += r.units
    if (minStop <= 400) in400Transit += r.units
    if (minSchool <= 500) in500School += r.units
  }
  const wUnit = Math.max(1, unitWeight)

  const roadLen: Record<string, number> = { arterial: 0, collector: 0, local: 0 }
  let pedStreetLen = 0
  for (const r of roads) {
    const len = (r.to - r.from) / 1000
    if (r.pedestrianOnly) { pedStreetLen += len; continue }
    roadLen[r.cls] += len
  }
  const totalRoad = roadLen.arterial + roadLen.collector + roadLen.local
  const bikeKm = (roadLen.arterial + roadLen.collector) * 2 // both sides painted

  const areaKm2 = 1.44
  const density = population / areaKm2
  // modal share estimate driven by measured access metrics
  const transitAccess = in400Transit / wUnit
  const walkAccess = in300Park / wUnit
  const carShare = Math.max(8, Math.round(24 - transitAccess * 10 - density / 900))
  const transitShare = Math.round(16 + transitAccess * 12)
  const walkShare = Math.round(30 + walkAccess * 6)
  const bikeShare = Math.max(10, 100 - carShare - transitShare - walkShare)

  return {
    population,
    buildings: buildings.length,
    residentialUnits: units,
    jobs,
    greenAreaM2: Math.round(greenArea),
    greenPercent: +((greenArea / 1_440_000) * 100).toFixed(1),
    avgDistanceToParkM: Math.round(parkDistSum / wUnit),
    avgDistanceToTransitM: Math.round(transitDistSum / wUnit),
    residentsWithin300mPark: +(in300Park / wUnit).toFixed(2),
    residentsWithin400mTransit: +(in400Transit / wUnit).toFixed(2),
    residentsWithin500mSchool: +(in500School / wUnit).toFixed(2),
    roadLengthKm: {
      arterial: +roadLen.arterial.toFixed(1),
      collector: +roadLen.collector.toFixed(1),
      local: +roadLen.local.toFixed(1),
      total: +totalRoad.toFixed(1),
    },
    bikeLaneKm: +bikeKm.toFixed(1),
    sidewalkKm: +(totalRoad * 2).toFixed(1),
    transitStops: stops.length,
    tramStops: stops.filter((s) => s.mode === 'tram').length,
    busRoutes: 3,
    dailyTripsByMode: { walk: walkShare, bike: bikeShare, transit: transitShare, car: carShare },
    areaKm2,
    densityPerKm2: Math.round(density),
  }
}
