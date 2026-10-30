/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { planCity, roadHalfWidth } from '../src/lib/city/planner'
import { buildRoadNetwork } from '../src/lib/city/roads'
import { createCrosswalkStripes } from '../src/lib/city/roads'
import { TrafficSystem } from '../src/lib/city/traffic'
import { TRAFFIC_PRESETS } from '../src/lib/city/traffic-config'
import type { CityMaterials, ConnPath, LaneSeg, RoadNetworkData, SignalGroup } from '../src/lib/city/types'
import { THROUGH_STOP_STAGGER, TURN_POCKET_LENGTH, TURN_TAPER_LENGTH } from '../src/lib/city/junctions'

const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient,
  set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
const mat = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => mat }, { get: (target, key) => key in target ? target.signMaterial : mat }) as unknown as CityMaterials
const plan = planCity()
const viewer = new THREE.Vector3(0, 1.7, 0)

type Car = {
  segId: string; dist: number; odo: number; speed: number; typeIdx: number; slot: number; paint: number
  x: number; z: number; heading: number; stopped: boolean; conn: ConnPath | null; connNext: string
  plannedNext: string | null; afterPocket: string | null; connDist: number; tail: ConnPath | null
  stuck: number; creep: number; jammed: number; forced: number; serveT: number; serveCd: number
}
type TrafficHarness = {
  cars: Car[]; trams: unknown[]; tramPaths: unknown[]; signalState: Map<string, { phase: number; t: number; elapsed: number; gap: number }>
  completedSegments: number; activeConnectors: Set<Car>; config: unknown
  updateCars(dt: number, night: number): void
  connectorClear(car: Car, path: ConnPath): boolean
  exitClear(car: Car, lane: string): boolean
}

const carLength = (car: Car) => [4.5, 4.65, 5.3, 7.6, 8.2][car.typeIdx] ?? 4.5
const laneLength = (lane: LaneSeg) => Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1)
const axisOf = (lane: LaneSeg): 'x' | 'z' => Math.abs(lane.x2 - lane.x1) > Math.abs(lane.z2 - lane.z1) ? 'x' : 'z'
const direction = (lane: LaneSeg) => {
  const length = laneLength(lane)
  return { x: (lane.x2 - lane.x1) / length, z: (lane.z2 - lane.z1) / length }
}
const crossTurn = (from: LaneSeg, to: LaneSeg) => {
  const a = direction(from)
  return a.x * (to.z2 - to.z1) - a.z * (to.x2 - to.x1)
}
const makeTraffic = (network: RoadNetworkData) => new TrafficSystem(plan, network, mats) as unknown as TrafficHarness

function coreApproach(network: RoadNetworkData, signal: Pick<SignalGroup, 'id'>, axis = 'x' as const, incomingDirection = 1) {
  const incoming = [...network.lanes.values()].filter(lane => lane.signalId === signal.id && axisOf(lane) === axis
    && (axis === 'x' ? Math.sign(lane.x2 - lane.x1) : Math.sign(lane.z2 - lane.z1)) === incomingDirection
    && (lane.pocket === undefined || lane.pocket === 'left'))
  if (incoming[0]?.pocket) {
    const pocket = incoming[0]
    const approach = network.lanes.get(pocket.approachLane!)!
    const leftPocket = [...network.lanes.values()].find(l => l.approachLane === approach.id && l.pocket === 'left')!
    const throughPocket = [...network.lanes.values()].find(l => l.approachLane === approach.id && l.pocket === 'through-right')!
    const exits = approach.routeChoices!
    const left = exits.find(id => crossTurn(approach, network.lanes.get(id)!) < -1)!
    const straight = exits.find(id => {
      const a = direction(approach), b = direction(network.lanes.get(id)!)
      return a.x * b.x + a.z * b.z > 0.9
    })!
    return { approach, leftPocket, throughPocket, left, straight }
  }
  const approach = incoming[0]
  if (!approach) throw new Error(`No core approach for ${signal.id}/${axis}/${incomingDirection}`)
  const left = approach.next.find(id => crossTurn(approach, network.lanes.get(id)!) < -1)!
  const straight = approach.next.find(id => {
    const d = direction(approach), e = direction(network.lanes.get(id)!)
    return d.x * e.x + d.z * e.z > 0.9
  })!
  return { approach, leftPocket: undefined, throughPocket: undefined, left, straight }
}

function bareCar(source: Car, segId: string, dist: number, plannedNext: string | null, speed: number): Car {
  return {
    ...source, segId, dist, speed, conn: null, connNext: '', connDist: 0, tail: null,
    plannedNext, afterPocket: null, stopped: false, stuck: 0, creep: 0, jammed: 0, forced: 0,
    serveT: 0, serveCd: 1000,
  }
}

