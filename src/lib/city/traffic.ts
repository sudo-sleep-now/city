import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GARBAGE_SPOTS, MAX_BUSES, MAX_TRAMS } from './constants'
import { MAX_TRAFFIC_VEHICLES, MIN_TRAFFIC_VEHICLES, TRAFFIC_PRESETS, type TrafficConfig, type TrafficMetrics } from './traffic-config'
import { canvas, tex } from './materials'
import { TrafficRouter } from './traffic-routing'
import { headlampAnchors, type HeadlampEmitter } from './vehicle-lights'
import type { CityMaterials, CityPlan, ConnPath, LaneSeg, RoadNetworkData, SignalGroup } from './types'

/* ============================================================
 * TrafficSystem — signalized intersections, realistic multi-part
 * cars / taxis / vans / trucks on the lane graph, city buses with
 * procedural canvas liveries on loops, trams on rails.
 *
 * Vehicles are built like the buildings: several small primitives
 * (body, hood, greenhouse, bumpers, wheels, lamps) merged into one
 * geometry per material group, then drawn as InstancedMeshes.
 * ============================================================ */

/* ---------------- procedural vehicle geometry helpers ---------------- */

const vBox = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d)
  if (rx) g.rotateX(rx)
  g.translate(x, y, z)
  return g
}
const vCyl = (r: number, h: number, x: number, y: number, z: number, seg = 10, rotZ = Math.PI / 2): THREE.BufferGeometry => {
  const g = new THREE.CylinderGeometry(r, r, h, seg)
  if (rotZ) g.rotateZ(rotZ)
  g.translate(x, y, z)
  return g
}

interface VehicleGroups {
  paint: THREE.BufferGeometry[]
  glass: THREE.BufferGeometry[]
  dark: THREE.BufferGeometry[]
  chrome: THREE.BufferGeometry[]
  lampF: THREE.BufferGeometry[]
  lampR: THREE.BufferGeometry[]
  /** centered wheel geometries + their local offsets — spun per instance each frame */
  tire: THREE.BufferGeometry[]
  hub: THREE.BufferGeometry[]
  wheelOffsets: { x: number; z: number; r: number }[]
}
const newGroups = (): VehicleGroups => ({ paint: [], glass: [], dark: [], chrome: [], lampF: [], lampR: [], tire: [], hub: [], wheelOffsets: [] })

const addWheels = (g: VehicleGroups, xs: number[], zs: number[], r: number) => {
  for (const z of zs) {
    for (const x of xs) {
      g.wheelOffsets.push({ x, z, r })
      g.tire.push(vCyl(r, 0.26, 0, 0, 0, 12))
      g.hub.push(vCyl(r * 0.55, 0.28, 0, 0, 0, 8))
    }
  }
}
/** lamps HALF-EMBEDDED in the body face so they never float */
const addLamps = (g: VehicleGroups, W: number, zF: number, zR: number, yF: number, yR: number) => {
  for (const sx of [-1, 1]) {
    g.lampF.push(vBox(0.3, 0.13, 0.09, sx * W * 0.31, yF, zF - 0.02))
    g.lampR.push(vBox(0.3, 0.12, 0.09, sx * W * 0.31, yR, zR + 0.02))
  }
}
const addBumpers = (g: VehicleGroups, W: number, L: number, y: number, zF: number, zR: number) => {
  g.dark.push(vBox(W * 1.02, 0.18, 0.24, 0, y, zF))
  g.dark.push(vBox(W * 1.02, 0.18, 0.24, 0, y, zR))
}

/** sedan: lower body + hood + trunk, glassed greenhouse, bumpers, grille */
function buildSedanGroups(): VehicleGroups {
  const L = 4.5
  const W = 1.8
  const g = newGroups()
  g.paint.push(
    vBox(W, 0.5, L, 0, 0.64, 0),
    vBox(W * 0.94, 0.14, L * 0.25, 0, 0.915, L * 0.28, -0.05), // hood
    vBox(W * 0.94, 0.14, L * 0.2, 0, 0.9, -L * 0.32, 0.06), // trunk lid
    vBox(W * 0.8, 0.08, L * 0.36, 0, 1.38, -L * 0.05), // roof
  )
  g.glass.push(
    vBox(W * 0.83, 0.44, L * 0.42, 0, 1.12, -L * 0.05), // greenhouse
    vBox(W * 0.76, 0.46, 0.07, 0, 1.06, L * 0.19, -0.5), // windshield
    vBox(W * 0.76, 0.42, 0.07, 0, 1.07, -L * 0.26, 0.55), // rear glass
  )
  addBumpers(g, W, L, 0.46, L / 2 - 0.02, -L / 2 + 0.02)
  g.dark.push(vBox(W * 0.42, 0.16, 0.06, 0, 0.67, L / 2 + 0.01)) // grille
  addWheels(g, [-(W / 2 - 0.02), W / 2 - 0.02], [L * 0.31, -L * 0.31], 0.34)
  addLamps(g, W, L / 2, -L / 2, 0.72, 0.76)
  return g
}

/** delivery van: tall body + high roof, big windshield, side glass band */
function buildVanGroups(): VehicleGroups {
  const L = 5.3
  const W = 2.02
  const g = newGroups()
  g.paint.push(
    vBox(W, 1.4, L * 0.98, 0, 1.07, 0),
    vBox(W * 0.98, 0.75, L * 0.88, 0, 1.98, -L * 0.05), // high roof
    vBox(W * 0.92, 0.5, L * 0.14, 0, 0.82, L * 0.45), // nose
  )
  g.glass.push(
    vBox(W * 0.88, 0.62, 0.08, 0, 1.5, L * 0.44, -0.3), // windshield
    vBox(W * 1.005, 0.52, L * 0.24, 0, 1.68, L * 0.12), // side windows
    vBox(W * 0.82, 0.5, 0.07, 0, 1.85, -L / 2 - 0.02), // rear door glass
  )
  addBumpers(g, W, L, 0.45, L * 0.52, -L / 2 + 0.02)
  g.dark.push(vBox(W * 0.4, 0.18, 0.06, 0, 0.72, L * 0.52 + 0.01)) // grille
  addWheels(g, [-(W / 2 - 0.02), W / 2 - 0.02], [L * 0.32, -L * 0.3], 0.38)
  // lamps sit ON the nose face (nose front at L*0.45 + L*0.07) and the rear door
  addLamps(g, W, L * 0.52, -L / 2, 0.75, 0.78)
  return g
}

/** box truck: cab + roof deflector + chassis, fuel tanks, exhaust, 6 wheels */
function buildTruckGroups(): VehicleGroups {
  const L = 7.6
  const W = 2.45
  const g = newGroups()
  g.paint.push(
    vBox(W, 1.55, 2.1, 0, 1.62, L / 2 - 1.15), // cab
    vBox(W * 0.96, 0.5, 1.0, 0, 2.58, L / 2 - 1.35, 0.32), // roof deflector
    vBox(W * 0.9, 0.35, 2.3, 0, 0.55, L / 2 - 1.2), // chassis
  )
  g.glass.push(
    vBox(W * 0.88, 0.72, 0.08, 0, 1.95, L / 2 - 0.18, -0.22), // windshield
    vBox(W * 1.005, 0.58, 1.5, 0, 2.0, L / 2 - 1.2), // cab side windows
  )
  g.dark.push(
    vBox(W * 1.0, 0.22, 0.26, 0, 0.5, L / 2 - 0.02),
    vBox(W * 0.42, 0.2, 0.07, 0, 0.78, L / 2 + 0.01),
    vBox(0.28, 0.55, 1.0, W * 0.34, 0.6, L / 2 - 2.1), // fuel tank
    vBox(0.28, 0.55, 1.0, -W * 0.34, 0.6, L / 2 - 2.1),
    vCyl(0.09, 1.7, W / 2 - 0.12, 2.6, L / 2 - 2.25, 8, 0), // exhaust stack
  )
  addWheels(g, [-(W / 2 - 0.04), W / 2 - 0.04], [L * 0.33, -L * 0.16, -L * 0.3], 0.46)
  // lamps ON the cab face (cab front at L/2 − 1.15 + 1.05) — never floating
  addLamps(g, W, L / 2 - 0.1, -L / 2 + 0.1, 1.05, 1.05)
  return g
}

/** garbage truck: cab + packed body + hopper + trough, amber beacon */
function buildGarbageTruckGroups(): VehicleGroups {
  const L = 8.2
  const W = 2.5
  const g = newGroups()
  g.paint.push(
    vBox(W, 1.6, 1.9, 0, 1.6, L / 2 - 1.05), // cab
    vBox(W * 0.94, 0.4, 0.9, 0, 2.5, L / 2 - 1.2, 0.3), // roof deflector
    // The separately textured packer body is added by buildCars. A second
    // identical box here used to fight it on every visible face.
    vBox(W * 0.88, 0.5, 2.0, 0, 1.15, L / 2 - 3.1, 0.35), // hopper trough (sloped)
  )
  g.glass.push(
    vBox(W * 0.86, 0.7, 0.08, 0, 1.92, L / 2 - 0.12, -0.22), // windshield
    vBox(W * 1.005, 0.55, 1.3, 0, 1.95, L / 2 - 1.1), // cab side windows
  )
  g.dark.push(
    vBox(W * 0.98, 0.24, 0.28, 0, 0.5, L / 2 - 0.02),
    vBox(W * 0.42, 0.2, 0.07, 0, 0.72, L / 2 + 0.01),
    vBox(W * 0.96, 0.4, L * 0.54, 0, 0.72, -L * 0.18), // under-chassis packer gear
    vBox(0.26, 0.5, 0.9, W * 0.3, 0.62, L / 2 - 2.6),
    vBox(0.26, 0.5, 0.9, -W * 0.3, 0.62, L / 2 - 2.6),
  )
  g.chrome.push(vCyl(0.07, 0.3, 0, 2.52, L / 2 - 1.35, 8, 0)) // amber beacon base
  addWheels(g, [-(W / 2 - 0.04), W / 2 - 0.04], [L * 0.32, -L * 0.14, -L * 0.3], 0.46)
  addLamps(g, W, L / 2 - 0.1, -L / 2 + 0.12, 1.0, 1.15)
  return g
}

const CAR_BODY_BUILDERS: (() => VehicleGroups)[] = [buildSedanGroups, buildSedanGroups, buildVanGroups, buildTruckGroups, buildGarbageTruckGroups]
const CAR_TYPE_WEIGHTS = [0, 0, 0, 1, 2, 3, 4] // sedan ×3, taxi, van, truck, garbage truck

/** Convert the Blender-authored mesh children into the same small material buckets
 * used by the instanced traffic renderer. Meshes are flattened relative to the
 * named model root, keeping the imported asset out of the scene graph per car. */
function authoredVehicleGroups(model: THREE.Group, wheelOffsets: VehicleGroups['wheelOffsets']): VehicleGroups {
  const groups = newGroups()
  groups.wheelOffsets = wheelOffsets
  const buckets: Record<string, THREE.BufferGeometry[]> = {
    paint: groups.paint, glass: groups.glass, dark: groups.dark,
    chrome: groups.chrome, lampF: groups.lampF, lampR: groups.lampR,
    tire: groups.tire, hub: groups.hub,
  }
  model.updateMatrixWorld(true)
  const inverseRoot = model.matrixWorld.clone().invert()
  model.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const prefix = mesh.name.split('_', 1)[0]
    let target = buckets[prefix]
    // A multi-material GLB mesh loads as a named Group containing primitive
    // meshes. Its material-bucket prefix belongs to that parent group.
    let parent = mesh.parent
    while (!target && parent && parent !== model) {
      target = buckets[parent.name.split('_', 1)[0]]
      parent = parent.parent
    }
    if (!target) return
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(inverseRoot.clone().multiply(mesh.matrixWorld))
    // mergeGeometries requires matching indexed state and attributes.
    const flat = geometry.index ? geometry.toNonIndexed() : geometry
    for (const attr of Object.keys(flat.attributes)) {
      if (!['position', 'normal', 'uv'].includes(attr)) flat.deleteAttribute(attr)
    }
    if (!flat.getAttribute('normal')) flat.computeVertexNormals()
    if (!flat.getAttribute('uv')) {
      flat.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(flat.getAttribute('position').count * 2), 2))
    }
    target.push(flat)
  })
  return groups
}

const cargoSideCanvas = (): HTMLCanvasElement => {
  const [c, ctx] = canvas(256, 128)
  ctx.fillStyle = '#d8d5cc'
  ctx.fillRect(0, 0, 256, 128)
  ctx.fillStyle = '#c4c1b8'
  ctx.fillRect(0, 104, 256, 14)
  ctx.strokeStyle = '#8a877e'
  ctx.lineWidth = 4
  ctx.strokeRect(12, 10, 108, 88)
  ctx.strokeRect(136, 10, 108, 88)
  ctx.fillStyle = '#4a5a50'
  ctx.font = 'bold 17px Arial'
  ctx.fillText('SOLHEIM', 24, 48)
  ctx.fillText('FREIGHT', 148, 48)
  ctx.fillStyle = '#8a877e'
  ctx.fillRect(62, 10, 5, 88)
  ctx.fillRect(186, 10, 5, 88)
  return c
}

interface CarState {
  segId: string
  dist: number // traveled along current seg
  odo: number // lifetime odometer → wheel spin angle
  speed: number
  typeIdx: number
  slot: number
  paint: number
  x: number
  z: number
  heading: number
  stopped: boolean
  /** intersection connector being traversed (null = on a normal piece) */
  conn: ConnPath | null
  connNext: string
  plannedNext: string | null
  afterPocket: string | null
  homeNode: string
  tripTarget: string
  nextTripTarget: string | null
  tripToHome: boolean
  connDist: number
  /** Keep the rear reserved briefly after the centre reaches the exit lane. */
  tail: ConnPath | null
  stuck: number // seconds at ~zero speed
  creep: number // >0 while ignoring right-of-way after a long wait
  jammed: number // accumulated seconds without progress (decays slowly when moving)
  forced: number // >0 while in deadlock-escape mode (lights/box ignored, ≤3 m/s)
  /** garbage truck: dumpster service countdown + cooldown */
  serveT: number
  serveCd: number
  /** Brief hold avoids flicker during tiny speed corrections; held at a stop. */
  brakeHold: number
}

