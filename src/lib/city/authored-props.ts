import * as THREE from 'three'
import type { ModelLibrary } from './models'

export interface PropPlacement {
  x: number
  y: number
  z: number
  ry?: number
  sx?: number
  sy?: number
  sz?: number
}

/** Bake every primitive relative to its asset root, including nested material
 * groups from Blender's GLB exporter. Repeated props share GPU batches rather
 * than cloning a scene graph for every hydrant or bicycle. */
export function addPropInstances(
  parent: THREE.Group,
  models: ModelLibrary,
  key: string,
  placements: PropPlacement[],
): boolean {
  const model = models.get(key)
  if (!model || placements.length === 0) return false
  model.updateWorldMatrix(true, true)
  const inverse = model.matrixWorld.clone().invert()
  const dummy = new THREE.Object3D()
  let added = false
  model.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return
    const geometry = mesh.geometry.clone().applyMatrix4(inverse.clone().multiply(mesh.matrixWorld))
    const im = new THREE.InstancedMesh(geometry, mesh.material, placements.length)
    im.name = `street-props/${key}/${mesh.name}`
    im.userData.asset = key
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    im.castShadow = !materials.every(m => m.transparent)
    im.receiveShadow = true
    placements.forEach((p, index) => {
      dummy.position.set(p.x, p.y, p.z)
      dummy.rotation.set(0, p.ry ?? 0, 0)
      dummy.scale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1)
      dummy.updateMatrix()
      im.setMatrixAt(index, dummy.matrix)
    })
    im.instanceMatrix.needsUpdate = true
    im.computeBoundingSphere()
    parent.add(im)
    added = true
  })
  return added
}
