import * as THREE from 'three'
import type { BuildingSpec, CityPlan, CityMaterials } from './types'
import type { ModelLibrary } from './models'

interface Placement { building: BuildingSpec; y: number; sy: number; sx: number; sz: number }

/** Reuse each authored part across the district. Windows have actual sills,
 * frames and glazing; repeating apartment floors preserves floor proportions. */
export function createAuthoredBuildings(plan: CityPlan, models: ModelLibrary, mats?: CityMaterials) {
  const group = new THREE.Group()
  group.name = 'Blender architecture'
  const replaced = new Set<string>()
  const batches = new Map<string, Placement[]>()
  let residentialVariant = 0
  const add = (key: string, placement: Placement) => {
    if (!batches.has(key)) batches.set(key, [])
    batches.get(key)!.push(placement)
  }
  for (const b of plan.buildings) {
    if (b.kind === 'retail' && b.floors === 1 && models.has('corner_shop')) {
      add('corner_shop', { building: b, y: 0, sy: b.height / 6.4, sx: b.w / 12, sz: b.d / 10 })
      replaced.add(b.id)
      if (b.label && mats) {
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(b.w * 0.78, Math.min(0.7, b.height * .14)), mats.signMaterial(b.label, { bg: '#25483c', fg: '#f3ead7', w: 768, h: 128 }))
        // The Blender fascia projects 0.22 m beyond its 10 m shell.
        // Scale that projection with the shop, then clear its stone face.
        const offset = new THREE.Vector3(0, b.height * .86, 5.22 * b.d / 10 + .035).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(b.rotation))
        sign.position.set(b.x + offset.x, offset.y, b.z + offset.z)
        sign.rotation.y = THREE.MathUtils.degToRad(b.rotation)
        group.add(sign)
      }
      continue
    }
    if (b.label || b.enterableId) continue
    if (b.kind === 'residential' && b.floors <= 3) {
      // A stable, broader authored palette gives ordinary streets distinct
      // silhouettes while retaining the original gable, hip and townhouse.
      const style = residentialVariant++ % 5
      const key = style === 0 ? 'house_modern'
        : style === 1 && b.floors >= 2 ? 'terrace_bay'
          : style === 2 && b.floors === 3 ? 'townhouse'
            : style === 2 || style === 3 ? 'house_hip' : 'house_gable'
      if (!models.has(key)) continue
      const h = key === 'house_modern' ? 8.5
        : key === 'terrace_bay' ? 10.5
          : key === 'townhouse' ? 11.6 : 8.6
      add(key, { building: b, y: 0, sy: b.height / h, sx: b.w / 12, sz: b.d / 9 })
      replaced.add(b.id)
    } else if (b.kind === 'apartment' && b.floors >= 4 && b.floors <= 8) {
      if (!['apartment_ground', 'apartment_floor', 'apartment_roof'].every((key) => models.has(key))) continue
      const sy = b.height / (3.4 + (b.floors - 1) * 3 + 1.3)
      const placement = { building: b, sy, sx: b.w / 24, sz: b.d / 18 }
      add('apartment_ground', { ...placement, y: 0 })
      for (let floor = 1; floor < b.floors; floor++) {
        add('apartment_floor', { ...placement, y: (3.4 + (floor - 1) * 3) * sy })
      }
      add('apartment_roof', { ...placement, y: (3.4 + (b.floors - 1) * 3) * sy })
      replaced.add(b.id)
    } else if (b.kind === 'office' && b.floors >= 14 && b.floors <= 25 && models.has('office_lantern')) {
      add('office_lantern', { building: b, y: 0, sy: b.height / 64, sx: b.w / 24, sz: b.d / 20 })
      replaced.add(b.id)
    } else if ((b.kind === 'mixed' || b.kind === 'retail') && b.floors <= 3) {
      const key = b.kind === 'retail' || b.facadeVariant % 3 === 0 ? 'corner_shop' : null
      if (key && models.has(key)) {
        add(key, { building: b, y: 0, sy: b.height / 6.4, sx: b.w / 12, sz: b.d / 10 })
        replaced.add(b.id)
      }
    } else if ((b.kind === 'mixed' || b.kind === 'office') && b.floors >= 4 && b.floors <= 9 && models.has('office_stepped')) {
      add('office_stepped', { building: b, y: 0, sy: b.height / 22.4, sx: b.w / 20, sz: b.d / 18 })
      replaced.add(b.id)
    }
  }
  const dummy = new THREE.Object3D()
  const partMatrix = new THREE.Matrix4()
  for (const [key, placements] of batches) {
    const model = models.get(key)!
    model.updateMatrixWorld(true)
    const inverseRoot = model.matrixWorld.clone().invert()
    model.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      const geometry = mesh.geometry.clone()
      geometry.applyMatrix4(partMatrix.multiplyMatrices(inverseRoot, mesh.matrixWorld))
      const instances = new THREE.InstancedMesh(geometry, mesh.material, placements.length)
      instances.name = `${key}/${mesh.name}`
      instances.castShadow = true
      instances.receiveShadow = true
      const tintable = !Array.isArray(mesh.material) && /plaster|brick/i.test(mesh.material.name)
      for (const [i, p] of placements.entries()) {
        dummy.position.set(p.building.x, p.y, p.building.z)
        dummy.rotation.set(0, THREE.MathUtils.degToRad(p.building.rotation), 0)
        dummy.scale.set(p.sx, p.sy, p.sz)
        dummy.updateMatrix()
        instances.setMatrixAt(i, dummy.matrix)
        if (tintable) {
          const variation = (p.building.facadeVariant % 5) / 4
          instances.setColorAt(i, new THREE.Color().setRGB(0.83 + variation * 0.17, 0.86 + variation * 0.12, 0.82 + variation * 0.15))
        }
      }
      instances.instanceMatrix.needsUpdate = true
      if (instances.instanceColor) instances.instanceColor.needsUpdate = true
      instances.computeBoundingSphere()
      group.add(instances)
    })
  }
  return { group, replaced }
}
