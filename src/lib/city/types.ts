import * as THREE from 'three'
import type { TrafficConfig, TrafficMetrics } from './traffic-config'

/* ============================================================
 * SOLHEIM — shared types. This file is the pinned contract
 * between all city modules. Do not rename exported symbols.
 * ============================================================ */

export type RoadClass = 'arterial' | 'collector' | 'local'

/** A straight street segment along the grid (axis aligned). */
export interface RoadSpec {
  id: string
  axis: 'x' | 'z' // 'x' → road runs along X (east-west), constant z; 'z' → runs along Z
  coord: number // the constant coordinate of the centerline
  from: number // start of segment along its axis
  to: number
  cls: RoadClass
  pedestrianOnly?: boolean // car-free shopping street
  transitOnly?: boolean // terminal drive, excluded from private car lane graph
}

export type ZoneKind =
  | 'downtown'
  | 'mixed'
  | 'residential-medium'
  | 'residential-low'
  | 'commercial'
  | 'industrial'
  | 'civic'
  | 'park'
  | 'plaza'
  | 'special'

/** A city block (between 4 streets). */
export interface Block {
  bi: number
  bj: number
  x0: number
  z0: number
  x1: number
  z1: number
  cx: number
  cz: number
  zone: ZoneKind
  district: string
}

export type BuildingKind =
  | 'residential'
  | 'apartment'
  | 'mixed'
  | 'office'
  | 'retail'
  | 'industrial'
  | 'school'
  | 'hospital'
  | 'fire'
  | 'police'
  | 'transit-hub'
  | 'market'
  | 'utility'
  | 'depot'
  | 'library'
  | 'clinic'
  | 'twinTowers'

export type Facing = 0 | 90 | 180 | 270 // degrees, direction the entrance faces (0 = +Z south, 90 = +X east)

export interface BuildingSpec {
  id: string
  kind: BuildingKind
  x: number // center x
  z: number // center z
  w: number // width along x (before rotation)
  d: number // depth along z (before rotation)
  rotation: Facing
  floors: number
  height: number
  facadeVariant: number // index into facade palette
  units: number // residential units (0 for non-residential)
  jobs: number // estimated jobs
  enterableId?: string // interior id if enterable
  label?: string // sign text for special buildings
}

/** Axis-aligned collision box (y from 0 to h). */
export interface AABB {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  h: number
}

export interface ParkSpec {
  id: string
  kind: 'central-park' | 'pocket-park' | 'plaza' | 'sports' | 'garden' | 'green'
  x0: number
  z0: number
  x1: number
  z1: number
  name: string
}

export interface TransitStop {
  id: string
  x: number
  z: number
  mode: 'tram' | 'bus'
  name: string
  routeIds: string[]
}

export interface TransitRoute {
  id: string
  mode: 'tram' | 'bus'
  name: string
  color: string
  points: { x: number; z: number }[] // loop (first point == last point for closed loops)
  stopIds: string[]
}

export interface POI {
  id: string
  x: number
  z: number
  radius: number
  title: string
  category: string
  /** Short planning rationale shown in info panel. */
  description: string
  /** Key facts as [label, value] pairs. */
  facts: [string, string][]
}

export interface TrafficLightSpec {
  id: string
  x: number
  z: number
  /** Which road has green in phase 0. */
  phase0Axis: 'x' | 'z'
}

export interface CrosswalkSpec {
  x: number
  z: number
  axis: 'x' | 'z' // crossing direction of the pedestrian (walks along axis, road runs perpendicular)
  roadCls: RoadClass
}

export interface EnterableSpec {
  id: string
  buildingId: string
  name: string
  interiorKind: 'market' | 'cafe' | 'grocery' | 'hub' | 'office' | 'apartment' | 'library' | 'clinic' | 'skylink'
  doorX: number
  doorZ: number
  facing: Facing
  // interior shell size
  w: number
  d: number
  h: number
}

