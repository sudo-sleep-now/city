/// <reference types="bun-types" />
// Measure minima over a sustained physics run, not just its final cumulative mean.
import * as THREE from 'three'
import { planCity } from '../../src/lib/city/planner'
import { buildRoadNetwork } from '../../src/lib/city/roads'
import { TrafficSystem } from '../../src/lib/city/traffic'
import { TRAFFIC_PRESETS, MIN_TRAFFIC_VEHICLES, MAX_TRAFFIC_VEHICLES, type TrafficMetrics, type TrafficScenario, type SignalPolicy } from '../../src/lib/city/traffic-config'
import type { CityMaterials } from '../../src/lib/city/types'

const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient,
  set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
const material = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => material }, { get: (target, key) => key in target ? target.signMaterial : material }) as unknown as CityMaterials
const plan = planCity(), network = buildRoadNetwork(plan), viewer = new THREE.Vector3(0, 1.7, 0)
const seconds = Number(process.env.BENCH_SECONDS ?? 1800), dt = Number(process.env.BENCH_DT ?? 1 / 60)
const scenarios = (process.env.BENCH_SCENARIOS ?? 'normal,rush-hour,gridlock').split(',') as TrafficScenario[]
const policies = (process.env.BENCH_POLICIES ?? 'adaptive').split(',') as SignalPolicy[]
const counts = process.env.BENCH_COUNTS ? process.env.BENCH_COUNTS.split(',').map(Number) : [undefined]
if (!(seconds >= 60) || !(dt > 0 && dt <= 0.1)) throw new Error('Use at least 60s and a time step in (0,0.1].')
if (scenarios.some(s => !(s in TRAFFIC_PRESETS)) || policies.some(p => p !== 'fixed' && p !== 'adaptive')) throw new Error('Unknown scenario or signal policy.')
if (counts.some(n => n !== undefined && (!Number.isInteger(n) || n < MIN_TRAFFIC_VEHICLES || n > MAX_TRAFFIC_VEHICLES))) throw new Error('Vehicle count outside the supported range.')
const results: { targetMet: boolean; [key: string]: unknown }[] = []
for (const scenario of scenarios) for (const signalPolicy of policies) for (const vehicleCount of counts) {
  const traffic = new TrafficSystem(plan, network, mats)
  traffic.configure({ ...TRAFFIC_PRESETS[scenario], signalPolicy, vehicleCount: vehicleCount ?? TRAFFIC_PRESETS[scenario].vehicleCount })
  const state = traffic as unknown as { cars: { speed: number; forced: number }[]; carMeshes: unknown[] }
  state.carMeshes = [] // Skip car matrix writes only; all movement and transit remain simulated.
  const window = new Float64Array(Math.round(60 / dt))
  let sum = 0, total = 0, minCurrent = Infinity, minRun = Infinity, minRolling = Infinity, worstRollingAt = 0
  const readings: (TrafficMetrics & { time: number; currentKmh: number; rollingKmh: number })[] = []
  for (let step = 0; step < Math.round(seconds / dt); step++) {
    traffic.update(dt, viewer, 0)
    const time = (step + 1) * dt
    const current = state.cars.reduce((n, c) => n + c.speed, 0) / state.cars.length * 3.6
    const index = step % window.length
    sum += current - window[index]; window[index] = current; total += current
    minCurrent = Math.min(minCurrent, current)
    if (time >= 1) minRun = Math.min(minRun, total / (step + 1))
    if (step + 1 >= window.length && sum / window.length < minRolling) {
      minRolling = sum / window.length; worstRollingAt = time
    }
    if ((step + 1) % Math.round(60 / dt) === 0) readings.push({ time, currentKmh: current, rollingKmh: sum / window.length, ...traffic.getMetrics() })
  }
  const result = { scenario, signalPolicy, dt, seconds, minCurrentKmh: minCurrent, minRunKmh: minRun,
    minRolling60Kmh: minRolling, worstRollingAt, targetMet: minCurrent >= 15 && minRun >= 15 && minRolling >= 15,
    redOverrides: state.cars.filter(c => c.forced > 0).length, ...traffic.getMetrics(), trips: traffic.getTripStats(), readings }
  results.push(result)
  console.error(`${scenario}/${signalPolicy}/${traffic.getMetrics().activeVehicles}: min run ${minRun.toFixed(2)}, min 60s ${minRolling.toFixed(2)}, min current ${minCurrent.toFixed(2)} km/h`)
}
console.log(JSON.stringify(results, null, 2))
if (results.some(result => !result.targetMet)) process.exitCode = 1
