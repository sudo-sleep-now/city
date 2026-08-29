import type { RoadClass } from './types'

/* ============================================================
 * SOLHEIM — global configuration & dimensions
 * ============================================================ */

export const CITY = {
  /** half-extent of the city in meters */
  half: 600,
  /** grid pitch (distance between street centerlines) */
  pitch: 100,
  /** number of blocks per axis */
  blocks: 12,
}

export const ROAD_WIDTH: Record<RoadClass, number> = {
  arterial: 16, // 4 lanes (2+2) + median tram on tram streets
  collector: 11, // 2 lanes + 2 bike lanes
  local: 7, // 2 narrow lanes, traffic-calmed
}

export const LANE_OFFSET = 2.4 // lane center offset from road centerline
export const SIDEWALK_WIDTH = { arterial: 5, collector: 4, local: 3.5 }
export const SIDEWALK_HEIGHT = 0.14
export const BIKE_LANE_WIDTH = 1.6

export const SPEED_LIMIT: Record<RoadClass, number> = {
  arterial: 13.9, // 50 km/h
  collector: 11.1, // 40 km/h
  local: 5.6, // 20 km/h — traffic calming
}

/** Grid line coordinates: -600..600 step 100 */
export const GRID_LINES: number[] = Array.from({ length: 13 }, (_, i) => -600 + i * 100)

/** Street classification per grid coordinate (same for x and z). */
export function lineClass(coord: number): RoadClass {
  const c = Math.abs(coord)
  if (c === 400 || c === 0) return 'arterial'
  if (c === 600 || c === 200) return 'collector'
  return 'local'
}

/** Facade variant count — buildings.ts creates one material per variant */
export const FACADE_VARIANTS = 10

/** Day/night */
export const DAY_LENGTH_SEC = 480 // 8 real minutes = 24h
export const START_HOUR = 9.5

/** Simulation budgets */
export const MAX_CARS = 48
export const MAX_BUSES = 6
export const MAX_TRAMS = 4
export const MAX_PEDESTRIANS = 70
export const MAX_CYCLISTS = 14

/** Service yards with steel dumpsters — the garbage truck stops here.
 *  Spots sit ~6–11 m from a traffic lane (curbside collection) and are the
 *  single source of truth shared by environment.ts (props) and traffic.ts. */
export const GARBAGE_SPOTS: [number, number, number][] = [
  [-92, -40, 0],
  [352, 388, 0],
  [452, 312, 0],
  [-268, -208, Math.PI / 2],
  [86, -90, Math.PI],
  [258, 212, 0],
]

/** Player physics */
export const PLAYER = {
  height: 1.7,
  crouchHeight: 1.1,
  eyeOffset: 0.12,
  radius: 0.38,
  walkSpeed: 4.3,
  sprintSpeed: 8.6,
  crouchSpeed: 1.9,
  jumpVel: 6.4,
  gravity: 20,
}

/** Colors (minimap + UI) — sustainable green theme, no blue/indigo in UI */
export const UI_COLORS = {
  primary: '#10b981',
  primaryDark: '#047857',
  amber: '#f59e0b',
  residential: '#d9a05b',
  commercial: '#e8b64c',
  downtown: '#c2703e',
  industrial: '#8d8d93',
  civic: '#b56576',
  park: '#5fae5f',
  plaza: '#c9b458',
  road: '#4a4a4f',
  roadArterial: '#57575e',
  tram: '#c2410c',
  bus: '#a16207',
}