export interface CityStats {
  population: number
  buildings: number
  residentialUnits: number
  jobs: number
  greenAreaM2: number
  greenPercent: number
  avgDistanceToParkM: number
  avgDistanceToTransitM: number
  residentsWithin300mPark: number // 0..1
  residentsWithin400mTransit: number // 0..1
  residentsWithin500mSchool: number // 0..1
  roadLengthKm: { arterial: number; collector: number; local: number; total: number }
  bikeLaneKm: number
  sidewalkKm: number
  transitStops: number
  tramStops: number
  busRoutes: number
  dailyTripsByMode: { walk: number; bike: number; transit: number; car: number } // modal share estimate
  areaKm2: number
  densityPerKm2: number
}

export interface CityPlan {
  bounds: number // half-size (600)
  blocks: Block[]
  roads: RoadSpec[]
  buildings: BuildingSpec[]
  parks: ParkSpec[]
  colliders: AABB[] // static building colliders (world AABB after rotation)
  pois: POI[]
  stops: TransitStop[]
  routes: TransitRoute[]
  trafficLights: TrafficLightSpec[]
  crosswalks: CrosswalkSpec[]
  enterables: EnterableSpec[]
  stats: CityStats
  spawn: { x: number; z: number }
  minimapSeeds: { x: number; z: number; color: string }[] // extra dots for minimap
}

/* ---------------- Roads / traffic interfaces ---------------- */

export interface LaneSeg {
  id: string
  x1: number
  z1: number
  x2: number
  z2: number
  cls: RoadClass
  speed: number // m/s
  next: string[] // ids of lane segs reachable at the downstream end
  signalId?: string
  /** Final destinations selected before entering a dedicated turn pocket. */
  routeChoices?: string[]
  pocket?: 'left' | 'through-right'
  approachLane?: string
  laneWidth?: number
}

export interface SidewalkSeg {
  id: string
  x1: number
  z1: number
  x2: number
  z2: number
  cls: RoadClass
  next: string[]
}

export interface CrosswalkSeg {
  id: string
  x: number
  z: number
  axis: 'x' | 'z'
  width: number // length of the crossing (road width)
  /** sidewalk seg ids it connects */
  a: string
  b: string
  /** road lanes crossing here (for yielding) */
  laneIds: string[]
  signalId?: string
}

export interface SignalPhase {
  greenAxis: 'x' | 'z'
  duration: number
  movement?: 'through' | 'left'
}

export interface SignalGroup {
  id: string
  x: number
  z: number
  phases: SignalPhase[]
  /** head positions for rendering: {x,z,axis} */
  heads: { x: number; z: number; axis: 'x' | 'z'; dir: 1 | -1 }[]
}

/** A short path (straight or arc) that carries a vehicle across an
 *  intersection from the end of one lane piece to the start of the next. */
export interface ConnPath {
  pts: { x: number; z: number }[]
  cum: number[]
  len: number
  /** true when end and start are collinear (straight through-movement) */
  straight: boolean
  /** Lane split upstream of a junction; excluded from junction throughput. */
  internal?: boolean
}

export interface RoadNetworkData {
  lanes: Map<string, LaneSeg>
  sidewalks: Map<string, SidewalkSeg>
  crosswalks: CrosswalkSeg[]
  signals: SignalGroup[]
  /** key `${fromLaneId}>${toLaneId}` → path across the intersection */
  connectors: Map<string, ConnPath>
}

/* ---------------- Materials contract (pinned!) ---------------- */

export interface FacadeMaterial {
  material: THREE.MeshStandardMaterial // map + emissiveMap for windows
  roof: THREE.MeshStandardMaterial
  trim: THREE.MeshStandardMaterial
  /** true if ground floor should be rendered as retail storefront */
  storefront: boolean
  style: 'modern' | 'brick' | 'classic' | 'industrial' | 'glass'
}

