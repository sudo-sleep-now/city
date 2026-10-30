/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { planCity } from '../src/lib/city/planner'
import { buildRoadNetwork } from '../src/lib/city/roads'
import { TrafficRouter } from '../src/lib/city/traffic-routing'
import { TrafficSystem } from '../src/lib/city/traffic'
import { TRAFFIC_PRESETS } from '../src/lib/city/traffic-config'
import type { CityMaterials, ConnPath, LaneSeg } from '../src/lib/city/types'

const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient, set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
const material = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => material }, { get: (target, key) => key in target ? target.signMaterial : material }) as unknown as CityMaterials
const plan = planCity(), network = buildRoadNetwork(plan), viewer = new THREE.Vector3(0, 1.7, 0)
const makeTraffic = () => new TrafficSystem(plan, network, mats)

describe('Persistent traffic trips and route choice', () => {
  test('trip targets are real crossroads; road seams are navigation nodes only', () => {
    const router = new TrafficRouter(network)
    expect(router.destinations).toContain('0,0')
    expect(router.homes.length).toBeGreaterThan(0)
    for (const seam of ['-100,100', '0,100', '100,-100']) {
      expect(router.isJunction(seam)).toBe(false)
      expect(router.destinations).not.toContain(seam)
      expect(router.central).not.toContain(seam)
    }
    for (const lane of network.lanes.values()) if (lane.routeChoices) {
      for (const pocket of lane.next) expect(router.endNode(pocket)).toBe(router.endNode(lane.id))
    }
  })

  test('a queued direct approach causes a legal detour towards the same target', () => {
    const router = new TrafficRouter(network)
    const from = network.lanes.get('Lx0e4:rc0-z')!
    const direct = 'Lx0e5:rc0-z'
    expect(router.choose(from, from.next, router.core)).toBe(direct)
    const traffic = makeTraffic() as unknown as { cars: { segId: string; dist: number; speed: number; stuck: number; typeIdx: number; conn: ConnPath | null; connNext: string; plannedNext: string | null; afterPocket: string | null }[] }
    const seed = traffic.cars[0]
    const pockets = network.lanes.get(direct)!.next
    const queue = Array.from({ length: 8 }, (_, i) => ({ ...seed, segId: i < 3 ? direct : pockets[i % 2],
      dist: 4 + (i % 3) * 7, conn: null, plannedNext: null, afterPocket: null, speed: 0, stuck: 60, typeIdx: 0 }))
    router.sense(queue, 0)
    const detour = router.choose(from, from.next, router.core)
    expect(from.next).toContain(detour)
    expect(detour).not.toBe(direct)
  })

  test('an internal pocket transition is not arrival; the real junction completes the trip', () => {
    type Car = { segId: string; dist: number; speed: number; typeIdx: number; conn: ConnPath | null; connNext: string; connDist: number;
      plannedNext: string | null; afterPocket: string | null; tail: ConnPath | null; tripTarget: string; homeNode: string; nextTripTarget: string | null; tripToHome: boolean; serveT: number; serveCd: number }
    const traffic = makeTraffic()
    const state = traffic as unknown as { cars: Car[]; trams: unknown[]; carMeshes: unknown[]; updateCars(dt: number, night: number): void; arriveAtJunction(car: Car, lane: LaneSeg): void }
    const router = new TrafficRouter(network)
    const approach = network.lanes.get('Lx0e5:rc0-z')!
    const pocket = network.lanes.get(approach.next.find(id => network.lanes.get(id)!.pocket === 'through-right')!)!
    const straight = pocket.next.find(id => id.startsWith('Lx0e'))!
    const internal = network.connectors.get(`${approach.id}>${pocket.id}`)!
    const car: Car = { ...state.cars[0], segId: approach.id, dist: 0, speed: 8, typeIdx: 0, conn: internal, connNext: pocket.id,
      connDist: internal.len - 0.01, afterPocket: straight, tail: null, tripTarget: router.core, homeNode: router.homes[0],
      nextTripTarget: router.homes[0], tripToHome: false, serveT: 0, serveCd: 10000 }
    state.cars = [car]; state.trams = []; state.carMeshes = []
    state.updateCars(0.1, 0)
    expect(car.tripTarget).toBe(router.core)
    expect(car.tripToHome).toBe(false)
    expect(traffic.getTripStats().completedTrips).toBe(0)
    const crossing = network.connectors.get(`${pocket.id}>${straight}`)!
    Object.assign(car, { segId: pocket.id, conn: crossing, connNext: straight, connDist: crossing.len - 0.01, speed: 8 })
    state.updateCars(0.1, 0)
    expect(car.tripTarget).toBe(car.homeNode)
    expect(car.tripToHome).toBe(true)
    expect(traffic.getTripStats().completedTrips).toBe(1)
    expect(state.cars).toHaveLength(1)
    // Even a manually injected target cannot count a same-road seam as arrival.
    const seam = [...network.lanes.values()].find(lane => !lane.pocket && !lane.routeChoices && router.endNode(lane.id) === '0,100')!
    car.tripTarget = '0,100'
    state.arriveAtJunction(car, seam)
    expect(traffic.getTripStats().completedTrips).toBe(1)
  })

  test('all stopped vehicles remain in current, run and rolling speed averages', () => {
    const traffic = makeTraffic()
    const state = traffic as unknown as { cars: { speed: number }[]; recordMetrics(dt: number): void }
    for (const car of state.cars) car.speed = 0
    state.recordMetrics(60)
    state.cars[0].speed = 6
    state.recordMetrics(60)
    const speed = 6 / state.cars.length * 3.6
    expect(traffic.getMetrics().currentSpeedKmh).toBeCloseTo(speed)
    expect(traffic.getMetrics().rollingSpeedKmh).toBeCloseTo(speed)
    expect(traffic.getMetrics().avgSpeedKmh).toBeCloseTo(speed / 2)
    expect(traffic.getMetrics().minCurrentSpeedKmh).toBe(0)
    expect(traffic.getMetrics().minRollingSpeedKmh).toBe(0)
  })

  test('the full 240-car commute stays above 15km/h without overrides or recovery moves', () => {
    const traffic = makeTraffic()
    traffic.configure({ ...TRAFFIC_PRESETS.gridlock })
    const state = traffic as unknown as { cars: { speed: number }[] }
    let maxVehicleSpeed = 0
    for (let step = 0; step < 12000; step++) {
      traffic.update(0.1, viewer, 0)
      for (const car of state.cars) maxVehicleSpeed = Math.max(maxVehicleSpeed, car.speed)
    }
    const metrics = traffic.getMetrics(), trips = traffic.getTripStats()
    expect(metrics.minCurrentSpeedKmh!).toBeGreaterThanOrEqual(15)
    expect(metrics.minRunSpeedKmh!).toBeGreaterThanOrEqual(15)
    expect(metrics.minRollingSpeedKmh!).toBeGreaterThanOrEqual(15)
    expect(metrics.activeVehicles).toBe(240)
    expect(maxVehicleSpeed).toBeLessThanOrEqual(11)
    expect(metrics.recoveryRespawns).toBe(0)
    expect(traffic.getJamStats().every(car => car.forced === 0)).toBe(true)
    expect(trips.completedTrips).toBeGreaterThan(500)
    expect(trips.completedReturns).toBeGreaterThan(200)
    expect(trips.centralDepartures).toBe(Math.floor(trips.inboundDepartures * 0.92 + 1e-9))
  }, 45000)
})