describe('Core crossroads geometry', () => {
  const network = buildRoadNetwork(plan)
  const centralSignals = network.signals.filter(s => Math.abs(s.x) <= 200 && Math.abs(s.z) <= 200)

  test('central tram corridor, turn pockets and bike lane fit inside the asphalt envelope', () => {
    expect(centralSignals).toHaveLength(5)
    expect(roadHalfWidth('arterial', 0)).toBe(11)
    const bedHalfWidth = 2.6
    for (const signal of centralSignals) {
      for (const lane of network.lanes.values()) {
        if (lane.signalId !== signal.id || !lane.pocket) continue
        expect(lane.laneWidth).toBe(3)
        const d = direction(lane)
        // Right-hand normal in the x/z world coordinate convention.
        const nx = -d.z, nz = d.x
        const radius = Math.abs(nx) > 0.5 ? Math.abs(lane.x1 - signal.x) : Math.abs(lane.z1 - signal.z)
        const edge = radius + (lane.laneWidth ?? 3) / 2
        expect(edge).toBeLessThanOrEqual(9)
        if (lane.pocket === 'left') expect(radius - (lane.laneWidth ?? 3) / 2).toBeGreaterThan(bedHalfWidth)
        else expect(radius - (lane.laneWidth ?? 3) / 2).toBeGreaterThan(5.2)
        // Bike band is centered at ±10m, 1.6m wide; keep a small paint gap.
        expect(edge).toBeLessThan(9.2)
      }
    }
    expect(TURN_POCKET_LENGTH).toBe(28)
    expect(TURN_TAPER_LENGTH).toBe(12)
  })

  test('widened central avenue keeps the full pavement clear of building footprints', () => {
    const edge = roadHalfWidth('arterial', 0) + 5
    for (const building of plan.buildings) {
      const rotated = building.rotation % 180 !== 0
      const hx = (rotated ? building.d : building.w) / 2
      const hz = (rotated ? building.w : building.d) / 2
      const dx = Math.abs(building.x) - hx, dz = Math.abs(building.z) - hz
      if (dx > 0) expect(dx).toBeGreaterThanOrEqual(edge)
      if (dz > 0) expect(dz).toBeGreaterThanOrEqual(edge)
    }
  })

  test('left and through/right pockets admit only their marked movement set', () => {
    const signal = network.signals.find(s => s.x === 0 && s.z === 0)!
    for (const lane of network.lanes.values()) {
      if (lane.signalId !== signal.id || !lane.pocket) continue
      const approach = network.lanes.get(lane.approachLane!)!
      expect(lane.next.length).toBeGreaterThan(0)
      for (const id of lane.next) {
        const turn = crossTurn(approach, network.lanes.get(id)!)
        if (lane.pocket === 'left') expect(turn).toBeLessThan(-1)
        else expect(turn).toBeGreaterThanOrEqual(-1)
      }
    }
  })

  test('through/right stop bar is staggered three metres behind the left stop bar', () => {
    const signal = network.signals.find(s => s.x === 0 && s.z === 0)!
    for (const approach of [...network.lanes.values()].filter(l => l.routeChoices && l.next.length === 2 && l.next.some(id => network.lanes.get(id)?.signalId === signal.id))) {
      const left = network.lanes.get(approach.next.find(id => network.lanes.get(id)?.pocket === 'left')!)!
      const through = network.lanes.get(approach.next.find(id => network.lanes.get(id)?.pocket === 'through-right')!)!
      const f = direction(approach)
      const stagger = (left.x2 - through.x2) * f.x + (left.z2 - through.z2) * f.z
      expect(stagger).toBeCloseTo(THROUGH_STOP_STAGGER, 5)
    }
  })

  test('zebra bars span the road mouth along the crossing axis and retain the 2.8m depth', () => {
    for (const axis of ['x', 'z'] as const) {
      const geometries = createCrosswalkStripes({ x: 0, z: 0, axis, roadCls: 'arterial' })
      const bounds = geometries.map(geometry => { geometry.computeBoundingBox(); return geometry.boundingBox! })
      const minX = Math.min(...bounds.map(b => b.min.x)), maxX = Math.max(...bounds.map(b => b.max.x))
      const minZ = Math.min(...bounds.map(b => b.min.z)), maxZ = Math.max(...bounds.map(b => b.max.z))
      expect(geometries.length).toBeGreaterThan(20)
      if (axis === 'x') {
        expect(maxX - minX).toBeGreaterThan(20)
        expect(maxZ - minZ).toBeCloseTo(2.8, 5)
      } else {
        expect(maxZ - minZ).toBeGreaterThan(20)
        expect(maxX - minX).toBeCloseTo(2.8, 5)
      }
      geometries.forEach(g => g.dispose())
    }
  })
})

