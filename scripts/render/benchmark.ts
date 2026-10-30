/// <reference types="bun-types" />
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createMaterials } from '../../src/lib/city/materials'
import { planCity } from '../../src/lib/city/planner'
import { buildRoadNetwork, createRoadMeshes } from '../../src/lib/city/roads'
import { createBuildings } from '../../src/lib/city/buildings'
import { createEnvironment } from '../../src/lib/city/environment'
import { buildTourStops } from '../../src/lib/city/tour'
import { SpatialBatches } from '../../src/lib/city/spatial-batches'

// Geometry-only benchmark, with the real assets. Texture pixels do not affect
// frustum submission, so canvas drawing is stubbed; no GPU/FPS claims here.
const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient,
  set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
globalThis.ProgressEvent ??= class extends Event { lengthComputable = false; loaded = 0; total = 0 } as typeof ProgressEvent

const models = new Map<string, THREE.Group>()
for (const file of ['architecture', 'street-props', 'civic']) {
  const data = new Uint8Array(await Bun.file(new URL(`../../public/models/${file}.glb`, import.meta.url)).arrayBuffer())
  const view = new DataView(data.buffer), jsonLength = view.getUint32(12, true)
  const doc = JSON.parse(new TextDecoder().decode(data.slice(20, 20 + jsonLength)))
  for (const m of doc.materials ?? []) {
    delete m.pbrMetallicRoughness?.baseColorTexture
    delete m.pbrMetallicRoughness?.metallicRoughnessTexture
    delete m.normalTexture; delete m.emissiveTexture; delete m.occlusionTexture
  }
  delete doc.textures; delete doc.images; delete doc.samplers
  doc.buffers = [{ byteLength: view.getUint32(20 + jsonLength, true), uri: `data:application/octet-stream;base64,${Buffer.from(data.slice(28 + jsonLength)).toString('base64')}` }]
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '')
  for (const root of gltf.scene.children) models.set(root.name, root as THREE.Group)
}
const plan = planCity(), mats = createMaterials(), network = buildRoadNetwork(plan)
const scene = new THREE.Scene()
const roads = createRoadMeshes(plan, mats, network), buildings = createBuildings(plan, mats, models), environment = createEnvironment(plan, mats, models)
scene.add(roads, buildings.group, environment.group)
scene.updateMatrixWorld(true)
const stops = buildTourStops(plan.stats)
const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4()
function measure(x: number, z: number, yaw: number, pitch = 0, height = 1.7, far = 1600) {
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, .1, far)
  camera.position.set(x, height, z)
  camera.rotation.order = 'YXZ'
  camera.rotation.set(pitch, yaw, 0)
  camera.updateMatrixWorld(true)
  frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
  let triangles = 0, calls = 0
  scene.traverseVisible(node => {
    if (!(node instanceof THREE.Mesh) || node.frustumCulled && !frustum.intersectsObject(node)) return
    const g = node.geometry, instances = node instanceof THREE.InstancedMesh ? node.count : 1
    const count = g.index?.count ?? g.attributes.position.count
    if (Array.isArray(node.material)) {
      for (const part of g.groups) if (node.material[part.materialIndex ?? 0]?.visible) {
        calls++; triangles += part.count / 3 * instances
      }
    } else if (node.material.visible) { calls++; triangles += count / 3 * instances }
  })
  return { triangles, calls }
}
const before = stops.map(s => measure(s.x, s.z, s.yaw, s.pitch))
const overviewBefore = measure(0, 640, 0, -Math.atan2(760, 640), 760, 2400)
const chunks = new SpatialBatches()
const start = performance.now()
chunks.add(roads); chunks.add(buildings.group); chunks.add(environment.group)
const partitionMs = performance.now() - start
const results = stops.map((s, i) => {
  chunks.update(new THREE.Vector3(s.x, 1.7, s.z), 1600)
  const high = measure(s.x, s.z, s.yaw, s.pitch)
  chunks.update(new THREE.Vector3(s.x, 1.7, s.z), 420)
  const performance = measure(s.x, s.z, s.yaw, s.pitch)
  return { view: s.title, before: before[i], high, performance, triangleReductionPercent: Math.round((1 - performance.triangles / before[i].triangles) * 100) }
})
chunks.update(new THREE.Vector3(0, 760, 640), Infinity)
const overviewAfter = measure(0, 640, 0, -Math.atan2(760, 640), 760, 2400)
const report = { scope: 'Static world camera-pass submission at 16:9; excludes shadows, moving traffic and rasterisation. Not measured low-end FPS.', chunkCount: chunks.count, partitionMs: Math.round(partitionMs), overview: { before: overviewBefore, after: overviewAfter }, results }
console.log(JSON.stringify(report, null, 2))
if (process.argv.includes('--save')) await Bun.write(new URL('../../assets/benchmarks/render-performance.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
