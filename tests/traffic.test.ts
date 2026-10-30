/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { planCity } from '../src/lib/city/planner'
import { buildRoadNetwork } from '../src/lib/city/roads'
import { TrafficSystem } from '../src/lib/city/traffic'
import { TRAFFIC_PRESETS } from '../src/lib/city/traffic-config'
import type { CityMaterials, ConnPath } from '../src/lib/city/types'

const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient,
  set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
const mat = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => mat }, { get: (target, key) => key in target ? target.signMaterial : mat }) as unknown as CityMaterials
const plan = planCity()
const network = buildRoadNetwork(plan)
const viewer = new THREE.Vector3(0, 1.7, 0)

const makeTraffic = () => new TrafficSystem(plan, network, mats)
const run = (traffic: TrafficSystem, seconds: number) => {
  for (let i = 0; i < seconds * 10; i++) traffic.update(0.1, viewer, 0)
}

test('deferring intermediate car matrices preserves every traffic step and the final rendered poses', () => {
  const normal = makeTraffic(), deferred = makeTraffic()
  for (let i = 0; i < 600; i++) {
    normal.update(1 / 60, viewer, .8)
    deferred.update(1 / 60, viewer, .8, i % 4 === 3)
  }
  expect(deferred.getJamStats()).toEqual(normal.getJamStats())
  expect(deferred.getMetrics()).toEqual(normal.getMetrics())
  const buffers = (system: TrafficSystem) => {
    const result: number[][] = []
    system.group.traverse(node => {
      if (node instanceof THREE.InstancedMesh) result.push(Array.from(node.instanceMatrix.array))
    })
    return result
  }
  expect(buffers(deferred)).toEqual(buffers(normal))
})

test('each transit wheel contains one tire and one hub rather than coincident copies per axle', () => {
  const traffic = makeTraffic() as unknown as { busMeshes: { wheels: THREE.InstancedMesh }; tramParts: { wheels: THREE.InstancedMesh }[] }
  for (const wheel of [traffic.busMeshes.wheels, ...traffic.tramParts.map(part => part.wheels)]) {
    expect(wheel.geometry.groups).toHaveLength(2)
    expect((wheel.geometry.index?.count ?? wheel.geometry.attributes.position.count) / 3).toBeLessThan(100)
    expect(wheel.count).toBeGreaterThan(4)
  }
})

describe('Directed road graph', () => {
  test('lane directions match their east/west/north/south labels', () => {
    for (const lane of network.lanes.values()) {
      const direction = lane.id.match(/^L[xz]-?\d+([ewsn])/)?.[1]
      if (direction === 'e') expect(lane.x2).toBeGreaterThan(lane.x1)
      if (direction === 'w') expect(lane.x2).toBeLessThan(lane.x1)
      if (direction === 's') expect(lane.z2).toBeGreaterThan(lane.z1)
      if (direction === 'n') expect(lane.z2).toBeLessThan(lane.z1)
    }
  })
  test('road fragments never connect across a distant block or pedestrian gap', () => {
    for (const connector of network.connectors.values()) expect(connector.len).toBeLessThan(70)
    const ids = [...network.lanes.keys()]
    expect(ids.some(id => id.includes('rx100a'))).toBe(true)
    expect(ids.some(id => id.includes('rx100c'))).toBe(true)
    // This fragment used to end at x=200, inside the crossing collector.
    const fragment = network.lanes.get('Lx100w0:rx100c')!
    expect(fragment.x2).toBeGreaterThan(206)
  })
})