describe('Pocketed approach bypass regression', () => {
  test('a separate through pocket clears a waiting left turn sooner than a shared lane', () => {
    const signal = plan.trafficLights.find(s => s.x === 0 && s.z === 0)!
    const run = (turnPockets: boolean) => {
      const network = buildRoadNetwork(plan, { turnPockets })
      const traffic = makeTraffic(network)
      const approach = coreApproach(network, signal, 'x', 1)
      const opposing = coreApproach(network, signal, 'x', -1)
      const leftPath = network.connectors.get(`${approach.leftPocket?.id ?? approach.approach.id}>${approach.left}`)!
      const throughPath = network.connectors.get(`${approach.throughPocket?.id ?? approach.approach.id}>${approach.straight}`)!
      expect(leftPath).toBeDefined()
      expect(throughPath).toBeDefined()
      const seedCars = traffic.cars

      // Find an opposing straight connector that holds the left-turn path but
      // leaves the same-axis through movement clear.
      const opposingLane = opposing.throughPocket ?? opposing.approach
      const opposingStraight = opposingLane.next.find(id => {
        const path = network.connectors.get(`${opposingLane.id}>${id}`)!
        const blocker: Car = { ...traffic.cars.find(c => c.typeIdx === 4)!, segId: opposing.approach.id,
          dist: 0, speed: 0, conn: path, connNext: id, connDist: path.len / 2, tail: null,
          plannedNext: id, afterPocket: null, serveT: 100, serveCd: 1000 }
        if (!path) return false
        traffic.cars = [blocker]
        traffic.activeConnectors = new Set([blocker])
        return !traffic.connectorClear({ ...traffic.cars[0], conn: null } as Car, leftPath)
          && traffic.connectorClear({ ...traffic.cars[0], conn: null } as Car, throughPath)
      })
      expect(opposingStraight).toBeDefined()
      const blockerPath = network.connectors.get(`${opposingLane.id}>${opposingStraight}`)!

      const leftLaneId = approach.leftPocket?.id ?? approach.approach.id
      const throughStart = approach.approach
      const leftLane = network.lanes.get(leftLaneId)!
      const leftStartDist = laneLength(leftLane) - (carLength(seedCars.find(c => c.typeIdx === 0)!) / 2 + 1) - 0.8
      const throughStartDist = turnPockets
        ? laneLength(throughStart) - (carLength(seedCars.find(c => c.typeIdx === 0)!) / 2 + 1) - 10
        : leftStartDist - 12

      const leftSource = seedCars.find(c => c.typeIdx === 0)!
      const throughSource = seedCars.find(c => c.typeIdx === 0 && c !== leftSource)!
      const truckSource = seedCars.find(c => c.typeIdx === 4)!
      const leftCar = bareCar(leftSource, leftLaneId, leftStartDist, approach.left, 0)
      const throughCar = bareCar(throughSource, throughStart.id, throughStartDist,
        turnPockets ? approach.throughPocket!.id : approach.straight, 8)
      if (turnPockets) throughCar.afterPocket = approach.straight
      const blocker = bareCar(truckSource, opposingLane.id, 0, opposingStraight!, 0)
      blocker.conn = blockerPath
      blocker.connNext = opposingStraight!
      blocker.connDist = blockerPath.len / 2
      blocker.serveT = 100
      traffic.cars = [leftCar, throughCar, blocker]

      // Freeze the core signal at its x-through phase; disable transit motion
      // so this regression isolates car-lane separation and conflict holds.
      traffic.trams = []
      traffic.tramPaths = []
      const coreSignal = network.signals.find(s => s.x === 0 && s.z === 0)!
      const signalState = traffic.signalState.get(coreSignal.id)!
      signalState.phase = coreSignal.phases.findIndex(p => p.greenAxis === 'x' && p.movement !== 'left')
      signalState.t = 100
      traffic.updateCars(0, 0)
      traffic.completedSegments = 0
      let throughPassedAt = Infinity
      for (let i = 0; i < 120; i++) {
        traffic.updateCars(0.1, 0)
        if (throughCar.segId === approach.straight && !throughCar.conn) throughPassedAt = Math.min(throughPassedAt, (i + 1) * 0.1)
      }
      return { completed: traffic.completedSegments, throughPassedAt }
    }

    const shared = run(false)
    const pocketed = run(true)
    expect(pocketed.completed).toBeGreaterThan(0)
    expect(Number.isFinite(pocketed.throughPassedAt)).toBe(true)
    // The shared head can now choose a legal detour after a long yield wait;
    // the separate lane still passes earlier without waiting for that replan.
    expect(pocketed.throughPassedAt).toBeLessThan(shared.throughPassedAt)
  }, 20000)

  test('the approach-to-pocket connector is internal and is excluded from junction throughput', () => {
    const network = buildRoadNetwork(plan)
    const signal = network.signals.find(s => s.x === 0 && s.z === 0)!
    const approach = coreApproach(network, signal)
    const internal = network.connectors.get(`${approach.approach.id}>${approach.throughPocket!.id}`)!
    expect(internal.internal).toBe(true)
    const traffic = makeTraffic(network)
    const source = traffic.cars.find(c => c.typeIdx === 0)!
    const car = bareCar(source, approach.approach.id,
      laneLength(approach.approach) - 2.5, approach.throughPocket!.id, 6)
    car.afterPocket = approach.straight
    traffic.cars = [car]
    traffic.trams = []
    traffic.tramPaths = []
    traffic.completedSegments = 0
    traffic.updateCars(0, 0)
    for (let i = 0; i < 40 && traffic.cars[0].segId === approach.approach.id; i++) traffic.updateCars(0.1, 0)
    expect(traffic.cars[0].segId).toBe(approach.throughPocket!.id)
    expect(traffic.completedSegments).toBe(0)
  })
})
