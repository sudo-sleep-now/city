import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SpatialBatches } from '../src/lib/city/spatial-batches'
import { AdaptiveQuality, initialQuality, renderPixelRatio, QUALITY_SETTINGS } from '../src/lib/city/render-quality'

test('spatial batches preserve transformed instances, colours and shadows, while culling distant cells', () => {
  const root = new THREE.Group()
  root.position.set(27, 0, -19)
  root.rotation.y = .7
  const source = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 4, 3), new THREE.MeshStandardMaterial(), 16)
  source.position.x = 9
  source.castShadow = source.receiveShadow = true
  const matrix = new THREE.Matrix4(), colour = new THREE.Color()
  const expected: number[][] = []
  for (let i = 0; i < source.count; i++) {
    matrix.makeTranslation(i * 100 - 750, 2, i % 2 * 100)
    source.setMatrixAt(i, matrix)
    source.setColorAt(i, colour.setRGB(i / 16, .5, .25))
  }
  root.add(source)
  root.updateMatrixWorld(true)
  for (let i = 0; i < source.count; i++) {
    source.getMatrixAt(i, matrix)
    const point = new THREE.Vector3().setFromMatrixPosition(matrix.premultiply(source.matrixWorld))
    source.getColorAt(i, colour)
    expected.push([...point.toArray(), ...colour.toArray()])
  }
  const batches = new SpatialBatches(160, 0)
  batches.add(root)
  const actual: number[][] = []
  root.traverseVisible(node => {
    if (!(node instanceof THREE.InstancedMesh)) return
    expect(node.castShadow && node.receiveShadow).toBe(true)
    expect(node.geometry).toBe(source.geometry)
    for (let i = 0; i < node.count; i++) {
      node.getMatrixAt(i, matrix)
      const point = new THREE.Vector3().setFromMatrixPosition(matrix.premultiply(node.matrixWorld))
      node.getColorAt(i, colour)
      actual.push([...point.toArray(), ...colour.toArray()])
    }
  })
  expect(actual.sort((a, b) => a[0] - b[0])).toEqual(expected.sort((a, b) => a[0] - b[0]))
  batches.update(new THREE.Vector3(), 200)
  expect(root.children.filter(c => c.visible).length).toBeLessThan(root.children.length)
  batches.update(new THREE.Vector3(), Infinity)
  expect(root.children.filter(c => c.visible)).toEqual([source])
  batches.update(new THREE.Vector3(), 200)
  expect(source.visible).toBe(false)
})

test('merged geometry partitions preserve material groups, triangle winding, normals, UVs and vertex colours', () => {
  const boxes = Array.from({ length: 20 }, (_, i) => {
    const geo = new THREE.BoxGeometry(8, 6, 8).translate(i * 80 - 800, 3, i % 2 * 100)
    geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(geo.attributes.position.count * 3).fill(i * 10), 3, true))
    return geo
  })
  const material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]
  const geo = mergeGeometries(boxes, true)!
  geo.groups.forEach((g, i) => { g.materialIndex = i % 2 })
  const source = new THREE.Mesh(geo, material), root = new THREE.Group()
  root.add(source)
  const signature = (group: THREE.Object3D) => {
    const triangles: string[] = []
    group.traverseVisible(node => {
      if (!(node instanceof THREE.Mesh)) return
      const g = node.geometry, p = g.attributes.position
      for (const part of g.groups) for (let i = part.start; i < part.start + part.count; i += 3) {
        const values = [part.materialIndex]
        for (let j = 0; j < 3; j++) {
          const index = g.index?.getX(i + j) ?? i + j
          for (const name of ['position', 'normal', 'uv', 'color']) {
            const attr = g.attributes[name] as THREE.BufferAttribute
            for (let c = 0; c < attr.itemSize; c++) values.push(attr.getComponent(index, c))
          }
        }
        triangles.push(JSON.stringify(values))
      }
      expect(p.count).toBeGreaterThan(0)
    })
    return triangles.sort()
  }
  const before = signature(root)
  const batches = new SpatialBatches(160, 0)
  batches.add(root)
  expect(batches.count).toBeGreaterThan(2)
  expect(signature(root)).toEqual(before)
})

test('animated and dynamic instance buffers are never replaced by static chunks', () => {
  const root = new THREE.Group(), geo = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial()
  const dynamic = new THREE.InstancedMesh(geo, material, 16)
  dynamic.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const animated = new THREE.InstancedMesh(geo, material, 16)
  animated.frustumCulled = false
  root.add(dynamic, animated)
  new SpatialBatches().add(root)
  expect(root.children).toEqual([dynamic, animated])
})

test('automatic quality reacts to sustained slow frames, ignores background stalls and recovers slowly', () => {
  const auto = new AdaptiveQuality('balanced', 'balanced')
  for (let i = 0; i < 300; i++) auto.sample(1 / 30)
  expect(auto.level).toBe('performance')
  for (let i = 0; i < 1000; i++) auto.sample(3)
  expect(auto.level).toBe('performance')
  for (let i = 0; i < 600; i++) auto.sample(1 / 60)
  expect(auto.level).toBe('performance')
  for (let i = 0; i < 1200; i++) auto.sample(1 / 60)
  expect(auto.level).toBe('balanced')
  for (let i = 0; i < 1800; i++) auto.sample(1 / 60)
  expect(auto.level).toBe('balanced')
  const verySlow = new AdaptiveQuality('balanced', 'balanced')
  for (let i = 0; i < 40; i++) verySlow.sample(.3)
  expect(verySlow.level).toBe('performance')
})

test('low-end selection and framebuffer budgets cover touch devices and large high-DPI screens', () => {
  expect(initialQuality({ touch: false, cores: 4 })).toBe('performance')
  expect(initialQuality({ touch: false, memory: 4 })).toBe('performance')
  expect(initialQuality({ touch: true, cores: 16 })).toBe('performance')
  expect(initialQuality({ touch: false })).toBe('balanced')
  for (const level of ['performance', 'balanced', 'high'] as const) {
    const ratio = renderPixelRatio(level, 3840, 2160, 3)
    expect(3840 * 2160 * ratio ** 2).toBeLessThanOrEqual(QUALITY_SETTINGS[level].pixelBudget + .001)
  }
  expect(renderPixelRatio('high', 800, 600, 1)).toBe(1)
})