interface BusState {
  routeIdx: number
  dist: number
  speed: number
  dwell: number
  x: number
  z: number
  heading: number
  doorT: number // 0 closed .. 1 open (eased)
  brakeHold: number
}

interface TramState {
  routeIdx: number
  dist: number // along ping-pong path (0..len)
  dir: 1 | -1
  speed: number
  dwell: number
  x: number
  z: number
  heading: number
  odo: number // lifetime odometer → wheel spin
  slot: number // instance slot within its route's mesh set
  doorT: number // 0 closed .. 1 open (eased)
}

interface CarTypeMeshes {
  paint: THREE.InstancedMesh | null
  glass: THREE.InstancedMesh | null
  dark: THREE.InstancedMesh | null
  chrome: THREE.InstancedMesh | null
  lampF: THREE.InstancedMesh | null
  lampR: THREE.InstancedMesh | null
  extra: THREE.InstancedMesh | null
  extra2: THREE.InstancedMesh | null
  wheels: THREE.InstancedMesh | null
  wheelOffsets: { x: number; z: number; r: number }[]
}

interface BusMeshes {
  body: THREE.InstancedMesh
  dark: THREE.InstancedMesh
  wheels: THREE.InstancedMesh
  wheelOffsets: { x: number; z: number; r: number }[]
  lampF: THREE.InstancedMesh
  lampR: THREE.InstancedMesh
  sign: THREE.InstancedMesh
  doorA: THREE.InstancedMesh // curbside door leaves hinged at the front edge
  doorB: THREE.InstancedMesh // leaves hinged at the rear edge
}

export class TrafficSystem {
  group = new THREE.Group()
  private plan: CityPlan
  private network: RoadNetworkData
  private cars: CarState[] = []
  private buses: BusState[] = []
  private trams: TramState[] = []
  private signalState = new Map<string, { phase: number; t: number; elapsed: number; gap: number }>()
  private laneSignals = new Map<string, SignalGroup>()
  private signalMeshes: { lampIM: THREE.InstancedMesh | null; arrowIM: THREE.InstancedMesh; heads: { x: number; y: number; z: number }[] }[] = []
  private laneList: string[] = []
  private busPaths: { pts: { x: number; z: number }[]; cum: number[]; total: number; stopDists: number[]; stopIds: string[] }[] = []
  private tramPaths: { axis: 'x' | 'z'; coord: number; from: number; to: number; len: number; stops: number[] }[] = []
  private carMeshes: CarTypeMeshes[] = []
  private carOwnedMaterials = new Set<THREE.Material>()
  private busMeshes: BusMeshes | null = null
  private busDoorZ: number[] = [4.5, -1.6] // painted door centers along the bus (local z)
  private busW = 2.55
  private playerX = 0
  private playerZ = 0
  private rng = this.makeRng(90210)
  private config: TrafficConfig = { ...TRAFFIC_PRESETS.normal }
  private mats!: CityMaterials
  private models?: Map<string, THREE.Group>
  private simTime = 0
  private completedSegments = 0
  private recoveryRespawns = 0
  private speedIntegral = 0
  private speedWindow: { dt: number; integral: number }[] = []
  private speedWindowHead = 0
  private speedWindowTime = 0
  private speedWindowIntegral = 0
  private minCurrentSpeed = Infinity
  private minRunSpeed = Infinity
  private minRollingSpeed = Infinity
  private stoppedVehicleSeconds = 0
  private metricTime = 0
  private transitionTimes: number[] = []
  private activeConnectors = new Set<CarState>()
  private conflictCache = new WeakMap<ConnPath, WeakMap<ConnPath, number>>()
  private pathSamples = new WeakMap<ConnPath, { x: number; z: number; d: number }[]>()
  private railCrossings = new WeakMap<ConnPath, Map<string, { lo: number; hi: number } | null>>()
  private router: TrafficRouter
  private centralCredit = 0
  private inboundDepartures = 0
  private centralDepartures = 0
  private completedTrips = 0
  private completedReturns = 0
  private lightNight = 0
  private headTint = new THREE.Color()
  private tailTint = new THREE.Color()
  private paintTints = ['#c94f3d', '#d8d4cc', '#5b7461', '#9a9da1', '#d8a832', '#3f4a42'].map(hex => new THREE.Color(hex))

  private makeRng(seed: number) {
    let s = seed | 0
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  }

  constructor(plan: CityPlan, network: RoadNetworkData, mats: CityMaterials, models?: Map<string, THREE.Group>) {
    this.plan = plan
    this.network = network
    this.router = new TrafficRouter(network)
    this.mats = mats
    this.models = models
    for (const lane of network.lanes.values()) {
      const signal = lane.signalId ? network.signals.find(s => s.id === lane.signalId)
        : !lane.routeChoices ? network.signals.find(s => Math.hypot(s.x - lane.x2, s.z - lane.z2) < 14) : undefined
      if (signal) this.laneSignals.set(lane.id, signal)
    }
    this.buildSignals(mats)
    this.buildCars(mats, models)
    this.initializeTrips()
    this.updateCars(0, 0)
    this.buildBuses(mats)
    this.buildTrams(mats)
    this.updateLightAppearance(0)
  }

