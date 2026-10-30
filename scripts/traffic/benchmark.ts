/// <reference types="bun-types" />
// Deterministic network benchmark, independent of rendering and playback speed.
import * as THREE from 'three'
import { planCity } from '../../src/lib/city/planner'
import { buildRoadNetwork } from '../../src/lib/city/roads'
import { TrafficSystem } from '../../src/lib/city/traffic'
import { TRAFFIC_PRESETS, type TrafficMetrics } from '../../src/lib/city/traffic-config'
import type { CityMaterials } from '../../src/lib/city/types'

const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient,
  set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
const material = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => material }, {
  get: (target, key) => key in target ? target.signMaterial : material,
}) as unknown as CityMaterials
const layout = process.env.BENCH_LAYOUT === 'shared' ? 'shared' : 'turn-pockets'
const plan = planCity(), network = buildRoadNetwork(plan, { turnPockets: layout === 'turn-pockets' })
const viewer = new THREE.Vector3(0, 1.7, 0)
const results: (TrafficMetrics & { layout: string; scenario: string; signalPolicy: string; dt: number })[] = []
const seconds = Number(process.env.BENCH_SECONDS ?? 600)
const dt = Number(process.env.BENCH_DT ?? 0.1)
for (const scenario of ['normal', 'rush-hour', 'gridlock'] as const) {
  for (const signalPolicy of ['fixed', 'adaptive'] as const) {
    const traffic = new TrafficSystem(plan, network, mats)
    traffic.configure({ ...TRAFFIC_PRESETS[scenario], signalPolicy })
    for (let step = 0; step < Math.round(seconds / dt); step++) {
      traffic.update(dt, viewer, 0)
    }
    results.push({ layout, scenario, signalPolicy, dt,
      ...traffic.getMetrics() })
  }
}
console.log(JSON.stringify(results, null, 2))
