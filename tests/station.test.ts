/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { planCity } from '../src/lib/city/planner'
import { buildRoadNetwork } from '../src/lib/city/roads'
import { TrafficSystem } from '../src/lib/city/traffic'
import { createStation } from '../src/lib/city/station'
import type { CityMaterials } from '../src/lib/city/types'

// Traffic geometry needs a texture canvas but these tests exercise simulation,
// not pixels. Real WebGL rendering is checked separately in the browser.
const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient,
  set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
const mat = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => mat }, { get: (target, key) => key in target ? target.signMaterial : mat }) as unknown as CityMaterials
const plan = planCity()
const station = plan.buildings.find(b => b.kind === 'transit-hub')!
const route = plan.routes.find(r => r.id === 'B1')!
const stop = plan.stops.find(s => s.name.startsWith('Solheim Interchange'))!

describe('Working station interchange', () => {
  test('the real boarding bay belongs to the active B1 route', () => {
    expect(route.stopIds).toContain(stop.id)
    expect(stop.z).toBe(-124)
    expect(plan.stops.some(s => s.id === 'st-hub')).toBe(false)
    const tram = plan.stops.find(s => s.id === 't1--182')
    expect(tram).toBeDefined()
    expect(plan.routes.find(r => r.id === 'T1')!.stopIds).toContain(tram!.id)
  })

  test('both bus approaches use the east street and keep clear of the hall', () => {
    const points = route.points.filter(p => p.x > 0 && p.x < 110 && p.z > -150 && p.z < -95)
    expect(points.length).toBeGreaterThan(8)
    expect(points.every(p => p.x >= 27)).toBe(true)
    for (let i = 0; i < route.points.length - 1; i++) {
      const a = route.points[i], b = route.points[i + 1]
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len
      for (let d = 0; d <= len; d += 1) {
        const x = a.x + ux * d - uz * 2.6, z = a.z + uz * d + ux * 2.6
        // An oriented 11.4 x 2.55 m bus must clear the building envelope.
        for (const longitudinal of [-5.7, 5.7]) for (const lateral of [-1.275, 1.275]) {
          const cx = x + ux * longitudinal - uz * lateral
          const cz = z + uz * longitudinal + ux * lateral
          expect(cx > 18 && cx < 82 && cz > -163 && cz < -133).toBe(false)
        }
      }
    }
  })

  test('terminal lanes do not spawn private cars', () => {
    const network = buildRoadNetwork(plan)
    expect([...network.lanes.keys()].some(id => id.includes('-124') || id.includes('-108'))).toBe(false)
  })

  test('the hall has walk-through portals instead of a solid building collider', () => {
    expect(plan.enterables.some(e => e.buildingId === station.id)).toBe(false)
    const shell = createStation(station, mats)
    for (const x of [-13, 13]) expect(shell.colliders.some(c => x >= c.minX && x <= c.maxX && 14.6 >= c.minZ && 14.6 <= c.maxZ)).toBe(false)
    expect(shell.colliders.some(c => 0 >= c.minX && 0 <= c.maxX && 14.6 >= c.minZ && 14.6 <= c.maxZ)).toBe(true)
  })

  test('a bus opens doors at the station, boards on the hall side and departs', () => {
    const traffic = new TrafficSystem(plan, buildRoadNetwork(plan), mats)
    const viewer = new THREE.Vector3(70, 1.7, -96)
    traffic.update(.1, viewer, 0)
    const initial = traffic.getBoardingBuses().find(b => b.stopId === stop.id)
    expect(initial).toBeDefined()
    expect(initial!.z).toBeCloseTo(-126.6, 1)
    expect(initial!.doorZ).toBeLessThan(-128)
    let left = false, laterArrival = false
    for (let i = 0; i < 800; i++) {
      traffic.update(.1, viewer, 0)
      const boarding = traffic.getBoardingBuses().some(b => b.stopId === stop.id)
      if (!boarding) left = true
      if (left && boarding) laterArrival = true
    }
    expect(left).toBe(true)
    expect(laterArrival).toBe(true)
  })
})
