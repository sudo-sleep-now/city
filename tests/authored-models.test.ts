/// <reference types="bun-types" />
import { test, expect } from 'bun:test'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { planCity, roadHalfWidth } from '../src/lib/city/planner'
import { buildRoadNetwork } from '../src/lib/city/roads'
import { TrafficSystem } from '../src/lib/city/traffic'
import type { CityMaterials } from '../src/lib/city/types'
import { addPropInstances } from '../src/lib/city/authored-props'
import { createEnvironment } from '../src/lib/city/environment'
import { createStation } from '../src/lib/city/station'
import { createCityCenter } from '../src/lib/city/city-center'

const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient, set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
globalThis.ProgressEvent ??= class extends Event {
  lengthComputable = false
  loaded = 0
  total = 0
} as typeof ProgressEvent
const material = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => material }, { get: (target, key) => key in target ? target.signMaterial : material }) as unknown as CityMaterials

async function loadBundle(file: string) {
  const data = new Uint8Array(await Bun.file(new URL(`../public/models/${file}.glb`, import.meta.url)).arrayBuffer())
  const view = new DataView(data.buffer), jsonLength = view.getUint32(12, true)
  const doc = JSON.parse(new TextDecoder().decode(data.slice(20, 20 + jsonLength)))
  // Retain real hierarchy and geometry; avoid browser-only bitmap decoding.
  for (const m of doc.materials ?? []) {
    delete m.pbrMetallicRoughness?.baseColorTexture
    delete m.pbrMetallicRoughness?.metallicRoughnessTexture
    delete m.normalTexture; delete m.emissiveTexture; delete m.occlusionTexture
  }
  delete doc.textures; delete doc.images; delete doc.samplers
  doc.buffers = [{ byteLength: view.getUint32(20 + jsonLength, true),
    uri: `data:application/octet-stream;base64,${Buffer.from(data.slice(28 + jsonLength)).toString('base64')}` }]
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '')
  return new Map(gltf.scene.children.map(root => [root.name, root as THREE.Group]))
}

test('optimized GLB material groups load into a complete, resettable instanced vehicle fleet', async () => {
  const models = await loadBundle('vehicles')
  for (const name of ['sedan', 'estate', 'van', 'wheel']) expect(models.has(name)).toBe(true)
  const plan = planCity(), network = buildRoadNetwork(plan)
  const traffic = new TrafficSystem(plan, network, mats, models)
  const assertWheels = () => {
    const state = traffic as unknown as { carMeshes: { wheels: THREE.InstancedMesh | null; paint: THREE.InstancedMesh; lampF: THREE.InstancedMesh; lampR: THREE.InstancedMesh }[] }
    for (const car of state.carMeshes.slice(0, 3)) {
      expect(car.wheels).not.toBeNull()
      // Authored rims/tyres have far more vertices than the emergency cylinder
      // fallback, so this also verifies the grouped GLB was actually used.
      expect(car.wheels!.geometry.attributes.position.count).toBeGreaterThan(1000)
      expect(car.wheels!.geometry.groups).toHaveLength(2)
      const body = new THREE.Matrix4(), lens = new THREE.Matrix4()
      car.paint.getMatrixAt(0, body)
      for (const lamp of [car.lampF, car.lampR]) {
        expect(lamp).not.toBeNull()
        lamp.getMatrixAt(0, lens)
        expect(lens.elements).toEqual(body.elements)
      }
    }
  }
  assertWheels()
  traffic.configure({ scenario: 'gridlock', vehicleCount: 240, signalPolicy: 'adaptive' })
  traffic.update(1 / 60, new THREE.Vector3(0, 1.7, 0), 0)
  expect(traffic.getMetrics().activeVehicles).toBe(240)
  assertWheels()
  traffic.update(0, new THREE.Vector3(), 1)
  assertWheels()
})

test('real street prop primitives preserve their transformed bounds when instanced', async () => {
  const models = await loadBundle('street-props')
  for (const key of ['hydrant', 'parked_bike', 'bike_rack', 'stop_shelter', 'ticket_kiosk', 'station_bench', 'litter_bin']) {
    const root = models.get(key)!
    expect(root).toBeDefined()
    const output = new THREE.Group()
    const p = { x: 12, y: .14, z: -18, ry: Math.PI / 2 }
    expect(addPropInstances(output, models, key, [p, { ...p, x: 20 }])).toBe(true)
    output.updateMatrixWorld(true)
    const actual = new THREE.Box3().setFromObject(output)
    const local = new THREE.Box3().setFromObject(root, true)
    const m = new THREE.Matrix4().makeRotationY(p.ry).setPosition(p.x, p.y, p.z)
    const expected = local.clone().applyMatrix4(m)
    expected.union(local.clone().applyMatrix4(m.clone().setPosition(20, p.y, p.z)))
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(actual.min[axis]).toBeCloseTo(expected.min[axis], 4)
      expect(actual.max[axis]).toBeCloseTo(expected.max[axis], 4)
    }
    expect(output.children.every(o => o instanceof THREE.InstancedMesh && o.count === 2)).toBe(true)
  }
})