describe('Traffic scenarios and metrics', () => {
  test('presets and density configure the actual reproducible fleet', () => {
    const traffic = makeTraffic()
    expect(traffic.getMetrics().activeVehicles).toBe(48)
    traffic.configure({ ...TRAFFIC_PRESETS['rush-hour'], vehicleCount: 96 })
    expect(traffic.getConfig()).toEqual({ scenario: 'rush-hour', vehicleCount: 96, signalPolicy: 'adaptive' })
    expect(traffic.getMetrics().activeVehicles).toBe(96)
    const start = traffic.getJamStats().map(c => [c.x, c.z, c.typeIdx])
    expect(new Set(start.map(p => p.slice(0,2).join(','))).size).toBe(96)
    traffic.configure({ ...TRAFFIC_PRESETS.gridlock })
    expect(traffic.getMetrics().activeVehicles).toBe(240)
    traffic.configure({ ...TRAFFIC_PRESETS['rush-hour'], vehicleCount: 96 })
    expect(traffic.getJamStats().map(c => [c.x, c.z, c.typeIdx])).toEqual(start)
    expect(traffic.getMetrics()).toMatchObject({ completedSegments: 0, recoveryRespawns: 0, queued: 0, stoppedSecondsPerVehicle: 0 })
  })

  test('vehicles continue through the network and raw simulation metrics stay finite', () => {
    const traffic = makeTraffic()
    traffic.configure({ ...TRAFFIC_PRESETS['rush-hour'], vehicleCount: 96 })
    run(traffic, 180)
    const metrics = traffic.getMetrics()
    expect(metrics.activeVehicles).toBe(96)
    expect(metrics.completedSegments).toBeGreaterThan(0)
    expect(metrics.throughputPerMinute).toBeGreaterThan(0)
    expect(metrics.avgSpeedKmh).toBeGreaterThan(0)
    expect(metrics.avgSpeedKmh).toBeLessThan(100)
    expect(metrics.queuePercent).toBeGreaterThanOrEqual(0)
    expect(metrics.queuePercent).toBeLessThanOrEqual(100)
    expect(Number.isFinite(metrics.meanWaitSec)).toBe(true)
  })

  test('normal traffic keeps flowing over ten minutes without recovery teleports', () => {
    const traffic = makeTraffic()
    run(traffic, 600)
    const metrics = traffic.getMetrics()
    expect(metrics.avgSpeedKmh).toBeGreaterThan(15)
    expect(metrics.queuePercent).toBeLessThan(50)
    expect(metrics.throughputPerMinute).toBeGreaterThan(48)
    expect(metrics.recoveryRespawns).toBe(0)
  })

  test('rush-hour and gridlock presets expose demand-driven queues', () => {
    const values: number[] = []
    for (const scenario of ['normal', 'rush-hour', 'gridlock'] as const) {
      const traffic = makeTraffic()
      traffic.configure({ ...TRAFFIC_PRESETS[scenario] })
      run(traffic, 90)
      values.push(traffic.getMetrics().queuePercent)
    }
    expect(values[1]).toBeGreaterThan(values[0])
    expect(values[2]).toBeGreaterThan(values[1])
  })

  test('red phases block new entries and queues never force red-light escapes', () => {
    const traffic = makeTraffic()
    traffic.configure({ ...TRAFFIC_PRESETS.gridlock, signalPolicy: 'adaptive' })
    const state = traffic as unknown as { cars: { conn: ConnPath | null; segId: string }[]; signalState: Map<string, { phase: number; t: number }> }
    for (let step = 0; step < 1800; step++) {
      const wasInside = state.cars.map(car => !!car.conn)
      traffic.update(0.05, viewer, 0)
      state.cars.forEach((car, i) => {
        if (wasInside[i] || !car.conn) return
        const lane = network.lanes.get(car.segId)!
        if (car.conn.internal || !lane.signalId) return
        const signal = network.signals.find(s => s.id === lane.signalId)!
        const controller = state.signalState.get(signal.id)!
        const phase = signal.phases[controller.phase]
        expect(controller.t).toBeGreaterThan(0)
        expect(phase.greenAxis).toBe(Math.abs(lane.x2-lane.x1) > Math.abs(lane.z2-lane.z1) ? 'x' : 'z')
        if (phase.movement === 'left') {
          expect(lane.pocket).toBe('left')
          expect(traffic.signalGreenAxis(signal.id)).toBe(null)
        }
      })
    }
    expect(traffic.getJamStats().every(c => c.forced === 0)).toBe(true)
  })

  test('adaptive signals continue serving both axes without forced red entries', () => {
    const traffic = makeTraffic()
    traffic.configure({ ...TRAFFIC_PRESETS.gridlock, signalPolicy: 'adaptive' })
    const signals = network.signals.filter(s => s.phases.some(p => p.greenAxis === 'x') && s.phases.some(p => p.greenAxis === 'z'))
    expect(signals.length).toBeGreaterThan(0)
    const seen = new Map(signals.map(s => [s.id, new Set<string>()]))
    const redTime = new Map(signals.map(s => [s.id, { x: 0, z: 0 }]))
    let longestRed = 0, clearanceSteps = 0
    for (let i = 0; i < 2400; i++) {
      traffic.update(0.1, viewer, 0)
      for (const s of signals) {
        const axis = traffic.signalGreenAxis(s.id)
        if (axis) seen.get(s.id)!.add(axis)
        else clearanceSteps++
        const age = redTime.get(s.id)!
        for (const direction of ['x', 'z'] as const) {
          age[direction] = axis === direction ? 0 : age[direction] + 0.1
          longestRed = Math.max(longestRed, age[direction])
        }
      }
    }
    for (const s of signals) expect([...seen.get(s.id)!].sort()).toEqual(['x', 'z'])
    expect(clearanceSteps).toBeGreaterThan(0)
    // Two through phases plus protected left arrows and their clearances.
    expect(longestRed).toBeLessThan(33)
    expect(traffic.getMetrics().recoveryRespawns).toBeLessThan(traffic.getMetrics().completedSegments)
  }, 20000)

  test('high congestion keeps discharging over ten minutes with bounded stopped time', () => {
    const traffic = makeTraffic()
    traffic.configure({ ...TRAFFIC_PRESETS.gridlock })
    run(traffic, 600)
    const metrics = traffic.getMetrics()
    // Before junction optimization: 425s stopped/car, 1,966 exits, 68/min.
    expect(metrics.stoppedSecondsPerVehicle).toBeLessThan(280)
    expect(metrics.completedSegments).toBeGreaterThan(3500)
    expect(metrics.throughputPerMinute).toBeGreaterThan(200)
    expect(metrics.activeVehicles).toBe(240)
    expect(metrics.recoveryRespawns).toBe(0)
  }, 20000)
})