export interface CityMaterials {
  // ground / roads
  asphalt: THREE.MeshStandardMaterial
  asphaltRough: THREE.MeshStandardMaterial
  roadLine: THREE.MeshBasicMaterial // white
  roadLineYellow: THREE.MeshBasicMaterial
  crosswalk: THREE.MeshBasicMaterial
  bikeLane: THREE.MeshBasicMaterial
  sidewalk: THREE.MeshStandardMaterial
  curb: THREE.MeshStandardMaterial
  tramTrack: THREE.MeshStandardMaterial
  gravel: THREE.MeshStandardMaterial
  plaza: THREE.MeshStandardMaterial
  court: THREE.MeshStandardMaterial // downtown block-court paving (large concrete panels)
  // nature
  grass: THREE.MeshStandardMaterial
  grassDark: THREE.MeshStandardMaterial
  parkPath: THREE.MeshStandardMaterial
  water: THREE.MeshStandardMaterial
  trunk: THREE.MeshStandardMaterial
  foliage: THREE.MeshStandardMaterial
  foliageDark: THREE.MeshStandardMaterial
  planter: THREE.MeshStandardMaterial
  // buildings
  facades: FacadeMaterial[]
  glassTower: THREE.MeshStandardMaterial
  roofCommon: THREE.MeshStandardMaterial
  metal: THREE.MeshStandardMaterial
  metalDark: THREE.MeshStandardMaterial
  concrete: THREE.MeshStandardMaterial
  concreteLight: THREE.MeshStandardMaterial
  brickRed: THREE.MeshStandardMaterial
  wood: THREE.MeshStandardMaterial
  // props
  white: THREE.MeshStandardMaterial
  black: THREE.MeshStandardMaterial
  poleMetal: THREE.MeshStandardMaterial
  streetlightHead: THREE.MeshStandardMaterial // emissive toggled at night
  neonRed: THREE.MeshStandardMaterial
  neonGreen: THREE.MeshStandardMaterial
  neonAmber: THREE.MeshBasicMaterial
  fabricRed: THREE.MeshStandardMaterial
  fabricGreen: THREE.MeshStandardMaterial
  fabricOrange: THREE.MeshStandardMaterial
  // vehicles
  carPaints: THREE.MeshStandardMaterial[]
  glassDark: THREE.MeshStandardMaterial
  tire: THREE.MeshStandardMaterial
  headlight: THREE.MeshBasicMaterial
  taillight: THREE.MeshBasicMaterial
  // helpers
  /** cached canvas text texture → material (for signs) */
  signMaterial(text: string, opts?: { bg?: string; fg?: string; w?: number; h?: number }): THREE.MeshBasicMaterial
  /** custom per-archetype facade material for special buildings (hospital, school, …) */
  specialFacade(kind: string): THREE.MeshStandardMaterial
  /** wide painted entrance frieze (icon + lettering) for a special building kind */
  muralMaterial(text: string, kind: string): THREE.MeshBasicMaterial
}

/* ---------------- Engine ↔ React bridge ---------------- */

export interface NearbyInteraction {
  kind: 'poi' | 'door'
  id: string
  title: string
  action: string // e.g. "Inspect" / "Enter"
}

export interface EngineState {
  ready: boolean
  started: boolean
  paused: boolean
  clock: number // hours 0..24
  fps: number
  graphicsMode: import('./render-quality').QualityMode
  graphicsLevel: import('./render-quality').QualityLevel
  renderStats: { calls: number; triangles: number; pixelRatio: number }
  px: number
  pz: number
  heading: number // radians
  insideId: string | null
  insideName: string | null
  nearby: NearbyInteraction | null
  activePoi: POI | null
  showStats: boolean
  showTrafficLab: boolean
  trafficConfig: TrafficConfig
  trafficMetrics: TrafficMetrics
  trafficPaused: boolean
  trafficSpeed: 1 | 2 | 4
  trafficView: 'street' | 'junction' | 'district'
  toast: string | null
  fade: boolean
  loadingProgress: number // 0..1
  tour: TourState | null
  classroomMode: boolean // stable daylight, no weather or random incidents
  muted: boolean // ambient audio muted (M / HUD button)
}

export interface TourState {
  idx: number
  total: number
  title: string
  body: string
  facts: [string, string][]
}

export type EngineEvent =
  | { type: 'state' }
  | { type: 'toast'; message: string }
  | { type: 'poi'; poi: POI | null }
  | { type: 'stats'; open: boolean }
