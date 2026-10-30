import * as THREE from 'three'
import type { AABB, CityMaterials } from './types'

export interface MobilityInfrastructure {
  group: THREE.Group
  colliders: AABB[]
}

/** Small, curbside transfer points that make the existing B2 ring legible as
 * a connection to outer neighbourhood routes. They add no parking supply. */
export function createMobilityInfrastructure(mats: CityMaterials): MobilityInfrastructure {
  const group = new THREE.Group()
  const colliders: AABB[] = []
  const postGeo = new THREE.CylinderGeometry(0.09, 0.12, 2.8, 6)
  const roofGeo = new THREE.BoxGeometry(10, 0.24, 3.4)
  const benchGeo = new THREE.BoxGeometry(2.2, 0.12, 0.42)
  const rackGeo = new THREE.TorusGeometry(0.42, 0.045, 5, 10, Math.PI)

  // Compact footprints sit just inside the ring road, leaving the sidewalk
  // and existing bus stop approach open. South remains a future option.
  const hubs = [
    { name: 'NORTH TRANSFER', x: 325, z: -580, ry: 0 },
    { name: 'WEST TRANSFER', x: -585, z: -25, ry: Math.PI / 2 },
    { name: 'EAST TRANSFER', x: 585, z: 21, ry: -Math.PI / 2 },
  ]

  const addCollider = (x: number, z: number, w: number, d: number, h: number) => {
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h })
  }

  for (const hub of hubs) {
    const place = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(x, y, z)
      mesh.rotation.y = ry
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
      return mesh
    }
    const dx = Math.sin(hub.ry) * 2.4
    const dz = Math.cos(hub.ry) * 2.4
    // Canopy, open sides, a bench, and a short row of bicycle hoops.
    place(roofGeo, mats.metalDark, hub.x, 3.05, hub.z, hub.ry)
    for (const side of [-1, 1]) {
      const px = hub.x + Math.cos(hub.ry) * side * 4.55
      const pz = hub.z - Math.sin(hub.ry) * side * 4.55
      place(postGeo, mats.poleMetal, px, 1.4, pz)
      addCollider(px, pz, 0.24, 0.24, 2.8)
    }
    const benchX = hub.x + dx
    const benchZ = hub.z + dz
    place(benchGeo, mats.wood, benchX, 0.55, benchZ, hub.ry)
    addCollider(benchX, benchZ, hub.ry === 0 ? 2.2 : 0.42, hub.ry === 0 ? 0.42 : 2.2, 0.66)
    for (let i = -1; i <= 1; i++) {
      const rack = place(rackGeo, mats.poleMetal, hub.x + i * 1.25, 0.55, hub.z - dz, hub.ry)
      rack.scale.set(1, 1.25, 1)
    }

    // A clear, high-contrast transfer marker with a simple route band.
    const signX = hub.x + Math.cos(hub.ry) * 5.1
    const signZ = hub.z - Math.sin(hub.ry) * 5.1
    const signPole = place(new THREE.CylinderGeometry(0.07, 0.07, 2.1, 6), mats.poleMetal, signX, 1.05, signZ)
    signPole.castShadow = false
    addCollider(signX, signZ, 0.14, 0.14, 2.1)
    const signMat = mats.signMaterial(`${hub.name} · B2`, { bg: '#174b3a', fg: '#f3f5e9', w: 256, h: 72 })
    place(new THREE.BoxGeometry(1.8, 0.62, 0.12), signMat, signX, 2.0, signZ, hub.ry)
  }

  return { group, colliders }
}