  /* ---------------- signals ---------------- */
  private buildSignals(mats: CityMaterials) {
    for (const sg of this.network.signals) {
      this.signalState.set(sg.id, { phase: 0, t: sg.phases[0]?.duration ?? 9, elapsed: 0, gap: 0 })
    }
    if (this.network.signals.length === 0) return
    // poles + mast arms + heads (heads face the ONCOMING traffic they control)
    const poleGeo = new THREE.CylinderGeometry(0.1, 0.13, 5.8, 6)
    const poleIM = new THREE.InstancedMesh(poleGeo, mats.poleMetal, this.network.signals.length * 4)
    const armIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.09, 1.5), mats.poleMetal, this.network.signals.length * 4)
    const headGeo = new THREE.BoxGeometry(0.36, 1.0, 0.28)
    const headIM = new THREE.InstancedMesh(headGeo, mats.metalDark, this.network.signals.length * 4)
    const lampGeo = new THREE.SphereGeometry(0.12, 8, 6)
    const lampIM = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), this.network.signals.length * 12)
    const arrowShape = new THREE.Shape([
      new THREE.Vector2(-0.23, 0), new THREE.Vector2(-0.03, 0.19), new THREE.Vector2(-0.03, 0.07),
      new THREE.Vector2(0.22, 0.07), new THREE.Vector2(0.22, -0.07), new THREE.Vector2(-0.03, -0.07), new THREE.Vector2(-0.03, -0.19),
    ])
    const arrowIM = new THREE.InstancedMesh(new THREE.ShapeGeometry(arrowShape), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), this.network.signals.length * 4)
    const arrowBackIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.5, 0.28), mats.metalDark, this.network.signals.length * 4)
    const dummy = new THREE.Object3D()
    let i = 0
    let li = 0
    const heads: { x: number; y: number; z: number }[] = []
    for (const sg of this.network.signals) {
      for (const h of sg.heads) {
        dummy.position.set(h.x, 2.9, h.z)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        poleIM.setMatrixAt(i, dummy.matrix)
        // head hangs on a short mast arm pointing toward the intersection
        const dx = sg.x - h.x
        const dz = sg.z - h.z
        const len = Math.hypot(dx, dz)
        const hx = h.x + (dx / len) * 1.4
        const hz = h.z + (dz / len) * 1.4
        dummy.position.set(h.x, 5.9, h.z)
        dummy.rotation.set(0, Math.atan2(dx, dz), 0)
        dummy.updateMatrix()
        armIM.setMatrixAt(i, dummy.matrix)
        // facing: back along the approach the head controls (axis + dir)
        const fx = h.axis === 'x' ? -h.dir : 0
        const fz = h.axis === 'z' ? -h.dir : 0
        const ry = Math.atan2(fx, fz)
        dummy.position.set(hx, 5.55, hz)
        dummy.rotation.set(0, ry, 0)
        dummy.updateMatrix()
        headIM.setMatrixAt(i, dummy.matrix)
        // lamps on the face the approaching drivers see
        const nx = Math.sin(ry)
        const nz = Math.cos(ry)
        const hasArrow = sg.phases.some(p => p.movement === 'left' && p.greenAxis === h.axis)
        dummy.position.set(hx - Math.cos(ry) * 0.55, 5.55, hz + Math.sin(ry) * 0.55)
        dummy.scale.setScalar(hasArrow ? 1 : 0.0001)
        dummy.updateMatrix()
        arrowBackIM.setMatrixAt(i, dummy.matrix)
        dummy.position.x += nx * 0.15
        dummy.position.z += nz * 0.15
        dummy.updateMatrix()
        arrowIM.setMatrixAt(i, dummy.matrix)
        arrowIM.setColorAt(i, new THREE.Color('#123a16'))
        dummy.scale.setScalar(1)
        for (let l = 0; l < 3; l++) {
          dummy.position.set(hx + nx * 0.17, 5.9 - l * 0.32, hz + nz * 0.17)
          dummy.updateMatrix()
          lampIM.setMatrixAt(li * 3 + l, dummy.matrix)
          lampIM.setColorAt(li * 3 + l, new THREE.Color('#1c1c1c'))
        }
        heads.push({ x: hx, y: 5.6, z: hz })
        i++
        li++
      }
    }
    poleIM.instanceMatrix.needsUpdate = true
    armIM.instanceMatrix.needsUpdate = true
    headIM.instanceMatrix.needsUpdate = true
    lampIM.instanceMatrix.needsUpdate = true
    arrowIM.instanceMatrix.needsUpdate = true
    arrowBackIM.instanceMatrix.needsUpdate = true
    if (lampIM.instanceColor) lampIM.instanceColor.needsUpdate = true
    this.group.add(poleIM, armIM, headIM, lampIM, arrowIM, arrowBackIM)
    this.signalMeshes.push({ lampIM, arrowIM, heads })
  }

  signalGreenAxis(signalId: string): 'x' | 'z' | null {
    const sg = this.network.signals.find((s) => s.id === signalId)
    if (!sg) return null
    const st = this.signalState.get(signalId)
    if (!st) return null
    const phase = sg.phases[st.phase]
    return st.t > 0 && phase && phase.movement !== 'left' ? phase.greenAxis : null
  }

  private updateSignals(dt: number) {
    const demand = new Map<string, Record<string, number>>()
    if (this.config.signalPolicy === 'adaptive') {
      for (const car of this.cars) {
        if (car.conn && !car.conn.internal) continue
        const lane = this.network.lanes.get(car.conn?.internal ? car.connNext : car.segId)
        const signal = lane ? this.laneSignals.get(lane.id) : undefined
        if (!signal || !lane) continue
        const remaining = car.conn ? car.conn.len - car.connDist + Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1)
          : Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1) - car.dist
        if (remaining > 45) continue
        if (car.conn && remaining / Math.max(4, car.speed) > 4) continue
        // A full downstream lane cannot use a green. Count approaching traffic
        // as well as queues, with extra weight for cars that have waited.
        if (car.plannedNext && !this.exitClear(car, car.plannedNext)) continue
        let queue = demand.get(signal.id)
        if (!queue) demand.set(signal.id, queue = {})
        const axis = Math.abs(lane.x2 - lane.x1) > Math.abs(lane.z2 - lane.z1) ? 'x' : 'z'
        const key = `${axis}:${lane.pocket === 'left' ? 'left' : 'through'}`
        queue[key] = (queue[key] ?? 0) + (car.conn ? 0.5 : 1) + Math.min(car.stuck, 20) * 0.2
      }
    }
    for (const sg of this.network.signals) {
      const st = this.signalState.get(sg.id)
      if (!st) continue
      const phase = sg.phases[st.phase]
      if (!phase) continue
      if (st.t > 0 && this.config.signalPolicy === 'adaptive') {
        st.elapsed += dt
        const queue = demand.get(sg.id) ?? {}
        const key = `${phase.greenAxis}:${phase.movement ?? 'through'}`
        const current = (queue[key] ?? 0) + (phase.movement !== 'left' ? (queue[`${phase.greenAxis}:left`] ?? 0) * 0.5 : 0)
        const opposing = Object.entries(queue).reduce((sum, [other, n]) => sum + (other.split(':')[0] !== phase.greenAxis ? n : 0), 0)
        st.gap = current === 0 ? st.gap + dt : 0
        // Short minimum greens discharge a platoon. Gap out unused greens;
        // switch earlier for other queues. Bounded greens and regular through
        // phases guarantee service to pedestrians and quiet approaches.
        const minGreen = phase.movement === 'left' ? 3.5 : 4.5
        const maxGreen = phase.movement === 'left' ? 7 : sg.phases.some(p => p.movement === 'left') ? 11 : 15
        const release = st.elapsed >= minGreen && (st.gap >= 1.2
          || (st.elapsed >= minGreen + 2 && opposing > Math.max(1, current * 1.5)))
        st.t = release || st.elapsed >= maxGreen ? 0 : maxGreen - st.elapsed
      } else st.t -= dt
      if (st.t <= -1.6) {
        // Preserve the all-red clearance between every pair of greens.
        st.phase = (st.phase + 1) % sg.phases.length
        if (this.config.signalPolicy === 'adaptive') {
          // An empty turn pocket needs no arrow phase. Through phases still
          // run regularly for pedestrian crossings and quiet side streets.
          for (let i = 0; i < sg.phases.length; i++) {
            const next = sg.phases[st.phase]
            if (next.movement !== 'left' || (demand.get(sg.id)?.[`${next.greenAxis}:left`] ?? 0) > 0) break
            st.phase = (st.phase + 1) % sg.phases.length
          }
        }
        st.t = sg.phases[st.phase].duration
        st.elapsed = st.gap = 0
      }
    }
  }

  private recordMetrics(dt: number) {
    this.simTime += dt
    if (dt <= 0 || !this.cars.length) return
    let speed = 0, queued = 0
    for (const c of this.cars) {
      speed += c.speed
      if (c.speed < 0.5) queued++
    }
    const n = this.cars.length
    this.metricTime += dt
    this.speedIntegral += speed / n * dt
    this.stoppedVehicleSeconds += queued * dt
    const integral = speed / n * dt
    this.speedWindow.push({ dt, integral })
    this.speedWindowTime += dt
    this.speedWindowIntegral += integral
    while (this.speedWindowTime > 60 && this.speedWindowHead < this.speedWindow.length) {
      const first = this.speedWindow[this.speedWindowHead]
      const excess = this.speedWindowTime - 60
      if (first.dt <= excess + 1e-9) {
        this.speedWindowTime -= first.dt
        this.speedWindowIntegral -= first.integral
        this.speedWindowHead++
      } else {
        const removed = first.integral * excess / first.dt
        first.dt -= excess; first.integral -= removed
        this.speedWindowIntegral -= removed; this.speedWindowTime = 60
      }
    }
    if (this.speedWindowHead > 1024) {
      this.speedWindow = this.speedWindow.slice(this.speedWindowHead)
      this.speedWindowHead = 0
    }
    this.minCurrentSpeed = Math.min(this.minCurrentSpeed, speed / n * 3.6)
    if (this.simTime >= 1) this.minRunSpeed = Math.min(this.minRunSpeed, this.speedIntegral / this.metricTime * 3.6)
    if (this.speedWindowTime >= 60 - 1e-6) this.minRollingSpeed = Math.min(this.minRollingSpeed, this.speedWindowIntegral / this.speedWindowTime * 3.6)
  }

  getConfig(): TrafficConfig { return { ...this.config } }

  getMetrics(): TrafficMetrics {
    const n = this.cars.length
    const elapsed = Math.max(this.metricTime, 1e-6)
    while (this.transitionTimes.length && this.transitionTimes[0] <= this.simTime - 60) this.transitionTimes.shift()
    const queued = this.cars.reduce((sum, c) => sum + (c.speed < 0.5 ? 1 : 0), 0)
    return {
      simulationSeconds: this.simTime,
      avgSpeedKmh: n ? this.speedIntegral / elapsed * 3.6 : 0,
      currentSpeedKmh: n ? this.cars.reduce((sum, car) => sum + car.speed, 0) / n * 3.6 : 0,
      rollingSpeedKmh: this.speedWindowTime ? this.speedWindowIntegral / this.speedWindowTime * 3.6 : 0,
      minCurrentSpeedKmh: Number.isFinite(this.minCurrentSpeed) ? this.minCurrentSpeed : null,
      minRunSpeedKmh: Number.isFinite(this.minRunSpeed) ? this.minRunSpeed : null,
      minRollingSpeedKmh: Number.isFinite(this.minRollingSpeed) ? this.minRollingSpeed : null,
      queued,
      queuePercent: n ? queued / n * 100 : 0,
      meanWaitSec: queued ? this.cars.reduce((sum, c) => sum + (c.speed < 0.5 ? c.stuck : 0), 0) / queued : 0,
      stoppedSecondsPerVehicle: n ? this.stoppedVehicleSeconds / n : 0,
      throughputPerMinute: this.transitionTimes.length * 60 / Math.max(1, Math.min(60, this.simTime)),
      completedSegments: this.completedSegments,
      activeVehicles: n,
      recoveryRespawns: this.recoveryRespawns,
    }
  }

  configure(config: TrafficConfig): void {
    const count = Math.round(Math.max(MIN_TRAFFIC_VEHICLES, Math.min(MAX_TRAFFIC_VEHICLES, config.vehicleCount)))
    this.config = { scenario: config.scenario, vehicleCount: count, signalPolicy: config.signalPolicy }
    this.cars = []
    for (const meshes of this.carMeshes) {
      for (const mesh of Object.values(meshes)) {
        if (mesh instanceof THREE.InstancedMesh) {
          this.group.remove(mesh)
          mesh.geometry.dispose()
        }
      }
    }
    this.carMeshes = []
    for (const material of this.carOwnedMaterials) {
      const textured = material as THREE.MeshStandardMaterial
      textured.map?.dispose()
      material.dispose()
    }
    this.carOwnedMaterials.clear()
    this.rng = this.makeRng(90210)
    this.simTime = this.completedSegments = this.recoveryRespawns = 0
    this.speedIntegral = this.metricTime = 0
    this.speedWindow = []; this.speedWindowHead = 0
    this.speedWindowTime = this.speedWindowIntegral = 0
    this.minCurrentSpeed = this.minRunSpeed = this.minRollingSpeed = Infinity
    this.stoppedVehicleSeconds = 0
    this.transitionTimes = []
    this.buildCars(this.mats, this.models)
    this.initializeTrips()
    for (const sg of this.network.signals) this.signalState.set(sg.id, { phase: 0, t: sg.phases[0]?.duration ?? 9, elapsed: 0, gap: 0 })
    this.updateCars(0, 0) // render valid reset poses even while the experiment is paused
    this.updateLightAppearance(this.lightNight)
  }

  private isGreen(sg: SignalGroup, axis: 'x' | 'z', lane?: LaneSeg): boolean {
    const st = this.signalState.get(sg.id)
    if (!st) return true
    if (st.t <= 0) return false // all-red
    const phase = sg.phases[st.phase]
    if (!phase) return true
    if (phase.greenAxis !== axis) return false
    if (phase.movement === 'left') return lane?.pocket === 'left'
    // During a circular green left turns may use gaps, yielding through the
    // conflict reservations. The separate arrow guarantees a protected turn.
    return true
  }

  private newInboundTarget(car: CarState): string {
    const share = this.config.scenario === 'gridlock' ? 0.92 : this.config.scenario === 'rush-hour' ? 0.55 : 0
    this.inboundDepartures++
    this.centralCredit += share
    if (this.centralCredit >= 1 - 1e-9) {
      this.centralCredit -= 1
      this.centralDepartures++
      return this.config.scenario === 'gridlock' ? this.router.core : this.router.central[Math.floor(this.rng() * this.router.central.length)]
    }
    const options = this.router.destinations.filter(id => id !== car.homeNode && !this.router.central.includes(id))
    return options[Math.floor(this.rng() * options.length)]
  }

  private initializeTrips() {
    this.centralCredit = 0
    this.inboundDepartures = this.centralDepartures = this.completedTrips = this.completedReturns = 0
    this.router.reset()
    for (const car of this.cars) {
      car.homeNode = this.router.homes[Math.floor(this.rng() * this.router.homes.length)]
      car.tripToHome = false
      car.tripTarget = this.newInboundTarget(car)
      car.nextTripTarget = null
    }
    this.router.sense(this.cars, 0)
  }

  private routingTarget(car: CarState, lane: LaneSeg) {
    if (this.router.endNode(lane.id) !== car.tripTarget) return car.tripTarget
    // Plan a legal departure from the destination junction, but don't mark
    // arrival or change the current trip until the car physically crosses it.
    car.nextTripTarget ??= car.tripToHome ? this.newInboundTarget(car) : car.homeNode
    return car.nextTripTarget
  }

  private arriveAtJunction(car: CarState, incoming: LaneSeg) {
    if (this.router.endNode(incoming.id) !== car.tripTarget || !this.router.isJunction(car.tripTarget)) return
    this.completedTrips++
    if (car.tripToHome) this.completedReturns++
    car.tripTarget = car.nextTripTarget ?? (car.tripToHome ? this.newInboundTarget(car) : car.homeNode)
    car.tripToHome = !car.tripToHome
    car.nextTripTarget = null
  }

  getTripStats() {
    return { inboundDepartures: this.inboundDepartures, centralDepartures: this.centralDepartures,
      completedTrips: this.completedTrips, completedReturns: this.completedReturns,
      returningVehicles: this.cars.filter(c => c.tripToHome).length }
  }

  /* ---------------- cars ---------------- */
  private buildCars(mats: CityMaterials, models?: Map<string, THREE.Group>) {
    this.laneList = [...this.network.lanes.values()].filter(lane => !lane.pocket).map(lane => lane.id)
    if (this.laneList.length === 0) return

    const laneWeights: Record<string, number> = { arterial: 4, collector: 2, local: 1 }
    const typeCount = [0, 0, 0, 0, 0]
    const picked: { lane: string; typeIdx: number; paint: number; dist: number }[] = []
    // Spawn with a full truck-length gap; never force an occupied placement.
    // At most one car per 12 m of lane, otherwise the
    // initial cluster welds into a queue that reads as a "stockpile"
    const claimed = new Map<string, number[]>()
    const claim = (lane: string, d: number) => {
      const arr = claimed.get(lane)
      if (arr && arr.some((u) => Math.abs(u - d) < 12)) return false
      if (arr) arr.push(d)
      else claimed.set(lane, [d])
      return true
    }
    for (let i = 0; i < this.config.vehicleCount; i++) {
      let segId = this.laneList[Math.floor(this.rng() * this.laneList.length)]
      let dist = 5
      let placed = false
      for (let tries = 0; tries < 80; tries++) {
        const cand = this.laneList[Math.floor(this.rng() * this.laneList.length)]
        const seg = this.network.lanes.get(cand)
        if (!seg) continue
        if (tries < 60) {
          let weight = (laneWeights[seg.cls] ?? 1) / 4
          const mx = (seg.x1 + seg.x2) / 2, mz = (seg.z1 + seg.z2) / 2
          const central = Math.abs(mx) < (this.config.scenario === 'rush-hour' ? 320 : 205) && Math.abs(mz) < (this.config.scenario === 'rush-hour' ? 320 : 205)
          if (this.config.scenario !== 'normal') weight *= central ? 2.2 : 0.22
          if (this.config.scenario === 'gridlock' && central && seg.cls === 'arterial') weight *= 1.7
          if (this.rng() >= Math.min(0.98, weight)) continue
        }
        const len = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1)
        const d = 2 + this.rng() * Math.max(4, Math.min(60, len - 4))
        if (claim(cand, d)) {
          segId = cand
          dist = d
          placed = true
          break
        }
      }
      if (!placed) {
        search: for (const id of this.laneList) {
          const lane = this.network.lanes.get(id)!
          const length = Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1)
          for (let d = 4; d < length - 4; d += 12) if (claim(id, d)) {
            segId = id; dist = d; placed = true; break search
          }
        }
      }
      const typeIdx = CAR_TYPE_WEIGHTS[Math.floor(this.rng() * CAR_TYPE_WEIGHTS.length)]
      typeCount[typeIdx]++
      picked.push({ lane: segId, typeIdx, paint: typeIdx === 1 ? 4 : typeIdx === 4 ? 2 : Math.floor(this.rng() * 6), dist })
    }
    // slots per type
    const slotCursor = [0, 0, 0, 0, 0]
    for (const p of picked) {
      this.cars.push({
        segId: p.lane,
        dist: p.dist,
        odo: this.rng() * 40,
        speed: 4 + this.rng() * 4,
        typeIdx: p.typeIdx,
        slot: slotCursor[p.typeIdx]++,
        paint: p.paint,
        x: 0,
        z: 0,
        heading: 0,
        stopped: false,
        conn: null,
        connNext: '',
        plannedNext: null,
        afterPocket: null,
        homeNode: '', tripTarget: '', nextTripTarget: null, tripToHome: false,
        connDist: 0,
        tail: null,
        stuck: 0,
        creep: 0,
        jammed: 0,
        forced: 0,
        serveT: 0,
        serveCd: 20 + this.rng() * 40,
        brakeHold: 0,
      })
    }

    // one set of instanced meshes per vehicle type
    for (let t = 0; t < 5; t++) {
      if (typeCount[t] === 0) {
        this.carMeshes.push({ paint: null, glass: null, dark: null, chrome: null, lampF: null, lampR: null, extra: null, extra2: null, wheels: null, wheelOffsets: [] })
        continue
      }
      const modelKey = t === 0 ? 'sedan' : t === 1 ? 'estate' : t === 2 ? 'van' : null
      const authored = modelKey ? models?.get(modelKey) : undefined
      const fallback = CAR_BODY_BUILDERS[t]()
      const wheelOffsets = t === 2
        ? [{ x: -0.88, z: 1.72, r: 0.38 }, { x: 0.88, z: 1.72, r: 0.38 }, { x: -0.88, z: -1.60, r: 0.38 }, { x: 0.88, z: -1.60, r: 0.38 }]
        : [{ x: -0.78, z: 1.34, r: 0.34 }, { x: 0.78, z: 1.34, r: 0.34 }, { x: -0.78, z: -1.34, r: 0.34 }, { x: 0.78, z: -1.34, r: 0.34 }]
      const groups = authored ? authoredVehicleGroups(authored, wheelOffsets) : fallback
      if (authored) {
        const wheel = models?.get('wheel')
        if (wheel) {
          const authoredWheel = authoredVehicleGroups(wheel, [])
          const scale = t === 2 ? 0.38 / 0.34 : 1
          if (authoredWheel.tire.length && authoredWheel.hub.length) {
            groups.tire = authoredWheel.tire.map(g => g.scale(scale, scale, scale))
            const hub = mergeGeometries(authoredWheel.hub, false)!
            groups.hub = [hub.scale(scale, scale, scale)]
          } else {
            groups.tire = fallback.tire
            groups.hub = fallback.hub
          }
        } else {
          groups.tire = fallback.tire
          groups.hub = fallback.hub
        }
      }
      const mk = (geos: THREE.BufferGeometry[], mat: THREE.Material, dynamic: boolean, shadow: boolean): THREE.InstancedMesh | null => {
        if (!geos.length) return null
        const merged = mergeGeometries(geos, false)
        if (!merged) return null
        const im = new THREE.InstancedMesh(merged, mat, typeCount[t])
        if (dynamic) im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        im.frustumCulled = false
        im.castShadow = shadow
        im.receiveShadow = false
        this.group.add(im)
        return im
      }
      const paintMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.62 })
      this.carOwnedMaterials.add(paintMat)
      // wheels: one instanced mesh per type (tire + hub groups), spun per instance
      let wheelIM: THREE.InstancedMesh | null = null
      if (groups.wheelOffsets.length > 0) {
        const wheelGeo = mergeGeometries([groups.tire[0], groups.hub[0]], true)
        if (wheelGeo) {
          wheelIM = new THREE.InstancedMesh(wheelGeo, [mats.tire, mats.metal], typeCount[t] * groups.wheelOffsets.length)
          wheelIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
          wheelIM.frustumCulled = false
          this.group.add(wheelIM)
        }
      }
      const tm: CarTypeMeshes = {
        paint: mk(groups.paint, paintMat, true, true),
        glass: mk(groups.glass, mats.glassDark, true, false),
        dark: mk(groups.dark, mats.metalDark, true, false),
        chrome: mk(groups.chrome, mats.metal, true, false),
        lampF: mk(groups.lampF, mats.headlight, true, false),
        lampR: mk(groups.lampR, mats.taillight, true, false),
        extra: null,
        extra2: null,
        wheels: wheelIM,
        wheelOffsets: groups.wheelOffsets,
      }
      // initialize instance colors (white → tinted per car each frame)
      if (tm.paint) {
        for (let s = 0; s < typeCount[t]; s++) tm.paint.setColorAt(s, new THREE.Color('#ffffff'))
        if (tm.paint.instanceColor) tm.paint.instanceColor.needsUpdate = true
      }
      // Allocate per-instance tint buffers before the first render.
      if (tm.lampF) {
        for (let s = 0; s < typeCount[t]; s++) tm.lampF.setColorAt(s, new THREE.Color().setScalar(.15))
      }
      if (tm.lampR) {
        for (let s = 0; s < typeCount[t]; s++) tm.lampR.setColorAt(s, new THREE.Color('#9a9a9a'))
        if (tm.lampR.instanceColor) tm.lampR.instanceColor.needsUpdate = true
      }
      // extras: taxi roof sign / truck cargo box
      if (t === 1) {
        const [c, ctx] = canvas(128, 64)
        ctx.fillStyle = '#131313'
        ctx.fillRect(0, 0, 128, 64)
        ctx.fillStyle = '#ffb84a'
        ctx.font = 'bold 38px Arial'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('TAXI', 64, 34)
        const sideMat = new THREE.MeshBasicMaterial({ map: tex(c, false), toneMapped: false })
        const blackMat = new THREE.MeshBasicMaterial({ color: '#131313' })
        this.carOwnedMaterials.add(sideMat); this.carOwnedMaterials.add(blackMat)
        const signGeo = new THREE.BoxGeometry(0.66, 0.22, 0.34)
        signGeo.translate(0, 1.52, -0.2)
        const im = new THREE.InstancedMesh(signGeo, [blackMat, blackMat, blackMat, blackMat, sideMat, sideMat], typeCount[t])
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        im.frustumCulled = false
        this.group.add(im)
        tm.extra = im
      } else if (t === 3) {
        const sideMat = new THREE.MeshStandardMaterial({ map: tex(cargoSideCanvas(), false), roughness: 0.6, metalness: 0.15 })
        const plainMat = new THREE.MeshStandardMaterial({ color: '#d8d5cc', roughness: 0.72, metalness: 0.1 })
        this.carOwnedMaterials.add(sideMat); this.carOwnedMaterials.add(plainMat)
        const L = 7.6
        const W = 2.45
        const cargoGeo = new THREE.BoxGeometry(W, 2.35, L * 0.58)
        cargoGeo.translate(0, 1.62, -L * 0.16)
        const im = new THREE.InstancedMesh(cargoGeo, [sideMat, sideMat, plainMat, plainMat, plainMat, plainMat], typeCount[t])
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        im.castShadow = true
        im.frustumCulled = false
        this.group.add(im)
        tm.extra = im
      } else if (t === 4) {
        // garbage truck body: SOLHEIM WASTE livery + amber beacon
        const [wc, wctx] = canvas(256, 128)
        wctx.fillStyle = '#3f5c48'
        wctx.fillRect(0, 0, 256, 128)
        wctx.fillStyle = '#33503f'
        wctx.fillRect(0, 100, 256, 16)
        wctx.fillStyle = '#e8b83a'
        wctx.fillRect(0, 92, 256, 8)
        wctx.fillStyle = '#f0ede2'
        wctx.font = 'bold 30px Arial'
        wctx.textAlign = 'center'
        wctx.fillText('SOLHEIM', 128, 52)
        wctx.font = 'bold 21px Arial'
        wctx.fillStyle = '#cfe0c8'
        wctx.fillText('WASTE · RECYCLING', 128, 84)
        const bodyMat = new THREE.MeshStandardMaterial({ map: tex(wc, false), roughness: 0.62, metalness: 0.12 })
        const plainMat2 = new THREE.MeshStandardMaterial({ color: '#3f5c48', roughness: 0.62, metalness: 0.12 })
        this.carOwnedMaterials.add(bodyMat); this.carOwnedMaterials.add(plainMat2)
        const Lg = 8.2
        const Wg = 2.5
        const bodyGeo = new THREE.BoxGeometry(Wg * 0.92, 2.0, Lg * 0.52)
        bodyGeo.translate(0, 1.85, -Lg * 0.19)
        const im2 = new THREE.InstancedMesh(bodyGeo, [bodyMat, bodyMat, plainMat2, plainMat2, plainMat2, plainMat2], typeCount[t])
        im2.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        im2.castShadow = true
        im2.frustumCulled = false
        this.group.add(im2)
        tm.extra = im2
        // amber beacon on the cab roof (always glowing — service vehicle)
        const beaconGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.16, 8)
        beaconGeo.translate(0, 2.68, Lg / 2 - 1.35)
        const beaconMat = new THREE.MeshBasicMaterial({ color: '#ffb43a', toneMapped: false })
        this.carOwnedMaterials.add(beaconMat)
        const beaconIM = new THREE.InstancedMesh(beaconGeo, beaconMat, typeCount[t])
        beaconIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        beaconIM.frustumCulled = false
        this.group.add(beaconIM)
        tm.extra2 = beaconIM
      }
      this.carMeshes.push(tm)
    }
  }

  private updateCars(dt: number, _night: number, writeMatrices = true) {
    const dummy = new THREE.Object3D()
    dummy.rotation.order = 'YXZ'
    this.activeConnectors.clear()
    for (const car of this.cars) {
      if (car.tail && car.dist > this.carLength(car) / 2 + 2.2) car.tail = null
      if (car.conn || car.tail) this.activeConnectors.add(car)
    }
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i]
      const seg = this.network.lanes.get(car.segId)
      if (!seg) {
        // respawn on a lane whose start is not occupied
        car.segId = this.randomFreeLane()
        car.dist = 0
        car.conn = null
        continue
      }

      /* ---------- desired speed ---------- */
      const stopOffset = this.carLength(car) / 2 + 1
      let target = Math.min(seg.speed, 11)
      let fx: number, fz: number
      if (car.conn) {
        // Stored tangent from the preceding connector sample.
        fx = Math.sin(car.heading)
        fz = Math.cos(car.heading)
        if (!car.conn.straight) target = Math.min(target, 4.6) // slow through turns
      } else {
        const len0 = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1)
        fx = (seg.x2 - seg.x1) / len0
        fz = (seg.z2 - seg.z1) / len0
      }

      // Follow distance along the actual lane/turn, rather than a forward
      // cone that mistakes a waiting cross approach for a leader. Platoons
      // retain their bumper gap even around a curved connector.
      const laneRemaining = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1) - car.dist
      for (const other of this.cars) {
        if (other === car) continue
        let gap = Infinity
        if (car.conn) {
          if (other.conn === car.conn) gap = other.connDist - car.connDist
          else if (!other.conn && other.segId === car.connNext) gap = car.conn.len - car.connDist + other.dist
        } else {
          if (other.segId === car.segId) gap = other.conn ? laneRemaining + other.connDist : other.dist - car.dist
        }
        if (gap <= 0 || !Number.isFinite(gap)) continue
        const clearance = gap - (this.carLength(car) + this.carLength(other)) / 2 - 1.8
        target = Math.min(target, Math.max(0, clearance * 1.4))
      }
      // Brake before the stop line if the signal, reserved turn or exit is blocked.
      if (!car.conn) {
        const distToEnd = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1) - car.dist
        if (distToEnd < 22 && !car.plannedNext && seg.next.length) {
          const choices = seg.routeChoices ?? seg.next
          const targetNode = this.routingTarget(car, seg)
          const exit = this.router.choose(seg, choices, targetNode)
          if (seg.routeChoices) {
            car.afterPocket = exit
            car.plannedNext = seg.next.find(id => this.network.lanes.get(id)!.next.includes(exit)) ?? seg.next[0]
          } else car.plannedNext = exit
        }
        if (distToEnd < 18 && car.plannedNext) {
          const plannedPath = this.network.connectors.get(`${seg.id}>${car.plannedNext}`)
          const stalledMovement = car.stuck >= 5 && plannedPath && !this.connectorClear(car, plannedPath)
          if (seg.routeChoices && (!this.exitClear(car, car.plannedNext)
            || (car.afterPocket && !this.exitClear(car, car.afterPocket)) || stalledMovement)) {
            // Choose the lane before the taper. Once inside a pocket cars
            // obey its arrows; they cannot cut sideways across a waiting lane.
            const choices = seg.next.flatMap(id => {
              if (!this.exitClear(car, id)) return []
              const path = this.network.connectors.get(`${seg.id}>${id}`)
              if (stalledMovement && path && !this.connectorClear(car, path)) return []
              return this.network.lanes.get(id)!.next.filter(exit => this.exitClear(car, exit)).map(exit => ({ pocket: id, exit }))
            })
            if (choices.length) {
              const targetNode = this.routingTarget(car, seg)
              const cost = (choice: typeof choices[number]) => this.router.score(seg, choice.exit, targetNode)
              const choice = choices.reduce((best, next) => cost(next) < cost(best) ? next : best)
              car.plannedNext = choice.pocket
              car.afterPocket = choice.exit
            }
          }
          if (!seg.routeChoices && distToEnd < 8 && car.speed < 2 && (!this.exitClear(car, car.plannedNext) || stalledMovement)) {
            // Retain destination-biased demand, but take a legal detour when
            // its chosen exit is full. A single blocked turn must not freeze
            // every following car while another exit has storage available.
            const alternatives = seg.next.filter(id => {
              const path = this.network.connectors.get(`${seg.id}>${id}`)
              return id !== car.plannedNext && this.exitClear(car, id) && (!path || this.connectorClear(car, path))
            })
            if (alternatives.length) {
              car.plannedNext = this.router.choose(seg, alternatives, this.routingTarget(car, seg))
            }
          }
          const path = this.network.connectors.get(`${seg.id}>${car.plannedNext}`)
          if (!this.exitClear(car, car.plannedNext) || (path && !this.connectorClear(car, path))) {
            target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, distToEnd - stopOffset)))
          }
        }
        if (distToEnd < 18) {
          const signal = this.laneSignals.get(seg.id)
          const axis: 'x' | 'z' = Math.abs(fx) > Math.abs(fz) ? 'x' : 'z'
          if (signal && !this.isGreen(signal, axis, seg)) {
            target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, distToEnd - stopOffset)))
          }
        }
      }
      // garbage trucks pull over at dumpsters to "collect" (7 s service)
      let serving = false
      if (car.typeIdx === 4) {
        car.serveCd -= dt
        if (car.serveT > 0) {
          car.serveT -= dt
          target = 0
          serving = true
          if (car.serveT <= 0) car.serveCd = 160
        } else if (car.serveCd <= 0 && !car.conn && !seg.pocket) {
          for (const [gx, gz] of GARBAGE_SPOTS) {
            const dxs = car.x - gx
            const dzs = car.z - gz
            if (dxs * dxs + dzs * dzs < 16 * 16) {
              car.serveT = 7
              break
            }
          }
        }
      }

      /* ---------- integrate ---------- */
      const before = car.speed
      const accel = target > car.speed ? 3.5 : 9
      car.speed += Math.sign(target - car.speed) * Math.min(Math.abs(target - car.speed), accel * dt)
      const braking = car.speed < before - 0.001 || serving || car.speed < .15
      car.brakeHold = braking ? .18 : Math.max(0, (car.brakeHold ?? 0) - dt)
      car.odo += car.speed * dt
      // Legal queues remain visible; they never trigger red-light overrides.
      car.stuck = car.speed < 0.35 ? car.stuck + dt : 0
      car.jammed = car.stuck
      car.creep = 0
      car.forced = 0

      if (car.conn) {
        car.connDist += car.speed * dt
        if (car.connDist >= car.conn.len) {
          const internal = car.conn.internal
          car.tail = car.conn
          car.dist = car.connDist - car.conn.len
          car.segId = car.connNext
          car.conn = null
          car.plannedNext = internal ? car.afterPocket : null
          car.afterPocket = null
          if (!internal) {
            this.arriveAtJunction(car, seg)
            this.completedSegments++
            this.transitionTimes.push(this.simTime)
          }
        }
      } else {
        car.dist += car.speed * dt
        const len = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1)
        if (car.dist >= len - stopOffset) {
          // pick next lane + take its connector across the intersection
          if (seg.next.length > 0 && car.speed > 0.5) {
            const nid = car.plannedNext ?? seg.next[Math.floor(this.rng() * seg.next.length)]
            const conn = this.network.connectors.get(`${seg.id}>${nid}`)
            // BOX DISCIPLINE ("don't block the pack"): only enter the
            // intersection when the exit lane's first meters are moving —
            // driving into a stopped queue is what gridlocks a junction
            const approachAxis: 'x' | 'z' = Math.abs(fx) > Math.abs(fz) ? 'x' : 'z'
            const signal = this.laneSignals.get(seg.id)
            const green = !signal || this.isGreen(signal, approachAxis, seg)
            if (!green || !this.exitClear(car, nid) || (conn && !this.connectorClear(car, conn))) {
              car.dist = Math.min(car.dist, len - stopOffset)
              car.speed = 0
            } else if (conn && conn.len > 0.3) {
              car.tail = null
              car.conn = conn
              car.connNext = nid
              car.connDist = car.dist - len
              this.activeConnectors.add(car)
            } else {
              this.arriveAtJunction(car, seg)
              car.segId = nid
              car.plannedNext = null
              car.dist -= len
              this.completedSegments++
              this.transitionTimes.push(this.simTime)
            }
          } else {
            car.dist = Math.min(car.dist, len - stopOffset)
            if (seg.next.length === 0) {
              car.segId = this.randomFreeLane()
              car.dist = 0
              car.conn = null
              this.recoveryRespawns++
            }
          }
        }
      }

      /* ---------- sample pose ---------- */
      let px: number
      let pz: number
      let heading: number
      if (car.conn) {
        const conn = car.conn
        const d = Math.max(0, Math.min(car.connDist, conn.len))
        let s = 1
        while (s < conn.cum.length - 1 && conn.cum[s] < d) s++
        const a = conn.pts[s - 1]
        const b = conn.pts[s]
        const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 0.001
        const t = (d - conn.cum[s - 1]) / segLen
        px = a.x + (b.x - a.x) * t
        pz = a.z + (b.z - a.z) * t
        heading = Math.atan2(b.x - a.x, b.z - a.z)
        if (car.connDist < 0) {
          const length = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1)
          px = seg.x2 + (seg.x2 - seg.x1) / length * car.connDist
          pz = seg.z2 + (seg.z2 - seg.z1) / length * car.connDist
          heading = Math.atan2(seg.x2 - seg.x1, seg.z2 - seg.z1)
        }
      } else {
        const s2 = this.network.lanes.get(car.segId)
        if (!s2) continue
        const len2 = Math.hypot(s2.x2 - s2.x1, s2.z2 - s2.z1)
        const t = Math.min(car.dist / len2, 1)
        px = s2.x1 + (s2.x2 - s2.x1) * t
        pz = s2.z1 + (s2.z2 - s2.z1) * t
        heading = Math.atan2(s2.x2 - s2.x1, s2.z2 - s2.z1)
      }
      car.x = px
      car.z = pz
      car.heading = heading
      // Multiple fixed simulation steps can feed one displayed frame. Keep
      // every physics step, but only build/upload the final car pose.
      if (!writeMatrices) continue

      // write matrices — geometry is pre-built per type, one transform per group
      const tm = this.carMeshes[car.typeIdx]
      if (!tm) continue
      dummy.position.set(car.x, 0, car.z)
      dummy.rotation.set(0, car.heading, 0)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      tm.paint?.setMatrixAt(car.slot, dummy.matrix)
      tm.paint?.setColorAt(car.slot, this.paintTints[car.paint])
      tm.glass?.setMatrixAt(car.slot, dummy.matrix)
      tm.dark?.setMatrixAt(car.slot, dummy.matrix)
      tm.chrome?.setMatrixAt(car.slot, dummy.matrix)
      tm.extra?.setMatrixAt(car.slot, dummy.matrix)
      tm.extra2?.setMatrixAt(car.slot, dummy.matrix)
      // Lenses share the body transform. Scaling about the car origin used to
      // push them away from the bumpers when braking and shrink them into the
      // road in daylight. Brightness is independent of geometry and braking.
      tm.lampF?.setMatrixAt(car.slot, dummy.matrix)
      tm.lampR?.setMatrixAt(car.slot, dummy.matrix)
      // spinning wheels (spin angle from lifetime odometer per wheel radius)
      if (tm.wheels) {
        const cosH = Math.cos(car.heading)
        const sinH = Math.sin(car.heading)
        for (let wi = 0; wi < tm.wheelOffsets.length; wi++) {
          const w = tm.wheelOffsets[wi]
          const rx = cosH * w.x + sinH * w.z
          const rz = -sinH * w.x + cosH * w.z
          dummy.position.set(car.x + rx, w.r, car.z + rz)
          dummy.rotation.set(car.odo / w.r, car.heading, 0)
          dummy.scale.setScalar(1)
          dummy.updateMatrix()
          tm.wheels.setMatrixAt(car.slot * tm.wheelOffsets.length + wi, dummy.matrix)
        }
      }
    }
    if (!writeMatrices) return
    for (const tm of this.carMeshes) {
      if (tm.paint) {
        tm.paint.instanceMatrix.needsUpdate = true
        if (tm.paint.instanceColor) tm.paint.instanceColor.needsUpdate = true
      }
      if (tm.glass) tm.glass.instanceMatrix.needsUpdate = true
      if (tm.dark) tm.dark.instanceMatrix.needsUpdate = true
      if (tm.chrome) tm.chrome.instanceMatrix.needsUpdate = true
      if (tm.lampF) tm.lampF.instanceMatrix.needsUpdate = true
      if (tm.lampR) {
        tm.lampR.instanceMatrix.needsUpdate = true
        if (tm.lampR.instanceColor) tm.lampR.instanceColor.needsUpdate = true
      }
      if (tm.extra) tm.extra.instanceMatrix.needsUpdate = true
      if (tm.extra2) tm.extra2.instanceMatrix.needsUpdate = true
      if (tm.wheels) tm.wheels.instanceMatrix.needsUpdate = true
    }
  }

  getCarPositions(): { count: number; data: Float32Array } {
    const data = new Float32Array(this.cars.length * 2)
    this.cars.forEach((c, i) => {
      data[i * 2] = c.x
      data[i * 2 + 1] = c.z
    })
    return { count: this.cars.length, data }
  }

  /** buses currently dwelling with doors open — pedestrians board/alight here.
   *  doorX/doorZ is a curbside standoff just outside the front plug doors. */
  getBoardingBuses(): { x: number; z: number; doorX: number; doorZ: number; stopId: string }[] {
    const out: { x: number; z: number; doorX: number; doorZ: number; stopId: string }[] = []
    for (const bus of this.buses) {
      if (bus.dwell <= 0.8 || bus.doorT < 0.55) continue
      const path = this.busPaths[bus.routeIdx]
      if (!path) continue
      let si = -1
      for (let i = 0; i < path.stopDists.length; i++) {
        if (Math.abs(bus.dist - path.stopDists[i]) < 2.5) {
          si = i
          break
        }
      }
      if (si < 0 || !path.stopIds[si]) continue
      const cosH = Math.cos(bus.heading)
      const sinH = Math.sin(bus.heading)
      const lx = -3.9 // curbside standoff outside the -x door face
      const lz = 4.5 // front door
      out.push({
        x: bus.x,
        z: bus.z,
        doorX: bus.x + cosH * lx + sinH * lz,
        doorZ: bus.z - sinH * lx + cosH * lz,
        stopId: path.stopIds[si],
      })
    }
    return out
  }

  /* ---------------- buses ---------------- */
  private buildBuses(mats: CityMaterials) {
    for (const route of this.plan.routes) {
      if (route.mode !== 'bus') continue
      const pts = route.points
      const cum: number[] = [0]
      let total = 0
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        total += Math.hypot(b.x - a.x, b.z - a.z)
        cum.push(total)
      }
      const stopEntries = route.stopIds
        .map((sid) => {
          const stop = this.plan.stops.find((s) => s.id === sid)
          if (!stop) return null
          // project stop onto loop: nearest cumulative distance
          let best = 0
          let bestD = Infinity
          let acc = 0
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i]
            const b = pts[(i + 1) % pts.length]
            const segLen = Math.hypot(b.x - a.x, b.z - a.z)
            const t = Math.max(0, Math.min(1, ((stop.x - a.x) * (b.x - a.x) + (stop.z - a.z) * (b.z - a.z)) / (segLen * segLen || 1)))
            const d = acc + t * segLen
            const px = a.x + (b.x - a.x) * t
            const pz = a.z + (b.z - a.z) * t
            const dd = Math.hypot(px - stop.x, pz - stop.z)
            if (dd < bestD) { bestD = dd; best = d }
            acc += segLen
          }
          return { sid, d: best }
        })
        .filter((e): e is { sid: string; d: number } => e !== null)
      this.busPaths.push({ pts, cum, total, stopDists: stopEntries.map((e) => e.d), stopIds: stopEntries.map((e) => e.sid) })
    }
    if (this.busPaths.length === 0) return

    /* ---- city bus with procedural canvas livery (like the facades) ---- */
    const L = 11.4
    const W = 2.55
    const sideCanvas = (flip: boolean) => {
      const [c, ctx] = canvas(1024, 232)
      if (flip) {
        ctx.translate(1024, 0)
        ctx.scale(-1, 1)
      }
      ctx.fillStyle = '#e8e3d5'
      ctx.fillRect(0, 0, 1024, 232)
      ctx.fillStyle = '#3a3d3f'
      ctx.fillRect(0, 196, 1024, 36) // skirt
      ctx.fillStyle = '#4a8c5c'
      ctx.fillRect(0, 176, 1024, 22) // green stripe
      const winY = 34
      const winH = 96
      for (const wx of [190, 320, 450, 730, 860]) {
        ctx.fillStyle = '#4c5054'
        ctx.fillRect(wx - 4, winY - 4, 118, winH + 8)
        ctx.fillStyle = '#2b3638'
        ctx.fillRect(wx, winY, 110, winH)
        ctx.fillStyle = 'rgba(255,255,255,0.16)'
        ctx.fillRect(wx + 8, winY, 22, winH)
      }
      // double doors: front + mid
      for (const dx of [40, 590]) {
        ctx.fillStyle = '#4c5054'
        ctx.fillRect(dx - 4, winY - 4, 138, 168)
        ctx.fillStyle = '#33413f'
        ctx.fillRect(dx, winY, 130, 160)
        ctx.fillStyle = '#e8e3d5'
        ctx.fillRect(dx + 62, winY, 6, 160)
      }
      // livery text (drawn unmirrored so it stays readable)
      ctx.save()
      ctx.translate(920, 164)
      if (flip) ctx.scale(-1, 1)
      ctx.fillStyle = '#2f4238'
      ctx.font = 'bold 30px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('SOLHEIM', 0, 0)
      ctx.restore()
      return c
    }
    const frontCanvas = () => {
      const [c, ctx] = canvas(256, 232)
      ctx.fillStyle = '#e8e3d5'
      ctx.fillRect(0, 0, 256, 232)
      ctx.fillStyle = '#4c5054'
      ctx.fillRect(12, 24, 232, 8)
      ctx.fillRect(12, 126, 232, 8)
      ctx.fillStyle = '#2b3638'
      ctx.fillRect(18, 32, 220, 94) // windshield
      ctx.fillStyle = 'rgba(255,255,255,0.15)'
      ctx.fillRect(30, 32, 34, 94)
      ctx.fillStyle = '#4a8c5c'
      ctx.fillRect(0, 176, 256, 22)
      ctx.fillStyle = '#3a3d3f'
      ctx.fillRect(0, 196, 256, 36)
      return c
    }
    const backCanvas = () => {
      const [c, ctx] = canvas(256, 232)
      ctx.fillStyle = '#e8e3d5'
      ctx.fillRect(0, 0, 256, 232)
      ctx.fillStyle = '#2b3638'
      ctx.fillRect(48, 34, 160, 62) // rear window
      ctx.fillStyle = '#2f4238'
      ctx.font = 'bold 26px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('SOLHEIM', 128, 142)
      ctx.fillStyle = '#4a8c5c'
      ctx.fillRect(0, 176, 256, 22)
      ctx.fillStyle = '#3a3d3f'
      ctx.fillRect(0, 196, 256, 36)
      return c
    }
    const paint = (m: HTMLCanvasElement, r = 0.55) => new THREE.MeshStandardMaterial({ map: tex(m, false), roughness: r, metalness: 0.1 })
    const bodyGeo = new THREE.BoxGeometry(W, 2.3, L)
    bodyGeo.translate(0, 1.55, 0)
    // BoxGeometry material slots are [+x, −x, +y, −y, +z, −z]
    const busBodyMats: THREE.Material[] = [
      paint(sideCanvas(false)), // +x right side
      paint(sideCanvas(true)), // −x left side (pre-mirrored canvas)
      new THREE.MeshStandardMaterial({ color: '#e8e3d5', roughness: 0.6 }), // +y roof
      new THREE.MeshStandardMaterial({ color: '#26282a', roughness: 0.9 }), // −y underside
      paint(frontCanvas()), // +z front
      paint(backCanvas()), // −z back
    ]
    const busBodyIM = new THREE.InstancedMesh(bodyGeo, busBodyMats, MAX_BUSES)
    busBodyIM.castShadow = true

    const darkGeo = mergeGeometries(
      [
        vBox(W * 1.0, 0.32, 0.4, 0, 0.5, L / 2 - 0.06),
        vBox(W * 1.0, 0.32, 0.4, 0, 0.5, -L / 2 + 0.06),
        vBox(W * 0.9, 0.1, L * 0.94, 0, 2.74, 0), // roof cap
        vBox(1.9, 0.36, 3.6, 0, 2.95, -L * 0.1), // AC pod
        vBox(0.09, 0.4, 0.3, W / 2 + 0.16, 2.4, L * 0.44), // mirrors
        vBox(0.09, 0.4, 0.3, -W / 2 - 0.16, 2.4, L * 0.44),
      ],
      false,
    )!
    const busDarkIM = new THREE.InstancedMesh(darkGeo, mats.metalDark, MAX_BUSES)
    // wheels: centered tire+hub geometry, spun per instance every frame
    const busWheelOffsets: { x: number; z: number; r: number }[] = []
    for (const wz of [L * 0.335, -L * 0.315]) {
      for (const wx of [-(W / 2 - 0.04), W / 2 - 0.04]) {
        busWheelOffsets.push({ x: wx, z: wz, r: 0.48 })
      }
    }
    // One centred tire/hub pair per instance. Repeating these inside the
    // geometry as well used to draw four coincident copies of every wheel.
    const busWheelIM = new THREE.InstancedMesh(mergeGeometries([vCyl(0.48, 0.3, 0, 0, 0, 14), vCyl(0.27, 0.32, 0, 0, 0, 8)], true)!, [mats.tire, mats.metal], MAX_BUSES * busWheelOffsets.length)
    const lampFGeos: THREE.BufferGeometry[] = []
    const lampRGeos: THREE.BufferGeometry[] = []
    for (const sx of [-1, 1]) {
      // half-embedded in the body faces — never floating
      lampFGeos.push(vBox(0.36, 0.18, 0.1, sx * W * 0.32, 0.82, L / 2 - 0.01))
      lampRGeos.push(vBox(0.3, 0.3, 0.1, sx * W * 0.36, 1.1, -L / 2 + 0.01))
    }
    const busLampFIM = new THREE.InstancedMesh(mergeGeometries(lampFGeos, false)!, mats.headlight, MAX_BUSES)
    const busLampRIM = new THREE.InstancedMesh(mergeGeometries(lampRGeos, false)!, mats.taillight, MAX_BUSES)
    // destination sign
    const [sc, sctx] = canvas(256, 48)
    sctx.fillStyle = '#0d0d0d'
    sctx.fillRect(0, 0, 256, 48)
    sctx.fillStyle = '#ffb84a'
    sctx.font = 'bold 28px Arial'
    sctx.textAlign = 'center'
    sctx.textBaseline = 'middle'
    sctx.fillText('SOLHEIM CITY BUS', 128, 25)
    const signGeo = new THREE.PlaneGeometry(1.7, 0.32)
    signGeo.translate(0, 2.52, L / 2 + 0.04)
    const busSignIM = new THREE.InstancedMesh(signGeo, new THREE.MeshBasicMaterial({ map: tex(sc, false), toneMapped: false }), MAX_BUSES)
    // curbside door leaves (plug doors) — swing out while dwelling at stops.
    // Painted doors sit at local z ≈ +4.5 (front) and −1.6 (mid) on the +x face.
    const mkDoorLeaf = (h: number, w: number, front: boolean) => {
      const frame = new THREE.BoxGeometry(0.05, h, w)
      frame.translate(0, 0, front ? -w / 2 : w / 2) // hinge at origin, leaf extends along z
      const win = new THREE.BoxGeometry(0.02, h * 0.42, w * 0.62)
      win.translate(0, h * 0.18, front ? -w / 2 : w / 2)
      return mergeGeometries([frame, win], true)!
    }
    const BUS_DOOR_Z = [4.5, -1.6]
    this.busDoorZ = BUS_DOOR_Z
    const busDoorA = new THREE.InstancedMesh(mkDoorLeaf(1.75, 0.7, true), [mats.metalDark, mats.glassDark], MAX_BUSES * 2)
    const busDoorB = new THREE.InstancedMesh(mkDoorLeaf(1.75, 0.7, false), [mats.metalDark, mats.glassDark], MAX_BUSES * 2)
    for (const im of [busBodyIM, busDarkIM, busWheelIM, busLampFIM, busLampRIM, busSignIM, busDoorA, busDoorB]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      this.group.add(im)
    }
    this.busMeshes = { body: busBodyIM, dark: busDarkIM, wheels: busWheelIM, wheelOffsets: busWheelOffsets, lampF: busLampFIM, lampR: busLampRIM, sign: busSignIM, doorA: busDoorA, doorB: busDoorB }

    const assignments = [0, 0, 1, 1, 2, 2]
    const stationStop = this.plan.stops.find(s => s.name.startsWith('Solheim Interchange'))
    for (let i = 0; i < MAX_BUSES; i++) {
      const routeIdx = assignments[i % assignments.length] % this.busPaths.length
      const path = this.busPaths[routeIdx]
      const stationIdx = stationStop ? path.stopIds.indexOf(stationStop.id) : -1
      const stationDistance = stationIdx >= 0 ? path.stopDists[stationIdx] : 0
      const nearStation = routeIdx === 0 && stationIdx >= 0
      const dist = nearStation
        ? (stationDistance - (i === 0 ? 0 : 240) + path.total) % path.total
        : this.rng() * path.total
      this.buses.push({ routeIdx, dist, speed: nearStation && i === 0 ? 0 : 8, dwell: nearStation && i === 0 ? 7 : 0, x: 0, z: 0, heading: 0, doorT: nearStation && i === 0 ? 1 : 0, brakeHold: 0 })
    }
  }

  private updateBuses(dt: number) {
    const dummy = new THREE.Object3D()
    dummy.rotation.order = 'YXZ'
    const bm = this.busMeshes
    for (let i = 0; i < this.buses.length; i++) {
      const bus = this.buses[i]
      const previousSpeed = bus.speed
      const path = this.busPaths[bus.routeIdx]
      if (!path) continue
      if (bus.dwell > 0) {
        bus.dwell -= dt
      } else {
        // smooth arrival profile: brake into the NEXT stop ahead (instead of
        // barreling past at full speed and teleport-stopping = "sneaking" look),
        // stand exactly ON the stop while doors cycle, then pull away briskly
        let dStop = Infinity
        let stopIdx = -1
        for (let k = 0; k < path.stopDists.length; k++) {
          let dd = path.stopDists[k] - bus.dist
          if (dd <= 0.01) dd += path.total
          if (dd < dStop) { dStop = dd; stopIdx = k }
        }
        if (dStop < 14) {
          const vTarget = Math.max(1.3, Math.sqrt(2 * 2.6 * Math.max(0.5, dStop - 0.6)))
          bus.speed = bus.speed > vTarget ? Math.max(vTarget, bus.speed - 3.2 * dt) : Math.min(vTarget, bus.speed + 2 * dt)
        } else {
          bus.speed = Math.min(bus.speed + 2 * dt, 8.5)
        }
        const step = bus.speed * dt
        if (stopIdx >= 0 && dStop <= step + 0.05) {
          bus.dist = path.stopDists[stopIdx]
          bus.dwell = 3.5
          bus.speed = 0
        } else {
          bus.dist += step
          if (bus.dist >= path.total) bus.dist -= path.total
        }
      }
      // position along loop
      let d = bus.dist
      let segIdx = 0
      while (segIdx < path.cum.length - 2 && path.cum[segIdx + 1] < d) segIdx++
      const a = path.pts[segIdx % path.pts.length]
      const b = path.pts[(segIdx + 1) % path.pts.length]
      const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 1
      const t = (d - path.cum[segIdx]) / segLen
      // right-side offset 2.6
      const ux = (b.x - a.x) / segLen
      const uz = (b.z - a.z) / segLen
      bus.x = a.x + (b.x - a.x) * t - uz * 2.6
      bus.z = a.z + (b.z - a.z) * t + ux * 2.6
      bus.heading = Math.atan2(ux, uz)

      if (!bm) continue
      dummy.position.set(bus.x, 0, bus.z)
      dummy.rotation.set(0, bus.heading, 0)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      bm.body.setMatrixAt(i, dummy.matrix)
      bm.dark.setMatrixAt(i, dummy.matrix)
      bm.lampF.setMatrixAt(i, dummy.matrix)
      bm.sign.setMatrixAt(i, dummy.matrix)
      bus.brakeHold = bus.dwell > 0 || bus.speed < previousSpeed - .001 || bus.speed < .15
        ? .18 : Math.max(0, bus.brakeHold - dt)
      bm.lampR.setMatrixAt(i, dummy.matrix)
      // doors: open while dwelling, close just before departure
      const doorTarget = bus.dwell > 0.8 ? 1 : 0
      bus.doorT += (doorTarget - bus.doorT) * Math.min(1, dt * 5)
      const open = bus.doorT * 0.95 // max swing angle (rad)
      const cosHb = Math.cos(bus.heading)
      const sinHb = Math.sin(bus.heading)
      for (let d = 0; d < 2; d++) {
        const dz = this.busDoorZ[d]
        const hx = -(this.busW / 2 + 0.035) // doors on the curb side in right-hand traffic
        // leaf A: hinged at the door's front edge, extends −z, swings +x when open
        let lx = cosHb * hx + sinHb * (dz + 0.7)
        let lz = -sinHb * hx + cosHb * (dz + 0.7)
        dummy.position.set(bus.x + lx, 1.58, bus.z + lz)
        dummy.rotation.set(0, bus.heading + open, 0)
        dummy.updateMatrix()
        bm.doorA.setMatrixAt(i * 2 + d, dummy.matrix)
        // leaf B: hinged at the rear edge, extends +z, swings +x when open
        lx = cosHb * hx + sinHb * (dz - 0.7)
        lz = -sinHb * hx + cosHb * (dz - 0.7)
        dummy.position.set(bus.x + lx, 1.58, bus.z + lz)
        dummy.rotation.set(0, bus.heading - open, 0)
        dummy.updateMatrix()
        bm.doorB.setMatrixAt(i * 2 + d, dummy.matrix)
      }
      // spinning wheels
      const cosH = Math.cos(bus.heading)
      const sinH = Math.sin(bus.heading)
      for (let wi = 0; wi < bm.wheelOffsets.length; wi++) {
        const w = bm.wheelOffsets[wi]
        const rx = cosH * w.x + sinH * w.z
        const rz = -sinH * w.x + cosH * w.z
        dummy.position.set(bus.x + rx, w.r, bus.z + rz)
        dummy.rotation.set(bus.dist / w.r, bus.heading, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        bm.wheels.setMatrixAt(i * bm.wheelOffsets.length + wi, dummy.matrix)
      }
    }
    if (bm) {
      for (const im of [bm.body, bm.dark, bm.wheels, bm.lampF, bm.lampR, bm.sign, bm.doorA, bm.doorB]) {
        im.instanceMatrix.needsUpdate = true
      }
    }
  }

  /* ---------------- trams ---------------- */
  /* Realistic double-ended articulated tram, built like the cars:
   * per-material groups (canvas livery body, skirt, roof + pantograph,
   * bogies with spinning wheels, lamps) drawn as InstancedMeshes.
   * Segment layout: [cab (outward −Z)] [middle + pantograph] [cab (outward +Z)] */
  private tramParts: {
    cabF: THREE.InstancedMesh // leading-end cab when heading is +local Z
    cabB: THREE.InstancedMesh // trailing-end cab (mirror)
    mid: THREE.InstancedMesh
    midTop: THREE.InstancedMesh // AC pod + pantograph
    skirtF: THREE.InstancedMesh
    skirtB: THREE.InstancedMesh
    diaphragm: THREE.InstancedMesh
    wheels: THREE.InstancedMesh
    lampF: THREE.InstancedMesh | null
    lampR: THREE.InstancedMesh | null
    wheelOffsets: { x: number; z: number; r: number }[]
    midDoorA: THREE.InstancedMesh // mid-segment door leaves, hinged front edge
    midDoorB: THREE.InstancedMesh // hinged rear edge
  }[] = []

  private tramCanvas(kind: 'sideA' | 'sideB' | 'front' | 'back' | 'mid', accent: string, flip: boolean): HTMLCanvasElement {
    const [c, ctx] = canvas(1024, 256)
    if (flip) {
      ctx.translate(1024, 0)
      ctx.scale(-1, 1)
    }
    ctx.fillStyle = '#e9e4d6'
    ctx.fillRect(0, 0, 1024, 256)
    ctx.fillStyle = '#3a3d3f'
    ctx.fillRect(0, 226, 1024, 30) // skirt
    ctx.fillStyle = accent
    ctx.fillRect(0, 204, 1024, 22) // route stripe
    if (kind === 'front' || kind === 'back') {
      // cab end: big windshield + destination board
      ctx.fillStyle = '#4c5054'
      ctx.fillRect(28, 30, 968, 14)
      ctx.fillStyle = '#20282a'
      ctx.fillRect(70, 54, 884, 96) // windshield
      ctx.fillStyle = 'rgba(255,255,255,0.15)'
      ctx.fillRect(90, 54, 60, 96)
      ctx.fillStyle = '#10160f'
      ctx.fillRect(292, 6, 440, 40)
      ctx.fillStyle = '#ffb84a'
      ctx.font = 'bold 30px Arial'
      ctx.textAlign = 'center'
      ctx.fillText(kind === 'front' ? '1 · CENTRAL HUB' : 'SOLHEIM', 512, 34)
      ctx.fillStyle = accent
      ctx.fillRect(0, 204, 1024, 22)
      ctx.fillStyle = '#3a3d3f'
      ctx.fillRect(0, 226, 1024, 30)
      return c
    }
    // side walls: window band + doors
    const winY = 48
    const winH = 88
    const drawWin = (wx: number, w: number) => {
      ctx.fillStyle = '#4c5054'
      ctx.fillRect(wx - 5, winY - 5, w + 10, winH + 10)
      ctx.fillStyle = '#2b3638'
      ctx.fillRect(wx, winY, w, winH)
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      ctx.fillRect(wx + 8, winY, 20, winH)
    }
    if (kind === 'mid') {
      // doors at the articulation ends + long window band
      for (const dx of [40, 906]) {
        ctx.fillStyle = '#4c5054'
        ctx.fillRect(dx - 5, winY - 5, 84, 158)
        ctx.fillStyle = '#33413f'
        ctx.fillRect(dx, winY, 74, 148)
        ctx.fillStyle = '#e9e4d6'
        ctx.fillRect(dx + 35, winY, 5, 148)
      }
      drawWin(150, 700)
    } else {
      // cab side: door + windows; route number roundel
      ctx.fillStyle = '#4c5054'
      ctx.fillRect(56, winY - 5, 84, 158)
      ctx.fillStyle = '#33413f'
      ctx.fillRect(61, winY, 74, 148)
      ctx.fillStyle = '#e9e4d6'
      ctx.fillRect(96, winY, 5, 148)
      drawWin(170, 300)
      drawWin(500, 320)
      ctx.save()
      ctx.translate(940, 180)
      if (flip) ctx.scale(-1, 1)
      ctx.fillStyle = '#2f4238'
      ctx.font = 'bold 34px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('SOLHEIM', 0, 0)
      ctx.restore()
    }
    return c
  }

  private buildTramSegments(mats: CityMaterials, accent: string) {
    const L = 9.3
    const W = 2.3
    const paint = (m: HTMLCanvasElement, r = 0.45) => new THREE.MeshStandardMaterial({ map: tex(m, false), roughness: r, metalness: 0.25 })
    const mkBody = (kind: 'sideA' | 'sideB' | 'front' | 'back' | 'mid', front: boolean) => {
      const geo = new THREE.BoxGeometry(W, 2.45, L)
      geo.translate(0, 2.0, 0)
      const sideA = paint(this.tramCanvas(kind === 'mid' ? 'mid' : 'sideA', accent, false))
      const sideB = paint(this.tramCanvas(kind === 'mid' ? 'mid' : 'sideB', accent, true))
      const frontMat = paint(this.tramCanvas(front ? 'front' : 'back', accent, false))
      const backMat = paint(this.tramCanvas(front ? 'back' : 'front', accent, false))
      // BoxGeometry slots: [+x, −x, +y, −y, +z, −z]
      return new THREE.InstancedMesh(
        geo,
        [sideA, sideB, new THREE.MeshStandardMaterial({ color: '#d5d0c0', roughness: 0.55 }), new THREE.MeshStandardMaterial({ color: '#26282a', roughness: 0.9 }), frontMat, backMat],
        2,
      )
    }
    const cabF = mkBody('sideA', true)
    const cabB = mkBody('sideA', false)
    const mid = mkBody('mid', true)
    for (const im of [cabF, cabB, mid]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      im.castShadow = true
      this.group.add(im)
    }
    // roof furniture: pantograph on the middle segment
    const midTopGeo = mergeGeometries(
      [
        vBox(1.6, 0.1, 2.6, 0, 3.32, 0.8), // AC pod
        vBox(0.06, 0.06, 1.7, 0, 3.62, -1.6), // roof rib
        vBox(0.05, 1.15, 0.05, -0.35, 3.95, -0.6), // pantograph arms
        vBox(0.05, 1.15, 0.05, 0.35, 3.95, 0.6),
        vBox(1.5, 0.05, 0.4, 0, 4.52, 0), // collector shoe
        vBox(0.05, 0.5, 0.05, 0, 3.62, 0), // base insulator
      ],
      false,
    )!
    const midTop = new THREE.InstancedMesh(midTopGeo, mats.metalDark, 2)
    midTop.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    midTop.frustumCulled = false
    this.group.add(midTop)
    // diaphragms between segments
    const diaphragm = new THREE.InstancedMesh(mergeGeometries([vBox(1.9, 2.3, 1.05, 0, 1.95, 0)], false)!, mats.metalDark, 4)
    diaphragm.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    diaphragm.frustumCulled = false
    this.group.add(diaphragm)
    // skirt + bogies (dark) — one IM per segment role with 2 instances
    const skirtGeo = mergeGeometries(
      [vBox(W + 0.08, 0.55, L * 0.94, 0, 0.62, 0), vBox(1.7, 0.5, 1.9, 0, 0.5, 2.9), vBox(1.7, 0.5, 1.9, 0, 0.5, -2.9)],
      false,
    )!
    const skirtF = new THREE.InstancedMesh(skirtGeo, mats.metalDark, 2)
    const skirtB = new THREE.InstancedMesh(skirtGeo, mats.metalDark, 2)
    for (const im of [skirtF, skirtB]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      this.group.add(im)
    }
    // wheels: 2 bogies × 2 wheels per segment, 3 segments, 2 trams per route
    const wheelOffsets: { x: number; z: number; r: number }[] = []
    for (let seg = 0; seg < 3; seg++) {
      const segOff = (seg - 1) * 10.0
      for (const bz of [2.9, -2.9]) {
        for (const wx of [-(W / 2 - 0.08), W / 2 - 0.08]) {
          wheelOffsets.push({ x: wx, z: segOff + bz, r: 0.4 })
        }
      }
    }
    // The 12 wheel positions belong in instance matrices, not in 12 copies
    // of the same centred geometry inside every instance.
    const wheels = new THREE.InstancedMesh(mergeGeometries([vCyl(0.4, 0.24, 0, 0, 0, 12), vCyl(0.22, 0.26, 0, 0, 0, 8)], true)!, [mats.tire, mats.metal], 2 * wheelOffsets.length)
    wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    wheels.frustumCulled = false
    this.group.add(wheels)
    // head/tail lamps on the cab faces (half-embedded)
    const lampFGeos: THREE.BufferGeometry[] = []
    const lampRGeos: THREE.BufferGeometry[] = []
    for (const sx of [-1, 1]) {
      lampFGeos.push(vBox(0.34, 0.16, 0.1, sx * W * 0.3, 1.12, L / 2 - 0.02))
      lampRGeos.push(vBox(0.3, 0.16, 0.1, sx * W * 0.3, 1.12, -L / 2 + 0.02))
    }
    const lampF = new THREE.InstancedMesh(mergeGeometries(lampFGeos, false)!, mats.headlight, 2)
    const lampR = new THREE.InstancedMesh(mergeGeometries(lampRGeos, false)!, mats.taillight, 2)
    for (const im of [lampF, lampR]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      this.group.add(im)
    }
    // mid-segment door leaves (painted doors sit at local z ≈ ±3.95, both sides)
    const mkTramLeaf = (front: boolean) => {
      const frame = new THREE.BoxGeometry(0.05, 1.45, 0.62)
      frame.translate(0, 0, front ? -0.31 : 0.31)
      const win = new THREE.BoxGeometry(0.02, 0.62, 0.4)
      win.translate(0, 0.28, front ? -0.31 : 0.31)
      return mergeGeometries([frame, win], true)!
    }
    const TRAM_DOORS = 4 // ±3.95 × both sides, per tram
    const midDoorA = new THREE.InstancedMesh(mkTramLeaf(true), [mats.metalDark, mats.glassDark], 2 * TRAM_DOORS)
    const midDoorB = new THREE.InstancedMesh(mkTramLeaf(false), [mats.metalDark, mats.glassDark], 2 * TRAM_DOORS)
    for (const im of [midDoorA, midDoorB]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      this.group.add(im)
    }
    this.tramParts.push({ cabF, cabB, mid, midTop, skirtF, skirtB, diaphragm, wheels, lampF, lampR, wheelOffsets, midDoorA, midDoorB })
  }

  private buildTrams(mats: CityMaterials) {
    const accents = ['#16a34a', '#ea580c']
    for (const route of this.plan.routes) {
      if (route.mode !== 'tram') continue
      const a = route.points[0]
      const b = route.points[1]
      const axis: 'x' | 'z' = Math.abs(b.x - a.x) > Math.abs(b.z - a.z) ? 'x' : 'z'
      const stops = route.stopIds
        .map((sid) => this.plan.stops.find((s) => s.id === sid))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => (axis === 'x' ? s.x : s.z))
        .sort((p, q) => p - q)
      this.tramPaths.push({ axis, coord: axis === 'x' ? a.z : a.x, from: axis === 'x' ? a.x : a.z, to: axis === 'x' ? b.x : b.z, len: Math.abs((axis === 'x' ? b.x : b.z) - (axis === 'x' ? a.z === 0 ? a.z : a.z : 0)) || Math.abs(b.x - a.x) + Math.abs(b.z - a.z), stops })
    }
    // fix len properly
    this.tramPaths.forEach((tp) => {
      tp.len = Math.abs(tp.to - tp.from)
    })
    if (this.tramPaths.length === 0) return

    // one set of segment meshes per route (accent colour in the livery)
    for (let r = 0; r < this.tramPaths.length; r++) {
      this.buildTramSegments(mats, accents[r % accents.length])
    }

    // 2 trams per line, opposite directions, offset along the line
    for (let i = 0; i < MAX_TRAMS; i++) {
      const pathIdx = i % this.tramPaths.length
      const perLineIdx = Math.floor(i / this.tramPaths.length)
      const path = this.tramPaths[pathIdx]
      this.trams.push({
        routeIdx: pathIdx,
        dist: (0.2 + perLineIdx * 0.5) * path.len,
        dir: perLineIdx === 0 ? 1 : -1,
        speed: 8,
        dwell: 0,
        x: 0,
        z: 0,
        heading: 0,
        odo: 0,
        slot: 0,
        doorT: 0,
      })
    }
    // per-tram slot within its route's mesh set (2 trams per route)
    const perRoute = new Map<number, number>()
    for (const tram of this.trams) {
      const n = perRoute.get(tram.routeIdx) ?? 0
      tram.slot = n
      perRoute.set(tram.routeIdx, n + 1)
    }
  }

  private updateTrams(dt: number) {
    const dummy = new THREE.Object3D()
    dummy.rotation.order = 'YXZ'
    for (let i = 0; i < this.trams.length; i++) {
      const tram = this.trams[i]
      const path = this.tramPaths[tram.routeIdx]
      const parts = this.tramParts[tram.routeIdx]
      if (!path || !parts) continue
      if (tram.dwell > 0) {
        tram.dwell -= dt
      } else {
        // smooth arrival profile: brake into the next stop ahead (the old
        // check required speed < 2.2 while target speed was always 8 →
        // trams blew through every station without ever opening a door)
        let dStop = Infinity
        let dConflict = Infinity
        const along = path.from + tram.dist
        for (const car of this.activeConnectors) {
          if (!car.conn) continue
          const bounds = this.railBounds(car.conn, tram.routeIdx, tram.dir)
          if (!bounds) continue
          const distance = tram.dir > 0 ? bounds.lo - along - 17 : along - bounds.hi - 17
          if (distance >= 0) dConflict = Math.min(dConflict, distance)
        }
        for (const sp of path.stops) {
          const sd = Math.abs(sp - path.from)
          const dd = (sd - tram.dist) * tram.dir
          if (dd > 0.01 && dd < dStop) dStop = dd
        }
        if (dStop < 12) {
          const vTarget = Math.max(1.2, Math.sqrt(2 * 2.4 * Math.max(0.4, dStop - 0.5)))
          tram.speed = tram.speed > vTarget ? Math.max(vTarget, tram.speed - 3.0 * dt) : Math.min(vTarget, tram.speed + 2.2 * dt)
        } else {
          tram.speed += Math.sign(8 - tram.speed) * Math.min(Math.abs(8 - tram.speed), 2.2 * dt)
        }
        if (dConflict < 30) tram.speed = Math.min(tram.speed, Math.sqrt(2 * 3 * Math.max(0, dConflict)))
        const step = Math.min(tram.speed * dt, dConflict)
        tram.odo += step
        if (dStop <= step + 0.05) {
          // snap onto the stop we were approaching
          let best = tram.dist
          let bd = Infinity
          for (const sp of path.stops) {
            const sd = Math.abs(sp - path.from)
            const dd = Math.abs(sd - tram.dist)
            if (dd < bd) { bd = dd; best = sd }
          }
          tram.dist = best
          tram.dwell = 4
          tram.speed = 0
        } else {
          tram.dist += step * tram.dir
          if (tram.dist >= path.len) { tram.dist = path.len; tram.dir = -1 }
          if (tram.dist <= 0) { tram.dist = 0; tram.dir = 1 }
        }
      }
      const along = path.from + tram.dist
      // double track: each direction keeps right on its own track (±1.6 m),
      // so the two trams of a line never meet head-on on the same rails
      if (path.axis === 'x') {
        tram.x = along
        tram.z = path.coord + (tram.dir > 0 ? 1.6 : -1.6)
        tram.heading = tram.dir > 0 ? Math.PI / 2 : -Math.PI / 2
      } else {
        tram.x = path.coord + (tram.dir > 0 ? -1.6 : 1.6)
        tram.z = along
        tram.heading = tram.dir > 0 ? 0 : Math.PI
      }
      // heading follows the atan2(dx,dz) convention (same as cars/buses):
      // local +Z is forward → world offset = (sin h, cos h).
      // (the old cos/sin swap laid the 3 segments SIDE BY SIDE across the track)
      const sinH = Math.sin(tram.heading)
      const cosH = Math.cos(tram.heading)
      const slot = tram.slot
      // segment placement: cabB at −10, mid at 0, cabF at +10 (heading = travel)
      const segs: [THREE.InstancedMesh, number][] = [
        [parts.cabB, -10.0],
        [parts.mid, 0],
        [parts.cabF, 10.0],
      ]
      for (const [im, off] of segs) {
        dummy.position.set(tram.x + sinH * off, 0, tram.z + cosH * off)
        dummy.rotation.set(0, tram.heading, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        im.setMatrixAt(slot, dummy.matrix)
        if (off !== 0) {
          // skirts ride with the cab segments
          ;(off > 0 ? parts.skirtF : parts.skirtB).setMatrixAt(slot, dummy.matrix)
        } else {
          parts.midTop.setMatrixAt(slot, dummy.matrix)
        }
      }
      // diaphragms at ±5 (mid segment is 9.3 long → gap spans 4.65..5.35)
      for (let d = 0; d < 2; d++) {
        const off = d === 0 ? -5.0 : 5.0
        dummy.position.set(tram.x + sinH * off, 0, tram.z + cosH * off)
        dummy.rotation.set(0, tram.heading, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        parts.diaphragm.setMatrixAt(slot * 2 + d, dummy.matrix)
      }
      // lamps on the outward cab faces
      dummy.scale.setScalar(1)
      for (const [im, off] of [[parts.lampF, 10.0], [parts.lampR, -10.0]] as [THREE.InstancedMesh | null, number][]) {
        if (!im) continue
        dummy.position.set(tram.x + sinH * off, 0, tram.z + cosH * off)
        dummy.rotation.set(0, tram.heading, 0)
        dummy.updateMatrix()
        im.setMatrixAt(slot, dummy.matrix)
      }
      // spinning wheels
      for (let wi = 0; wi < parts.wheelOffsets.length; wi++) {
        const w = parts.wheelOffsets[wi]
        const rx = cosH * w.x + sinH * w.z
        const rz = -sinH * w.x + cosH * w.z
        dummy.position.set(tram.x + rx, w.r, tram.z + rz)
        dummy.rotation.set(tram.odo / w.r, tram.heading, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        parts.wheels.setMatrixAt(slot * parts.wheelOffsets.length + wi, dummy.matrix)
      }
      // mid-segment doors swing open while dwelling (both sides, z ±3.95)
      const doorTarget = tram.dwell > 0.8 ? 1 : 0
      tram.doorT += (doorTarget - tram.doorT) * Math.min(1, dt * 5)
      const openT = tram.doorT * 0.9
      const doorDefs: [number, number][] = [
        [3.95, 1], [-3.95, 1], [3.95, -1], [-3.95, -1], // [local z, side ±x]
      ]
      for (let d = 0; d < doorDefs.length; d++) {
        const [dz, side] = doorDefs[d]
        const hx = side * (1.2)
        // leaf A: hinged front edge; swing outward = away from the body
        const sA = side > 0 ? -openT : openT
        let lx = cosH * hx + sinH * (dz + 0.62)
        let lz = -sinH * hx + cosH * (dz + 0.62)
        dummy.position.set(tram.x + lx, 1.95, tram.z + lz)
        dummy.rotation.set(0, tram.heading + sA, 0)
        dummy.updateMatrix()
        parts.midDoorA.setMatrixAt(slot * 4 + d, dummy.matrix)
        const sB = side > 0 ? openT : -openT
        lx = cosH * hx + sinH * (dz - 0.62)
        lz = -sinH * hx + cosH * (dz - 0.62)
        dummy.position.set(tram.x + lx, 1.95, tram.z + lz)
        dummy.rotation.set(0, tram.heading + sB, 0)
        dummy.updateMatrix()
        parts.midDoorB.setMatrixAt(slot * 4 + d, dummy.matrix)
      }
    }
    for (const parts of this.tramParts) {
      for (const im of [parts.cabF, parts.cabB, parts.mid, parts.midTop, parts.skirtF, parts.skirtB, parts.diaphragm, parts.wheels, parts.lampF, parts.lampR, parts.midDoorA, parts.midDoorB]) {
        if (im) im.instanceMatrix.needsUpdate = true
      }
    }
  }

  /** pick a lane whose start is clear of other cars (and optionally far
   *  enough from the player to hide a respawn pop-in) */
  private randomFreeLane(minPlayerDist = 0): string {
    let fallback = this.laneList[Math.floor(this.rng() * this.laneList.length)]
    for (let t = 0; t < 10; t++) {
      const id = this.laneList[Math.floor(this.rng() * this.laneList.length)]
      const seg = this.network.lanes.get(id)
      if (!seg) continue
      fallback = id
      if (minPlayerDist > 0 && Math.hypot(seg.x1 - this.playerX, seg.z1 - this.playerZ) < minPlayerDist) continue
      let clear = true
      for (const c of this.cars) {
        if (c.segId === id && c.dist < 9) {
          clear = false
          break
        }
      }
      if (clear) return id
    }
    return fallback
  }

  private carLength(car: CarState): number {
    return [4.5, 4.65, 5.3, 7.6, 8.2][car.typeIdx] ?? 4.5
  }

  /** Reserve conflicting paths before entering. Opposing straight lanes can
   * proceed together, but turns and cross traffic must clear the shared box. */
  private connectorClear(car: CarState, candidate: ConnPath): boolean {
    if (!this.tramClear(candidate)) return false
    for (const other of this.activeConnectors) {
      const occupied = other.conn ?? other.tail
      if (other === car || !occupied) continue
      const progress = other.conn ? other.connDist : occupied.len + other.dist
      if (candidate === occupied) {
        // Same movement can discharge at a safe following headway instead of
        // serializing every car for the full length of the junction.
        const lane = this.network.lanes.get(car.segId)!
        const remaining = Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1) - car.dist
        if (progress + remaining < (this.carLength(car) + this.carLength(other)) / 2 + 1.8 + car.speed * 0.6) return false
        continue
      }
      let conflicts = this.conflictCache.get(candidate)
      if (!conflicts) this.conflictCache.set(candidate, conflicts = new WeakMap())
      let conflictEnd = conflicts.get(occupied)
      if (conflictEnd === undefined) {
        conflictEnd = this.conflictEnd(candidate, occupied)
        conflicts.set(occupied, conflictEnd)
      }
      // The occupied car's rear has passed this movement's shared area. Other
      // turns may enter now even while it continues towards a different exit.
      if (conflictEnd >= 0 && progress - this.carLength(other) / 2 < conflictEnd + 1.4) return false
    }
    return true
  }

  private tramClear(candidate: ConnPath): boolean {
    const horizon = candidate.len / (candidate.straight ? 8 : 4.6) + 2.5
    for (const tram of this.trams) {
      const track = this.tramPaths[tram.routeIdx]
      const bounds = this.railBounds(candidate, tram.routeIdx, tram.dir)
      if (!bounds) continue
      const along = track.from + tram.dist
      const future = along + tram.dir * 8 * horizon
      if (Math.max(along, future) >= bounds.lo - 17 && Math.min(along, future) <= bounds.hi + 17) return false
    }
    return true
  }

  private railBounds(candidate: ConnPath, route: number, direction: number) {
    let cached = this.railCrossings.get(candidate)
    if (!cached) this.railCrossings.set(candidate, cached = new Map())
    const key = `${route}:${direction}`
    if (cached.has(key)) return cached.get(key)!
    const track = this.tramPaths[route]
    const lateral = track.coord + (track.axis === 'x' ? direction : -direction) * 1.6
    const crossing = this.samples(candidate).filter(p => Math.abs((track.axis === 'x' ? p.z : p.x) - lateral) < 2.55)
    const bounds = crossing.length ? {
      lo: Math.min(...crossing.map(p => track.axis === 'x' ? p.x : p.z)),
      hi: Math.max(...crossing.map(p => track.axis === 'x' ? p.x : p.z)),
    } : null
    cached.set(key, bounds)
    return bounds
  }

  private samples(path: ConnPath) {
    let samples = this.pathSamples.get(path)
    if (samples) return samples
    samples = []
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i - 1], b = path.pts[i]
      const length = path.cum[i] - path.cum[i - 1]
      const count = Math.max(1, Math.ceil(length / 0.75))
      for (let j = 0; j <= count; j++) {
        const t = j / count
        samples.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, d: path.cum[i - 1] + length * t })
      }
    }
    this.pathSamples.set(path, samples)
    return samples
  }

  /** Last distance on occupied's centreline that overlaps candidate's swept
   * corridor. Sampling adds a conservative 0.75m margin to the conflict zone;
   * vehicle length and a further rear clearance are applied on release. */
  private conflictEnd(candidate: ConnPath, occupied: ConnPath): number {
    let end = -1
    // Long trucks sweep outside the centreline on tight curves. Keep a wider
    // corridor for turns while allowing opposing straight lanes in parallel.
    const corridor = candidate.straight && occupied.straight ? 3.2 : 5
    for (const b of this.samples(occupied)) {
      if (this.samples(candidate).some(a => (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < corridor ** 2)) end = Math.max(end, b.d + 0.75)
    }
    return end
  }

  /** Reserve enough downstream storage for every car already committed to
   * this exit. Moving platoons may share a turn; a stopped queue may not spill
   * back into the box. Use actual vehicle lengths, not a worst-case truck. */
  private exitClear(car: CarState, nid: string): boolean {
    let reserved = 0
    for (const other of this.cars) {
      if (other !== car && other.conn && other.connNext === nid) reserved += this.carLength(other) + 1.8
    }
    const lane = this.network.lanes.get(nid)
    if (!lane || reserved + this.carLength(car) + 4 > Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1)) return false
    for (const other of this.cars) {
      if (other !== car && !other.conn && other.segId === nid
        && other.dist < reserved + (this.carLength(car) + this.carLength(other)) / 2 + 1.8) return false
    }
    return true
  }

  /** QA/debug: per-car live state for jam analysis (window.__cityEngine) */
  getJamStats(): { x: number; z: number; speed: number; jammed: number; forced: number; typeIdx: number }[] {
    return this.cars.map((c) => ({ x: c.x, z: c.z, speed: c.speed, jammed: c.jammed, forced: c.forced, typeIdx: c.typeIdx }))
  }

  /* ---------------- main update ---------------- */
  private signalColorTimer = 0

  /** Also called while paused, so dusk changes lights without moving traffic. */
  updateLightAppearance(night: number) {
    this.lightNight = night
    const on = THREE.MathUtils.smoothstep(night, .05, .4)
    this.headTint.setScalar(.15 + .85 * on)
    for (const car of this.cars) {
      const meshes = this.carMeshes[car.typeIdx]
      if (!meshes) continue
      meshes.lampF?.setColorAt(car.slot, this.headTint)
      this.tailTint.setScalar(car.brakeHold > 0 ? 1 : .07 + .25 * on)
      meshes.lampR?.setColorAt(car.slot, this.tailTint)
    }
    if (this.busMeshes) for (let i = 0; i < this.buses.length; i++) {
      this.busMeshes.lampF.setColorAt(i, this.headTint)
      this.tailTint.setScalar(this.buses[i].brakeHold > 0 ? 1 : .07 + .25 * on)
      this.busMeshes.lampR.setColorAt(i, this.tailTint)
    }
    this.tailTint.setScalar(.07 + .25 * on)
    for (const part of this.tramParts) for (const lamp of [part.lampF, part.lampR]) {
      if (!lamp) continue
      for (let i = 0; i < lamp.count; i++) lamp.setColorAt(i, lamp === part.lampF ? this.headTint : this.tailTint)
    }
    for (const meshes of [...this.carMeshes, this.busMeshes, ...this.tramParts]) {
      if (!meshes) continue
      for (const lamp of [meshes.lampF, meshes.lampR]) if (lamp?.instanceColor) lamp.instanceColor.needsUpdate = true
    }
  }

  getHeadlampEmitters(): HeadlampEmitter[] {
    const emitters = this.cars.flatMap((car, id) => {
      const geometry = this.carMeshes[car.typeIdx]?.lampF?.geometry
      return geometry ? [{ id, x: car.x, z: car.z, heading: car.heading, lamps: headlampAnchors(geometry) }] : []
    })
    if (this.busMeshes) {
      const lamps = headlampAnchors(this.busMeshes.lampF.geometry)
      this.buses.forEach((bus, i) => emitters.push({ id: MAX_TRAFFIC_VEHICLES + i, x: bus.x, z: bus.z, heading: bus.heading, lamps }))
    }
    return emitters
  }

  update(dt: number, playerPos: THREE.Vector3, night: number, writeCarMatrices = true) {
    this.playerX = playerPos.x
    this.playerZ = playerPos.z
    this.router.sense(this.cars, this.simTime)
    this.updateSignals(dt)
    this.updateCars(dt, night, writeCarMatrices)
    this.recordMetrics(dt)
    this.updateBuses(dt)
    this.updateTrams(dt)
    this.refreshSignalColors(dt)
    this.updateLightAppearance(night)
    // Every scenario represents a persistent network-wide population. Avoid
    // camera-relative relocation so overview/spectator cameras do not rewrite
    // demand or create/erase queues while the simulation runs.
  }

  private refreshSignalColors(dt: number) {
    this.signalColorTimer -= dt
    if (this.signalColorTimer > 0) return
    this.signalColorTimer = 0.12
    const sm = this.signalMeshes[0]
    if (!sm?.lampIM) return
    let li = 0
    for (const sg of this.network.signals) {
      const st = this.signalState.get(sg.id)
      const phase = st && st.t > 0 ? sg.phases[st.phase] : null
      const axisNow = phase?.movement !== 'left' ? phase?.greenAxis : null
      for (const h of sg.heads) {
        // the head's axis comes from the network data (NOT the loop index —
        // the old li%2 guess showed half the heads the wrong phase)
        const headAxis = h.axis
        const green = axisNow === headAxis ? '#2ecc40' : '#123a16'
        const amber = '#4a3a10'
        sm.lampIM.setColorAt(li * 3 + 0, new THREE.Color(axisNow === headAxis ? '#3a1512' : '#ff4136'))
        sm.lampIM.setColorAt(li * 3 + 1, new THREE.Color(amber))
        sm.lampIM.setColorAt(li * 3 + 2, new THREE.Color(green))
        sm.arrowIM.setColorAt(li, new THREE.Color(phase?.movement === 'left' && phase.greenAxis === headAxis ? '#2ecc40' : '#123a16'))
        li++
      }
    }
    if (sm.lampIM.instanceColor) sm.lampIM.instanceColor.needsUpdate = true
    if (sm.arrowIM.instanceColor) sm.arrowIM.instanceColor.needsUpdate = true
  }
}