interface TestCar {
  segId: string; dist: number; conn: ConnPath | null; tail: ConnPath | null
  connNext: string; connDist: number; plannedNext: string | null
  typeIdx: number; speed: number
}
interface JunctionHarness {
  cars: TestCar[]
  activeConnectors: Set<TestCar>
  connectorClear(car: TestCar, path: ConnPath): boolean
  exitClear(car: TestCar, exit: string): boolean
}
const path = (x1: number, z1: number, x2: number, z2: number): ConnPath => {
  const len = Math.hypot(x2 - x1, z2 - z1)
  return { pts: [{ x: x1, z: z1 }, { x: x2, z: z2 }], cum: [0, len], len, straight: true }
}

describe('Junction admission and downstream storage', () => {
  test('approaching and clearing trams reserve their full length in both directions', () => {
    const state = makeTraffic() as unknown as {
      cars: TestCar[]; activeConnectors: Set<TestCar>
      trams: { routeIdx: number; dir: 1 | -1; dist: number; speed: number }[]
      tramPaths: { axis: 'x' | 'z'; coord: number; from: number }[]
      connectorClear(car: TestCar, path: ConnPath): boolean
    }
    const tram = state.trams[0], track = state.tramPaths[tram.routeIdx]
    state.trams = [tram]
    state.activeConnectors.clear()
    const crossing = track.axis === 'x' ? path(0, -20, 0, 20) : path(-20, 0, 20, 0)
    for (const direction of [1, -1] as const) {
      tram.dir = direction
      tram.dist = -direction * 40 - track.from
      expect(state.connectorClear(state.cars[0], crossing)).toBe(false)
      tram.dist = -direction * 150 - track.from
      expect(state.connectorClear(state.cars[0], crossing)).toBe(true)
      tram.dist = direction * 12 - track.from // rear still occupies crossing
      expect(state.connectorClear(state.cars[0], crossing)).toBe(false)
      tram.dist = direction * 30 - track.from
      expect(state.connectorClear(state.cars[0], crossing)).toBe(true)
    }
  })

  test('a tram holds before an occupied crossing and resumes after the car clears', () => {
    const state = makeTraffic() as unknown as {
      cars: TestCar[]; activeConnectors: Set<TestCar>
      trams: { routeIdx: number; dir: 1 | -1; dist: number; speed: number; dwell: number }[]
      tramPaths: { axis: 'x' | 'z'; from: number; stops: number[] }[]
      updateTrams(dt: number): void
    }
    const tram = state.trams[0], track = state.tramPaths[tram.routeIdx]
    state.trams = [tram]
    track.stops = []
    tram.dir = 1; tram.dist = -40 - track.from; tram.speed = 8; tram.dwell = 0
    const crossing = track.axis === 'x' ? path(0, -20, 0, 20) : path(-20, 0, 20, 0)
    state.activeConnectors = new Set([{ ...state.cars[0], conn: crossing }])
    for (let i = 0; i < 360; i++) state.updateTrams(1 / 60)
    expect(track.from + tram.dist).toBeLessThanOrEqual(-17)
    state.activeConnectors.clear()
    for (let i = 0; i < 360; i++) state.updateTrams(1 / 60)
    expect(track.from + tram.dist).toBeGreaterThan(5)
  })
  test('same-path platoons enter at a following gap, crossing traffic waits for the rear', () => {
    const state = makeTraffic() as unknown as JunctionHarness
    const through = path(-10, 0, 10, 0), crossing = path(0, -10, 0, 10)
    const lane = network.lanes.get(state.cars[0].segId)!
    const follower = { ...state.cars[0], dist: Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1), speed: 0, typeIdx: 0 }
    const leader: TestCar = { ...state.cars[1], conn: through, connDist: 3, typeIdx: 0 }
    state.activeConnectors = new Set([leader])
    expect(state.connectorClear(follower, through)).toBe(false)
    leader.connDist = 9
    expect(state.connectorClear(follower, through)).toBe(true)
    expect(state.connectorClear(follower, crossing)).toBe(false)
    leader.connDist = 18.5
    expect(state.connectorClear(follower, crossing)).toBe(true)
    // A longer truck's rear has not cleared at the same centre position.
    leader.typeIdx = 4
    expect(state.connectorClear(follower, crossing)).toBe(false)
    leader.conn = null
    leader.tail = through
    leader.dist = 2
    expect(state.connectorClear(follower, crossing)).toBe(true)
  })

  test('cache distinguishes actual turn paths even when no next lane was planned', () => {
    const state = makeTraffic() as unknown as JunctionHarness
    const car = { ...state.cars[0], plannedNext: null }
    const occupied = path(0, -10, 0, 10)
    const leader = { ...state.cars[1], conn: occupied, connDist: 2 }
    state.activeConnectors = new Set([leader])
    expect(state.connectorClear(car, path(8, -10, 8, 10))).toBe(true)
    expect(state.connectorClear(car, path(-10, 0, 10, 0))).toBe(false)
    // Opposing straight lanes remain independent.
    expect(state.connectorClear(car, path(4.8, 10, 4.8, -10))).toBe(true)
  })

  test('exit storage includes every vehicle committed by a different merging turn', () => {
    const state = makeTraffic() as unknown as JunctionHarness
    const exit = [...network.lanes.keys()][0]
    const car = { ...state.cars[0], typeIdx: 0, conn: null }
    const queue = { ...state.cars[1], segId: exit, dist: 9, conn: null, typeIdx: 0 }
    state.cars = [car, queue]
    expect(state.exitClear(car, exit)).toBe(true)
    const merging = { ...state.cars[0], conn: path(-10, -10, 0, 0), connNext: exit, typeIdx: 3 }
    state.cars.push(merging)
    expect(state.exitClear(car, exit)).toBe(false)
    queue.dist = 25
    expect(state.exitClear(car, exit)).toBe(true)
  })

  test('full-length vehicles remain separated through junctions at the live 60Hz step', () => {
    const traffic = makeTraffic()
    traffic.configure({ ...TRAFFIC_PRESETS.gridlock })
    type Body = { x: number; z: number; heading: number; typeIdx: number }
    const state = traffic as unknown as { cars: Body[] }
    const lengths = [4.5, 4.65, 5.3, 7.6, 8.2], widths = [1.8, 1.85, 2.02, 2.45, 2.45]
    // Independent oriented rectangle intersection check: catches cross-traffic
    // clipping and truck corner sweep as well as same-lane overlaps.
    const overlaps = (a: Body, b: Body) => {
      const dx = b.x - a.x, dz = b.z - a.z
      if (dx * dx + dz * dz > 100) return false
      const af = { x: Math.sin(a.heading), z: Math.cos(a.heading) }, ar = { x: af.z, z: -af.x }
      const bf = { x: Math.sin(b.heading), z: Math.cos(b.heading) }, br = { x: bf.z, z: -bf.x }
      for (const axis of [af, ar, bf, br]) {
        const extent = (car: Body, f: typeof af, r: typeof ar) => Math.abs(axis.x * f.x + axis.z * f.z) * (lengths[car.typeIdx] / 2 - 0.1)
          + Math.abs(axis.x * r.x + axis.z * r.z) * (widths[car.typeIdx] / 2 - 0.1)
        if (Math.abs(dx * axis.x + dz * axis.z) >= extent(a, af, ar) + extent(b, bf, br)) return false
      }
      return true
    }
    const collisions: unknown[] = []
    for (let step = 0; step < 90 * 60; step++) {
      traffic.update(1 / 60, viewer, 0)
      if (step % 10) continue
      for (let i = 0; i < state.cars.length; i++) for (let j = i + 1; j < state.cars.length; j++) {
        if (overlaps(state.cars[i], state.cars[j]) && collisions.length < 3) {
          const capture = (car: Body) => ({ ...car, conn: !!(car as Body & { conn: unknown }).conn, tail: !!(car as Body & { tail: unknown }).tail })
          collisions.push({ time: step / 60, a: capture(state.cars[i]), b: capture(state.cars[j]) })
        }
      }
    }
    expect(collisions).toEqual([])
    expect(traffic.getMetrics().recoveryRespawns).toBe(0)
  }, 20000)
})