test('authored street furniture populates real stops and preserves station portals', async () => {
  const models = await loadBundle('street-props')
  const glazing: THREE.Material[] = []
  models.get('stop_shelter')!.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    glazing.push(...materials.filter(m => /glass/i.test(m.name)))
  })
  expect(glazing.length).toBeGreaterThan(0)
  for (const glass of glazing) {
    expect(glass.transparent).toBe(true)
    expect(glass.opacity).toBeLessThan(.6)
    expect(glass.depthWrite).toBe(false)
  }
  const plan = planCity()
  const environment = createEnvironment(plan, mats, models)
  const batches = environment.group.children.filter(o => o instanceof THREE.InstancedMesh && o.userData.asset)
  for (const key of ['hydrant', 'parked_bike', 'bike_rack', 'stop_shelter', 'station_bench', 'litter_bin']) {
    expect(batches.some(o => o.userData.asset === key)).toBe(true)
  }
  // Seating must be built after stop placement: every bus shelter's seat is
  // included in the rendered batch, rather than merely the pedestrian list.
  const benchCount = batches.filter(o => o.userData.asset === 'station_bench')
    .reduce((max, o) => Math.max(max, (o as THREE.InstancedMesh).count), 0)
  expect(benchCount).toBe(environment.benchSpots.length)
  // Check actual exported geometry at every placement. The old tram islands
  // were centred 4.2 m from the track, directly in a moving car lane.
  for (const object of batches.filter(o => ['hydrant', 'parked_bike', 'bike_rack', 'stop_shelter'].includes(o.userData.asset))) {
    const im = object as THREE.InstancedMesh
    im.geometry.computeBoundingBox()
    for (let i = 0; i < im.count; i++) {
      const matrix = new THREE.Matrix4()
      im.getMatrixAt(i, matrix)
      const box = im.geometry.boundingBox!.clone().applyMatrix4(matrix)
      for (const road of plan.roads) {
        if (road.pedestrianOnly || road.transitOnly) continue
        const hw = roadHalfWidth(road.cls, road.coord)
        const overlaps = road.axis === 'x'
          ? box.max.x > road.from && box.min.x < road.to && box.max.z > road.coord - hw && box.min.z < road.coord + hw
          : box.max.z > road.from && box.min.z < road.to && box.max.x > road.coord - hw && box.min.x < road.coord + hw
        expect(overlaps, `${im.userData.asset} ${i} overlaps ${road.axis} road ${road.coord}`).toBe(false)
      }
    }
  }
  const station = createStation(plan.buildings.find(b => b.kind === 'transit-hub')!, mats, models)
  expect(station.group.children.some(o => o.userData.asset === 'ticket_kiosk')).toBe(true)
  for (const x of [-13, 13]) {
    expect(station.colliders.some(c => x >= c.minX && x <= c.maxX && 14.6 >= c.minZ && 14.6 <= c.maxZ)).toBe(false)
  }
})

test('broadleaf canopies remain closed after shape variation instead of opening black cracks', () => {
  const environment = createEnvironment(planCity(), mats)
  const canopies = environment.group.children.filter(o => o instanceof THREE.Mesh && o.geometry.name === 'Closed broadleaf canopy') as THREE.Mesh[]
  expect(canopies).toHaveLength(4)
  for (const mesh of canopies) {
    const positions = mesh.geometry.getAttribute('position'), index = mesh.geometry.getIndex()
    const edges = new Map<string, number>()
    const key = (i: number) => {
      const vertex = index ? index.getX(i) : i
      return [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)].map(n => Math.round(n * 1e5)).join(',')
    }
    for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
      const points = [key(i), key(i + 1), key(i + 2)]
      for (let side = 0; side < 3; side++) {
        const edge = [points[side], points[(side + 1) % 3]].sort().join('|')
        edges.set(edge, (edges.get(edge) ?? 0) + 1)
      }
    }
    expect([...edges.values()].filter(count => count !== 2)).toHaveLength(0)
  }
})

test('the garden square renders its actual Blender landmarks and market kiosks', async () => {
  const models = await loadBundle('civic')
  const square = createCityCenter(mats, models)
  const batches: THREE.InstancedMesh[] = []
  square.group.traverse(o => { if (o instanceof THREE.InstancedMesh && o.userData.asset) batches.push(o) })
  for (const [key, count] of [['civic_fountain', 1], ['civic_clock', 1], ['market_kiosk', 2]] as const) {
    expect(models.has(key)).toBe(true)
    expect(batches.some(im => im.userData.asset === key && im.count === count)).toBe(true)
  }
  const cafe = planCity().enterables.find(e => e.interiorKind === 'cafe')!
  expect(cafe.facing).toBe(180)
  expect(cafe.doorZ).toBe(-27.5)
  expect(square.colliders.some(c => cafe.doorX >= c.minX && cafe.doorX <= c.maxX && cafe.doorZ >= c.minZ && cafe.doorZ <= c.maxZ)).toBe(false)
})
