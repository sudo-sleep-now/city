import * as THREE from 'three'
import type { AABB, BuildingSpec, CityMaterials } from './types'
import type { ModelLibrary } from './models'
import { addPropInstances } from './authored-props'

export interface StationBuild {
  group: THREE.Group
  colliders: AABB[]
}

/**
 * Local geometry for the Solheim Interchange hall. The parent should position
 * this group at the CentralStation building spec's (x,z), just as it positions
 * other special-building groups. The south (+Z) face is the public entrance.
 */
export function createStation(_building: BuildingSpec, _mats: CityMaterials, models: ModelLibrary = new Map()): StationBuild {
  const group = new THREE.Group()
  const stone = new THREE.MeshStandardMaterial({ color: '#b7b5a8', roughness: 0.88 })
  const roof = new THREE.MeshStandardMaterial({ color: '#343c3a', roughness: 0.48, metalness: 0.55 })
  const mullion = new THREE.MeshStandardMaterial({ color: '#414c49', roughness: 0.4, metalness: 0.65 })
  const glass = new THREE.MeshStandardMaterial({ color: '#8eb6b1', roughness: 0.18, metalness: 0.22, transparent: true, opacity: 0.58 })
  const warm = new THREE.MeshStandardMaterial({ color: '#f1d39b', emissive: '#b47c35', emissiveIntensity: 0.35, roughness: 0.3 })

  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }
  const sign = (text: string, w: number, h: number, x: number, y: number, z: number, bg: string, fg: string) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), _mats.signMaterial(text, { bg, fg, w: 1024, h: 160 }))
    mesh.position.set(x, y, z)
    group.add(mesh)
    return mesh
  }

  // Broad civic hall, with glazed south facade and two unmistakable open doors.
  box(64, 0.55, 30, 0, 0.05, 0, stone)
  box(64, 1.1, 1.2, 0, 0.8, -14.4, stone)
  box(1.2, 9, 30, -31.4, 5, 0, stone)
  box(1.2, 9, 30, 31.4, 5, 0, stone)
  box(64, 0.38, 30, 0, 8.45, 0, roof)

  // North service wall; windowless side walls frame the airy hall.
  box(62, 7.7, 0.7, 0, 4.5, -14.6, stone)
  // South facade is divided into glazing bays around paired 5 m wide portals.
  const doorCenters = [-13, 13]
  for (const [a, b] of [[-30.8, -15.6], [-10.4, 10.4], [15.6, 30.8]] as const) {
    box(b - a, 6.4, 0.35, (a + b) / 2, 4.1, 14.6, glass)
    for (let x = a; x <= b; x += 3.5) box(0.12, 6.8, 0.5, x, 4.1, 14.6, mullion)
  }
  for (const dc of doorCenters) {
    const gap = 5.2
    const leftEdge = dc - gap / 2
    const rightEdge = dc + gap / 2
    // Portal piers and a bright lintel make the two door openings readable.
    box(0.42, 7.4, 0.7, leftEdge, 4.1, 14.6, stone)
    box(0.42, 7.4, 0.7, rightEdge, 4.1, 14.6, stone)
    box(gap + 0.8, 0.55, 0.8, dc, 7.55, 14.6, warm)
  }

  // Roof lantern, exposed ribs, and a deep canopy over the public front.
  box(27, 0.18, 4.4, 0, 8.65, -2, glass)
  for (let x = -13; x <= 13; x += 4.3) box(0.2, 0.55, 25, x, 8.1, -1.5, mullion)
  box(64, 0.35, 4.2, 0, 7.9, 16.1, roof)
  for (const x of [-28, -18, -8, 8, 18, 28]) box(0.3, 7.2, 0.3, x, 4.1, 13.6, mullion)

  sign('SOLHEIM INTERCHANGE', 23, 1.65, 0, 7.05, 18.35, '#26332f', '#f5e9cc')
  sign('B1  CITY LOOP  /  BAY A', 8, 0.85, 0, 5.9, 14.94, '#173b33', '#e5f2d8')

  // Visible hall contents behind the glazing: a long departure board and
  // freestanding information blades. Kept clear of both entrance paths.
  box(15, 2.2, 0.28, 0, 6.1, -11.6, roof)
  const board = new THREE.Mesh(new THREE.PlaneGeometry(14.5, 1.7), _mats.signMaterial('B1 CITY LOOP  /  BOARD AT BAY A  /  BUSES ENTER AND LEAVE VIA EAST DRIVE', { bg: '#101b18', fg: '#f2c56f', w: 1000, h: 180 }))
  board.position.set(0, 6.1, -11.4)
  group.add(board)
  for (const x of [-22, 22]) {
    box(0.18, 4.5, 0.18, x, 2.3, -3, mullion)
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.85), _mats.signMaterial(x < 0 ? 'B1  →  BAYS' : 'EXIT  →  PLAZA', { bg: '#214a39', fg: '#ffffff', w: 420, h: 120 }))
    blade.position.set(x, 3.6, -2.85)
    group.add(blade)
  }

  // The visual shell is a single broad hall volume; the open south portals are
  // preserved by split wall colliders. The caller can combine these with its
  // normal building bounds if its collision system requires a footprint.
  const colliders: AABB[] = [
    { minX: -32, maxX: -31, minZ: -15, maxZ: 15, h: 9 },
    { minX: 31, maxX: 32, minZ: -15, maxZ: 15, h: 9 },
    { minX: -31, maxX: 31, minZ: -15, maxZ: -14, h: 9 },
    { minX: -31, maxX: -15.6, minZ: 14.3, maxZ: 15, h: 9 },
    { minX: -10.4, maxX: 10.4, minZ: 14.3, maxZ: 15, h: 9 },
    { minX: 15.6, maxX: 31, minZ: 14.3, maxZ: 15, h: 9 },
  ]
  // Furniture sits inside the hall, away from the two entrance axes at ±13 m.
  if (addPropInstances(group, models, 'ticket_kiosk', [-5, 5].map(x => ({ x, y: .325, z: 8, ry: Math.PI })))) {
    for (const x of [-5, 5]) colliders.push({ minX: x - .4, maxX: x + .4, minZ: 7.7, maxZ: 8.3, h: 2 })
    sign('TICKETS  /  CONTACTLESS', 5.2, .55, 0, 2.8, 8.25, '#203e36', '#f5f0dc')
  }
  if (addPropInstances(group, models, 'station_bench', [-27, 27].flatMap(x => [-6, 3].map(z => ({ x, y: .325, z, ry: x < 0 ? -Math.PI / 2 : Math.PI / 2 }))))) {
    for (const x of [-27, 27]) for (const z of [-6, 3]) colliders.push({ minX: x - .35, maxX: x + .35, minZ: z - 1.25, maxZ: z + 1.25, h: 1.25 })
  }
  return { group, colliders }
}

/**
 * Forecourt objects are separate because road/sidewalk construction is owned
 * by the city engine. Position this group at (50,-148), aligned with the hall.
 */
export function createStationForecourt(mats: CityMaterials, models: ModelLibrary = new Map()): THREE.Group {
  const group = new THREE.Group()
  const metal = mats.metalDark
  const pole = mats.poleMetal
  const slab = mats.concreteLight
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    m.position.set(x, y, z)
    m.castShadow = true
    m.receiveShadow = true
    group.add(m)
    return m
  }
  const asphalt = new THREE.Mesh(new THREE.BoxGeometry(75, 0.06, 26), mats.asphalt)
  asphalt.position.set(10.5, 0.025, 32) // world x23..98, z-129..-103
  asphalt.receiveShadow = true
  group.add(asphalt)
  // Boarding pavement directly outside the hall: the bus doors face it.
  box(46, 0.16, 3.8, 8, 0.08, 17.9, slab)
  box(45, 0.035, 0.22, 8, 0.185, 19.72, mats.fabricOrange)
  for (const x of [-13, 29]) box(0.12, 2.8, 0.12, x, 1.6, 16.7, metal)
  box(44, 0.16, 2.8, 8, 3.05, 17.1, mats.metal)
  if (!addPropInstances(group, models, 'station_bench', [-10, 25].map(x => ({ x, y: .16, z: 16.7, ry: Math.PI })))) {
    for (const x of [-10, 25]) box(2.4, 0.12, 0.5, x, 0.62, 16.7, mats.wood)
  }
  addPropInstances(group, models, 'ticket_kiosk', [{ x: -23, y: .16, z: 17, ry: Math.PI }])
  addPropInstances(group, models, 'litter_bin', [{ x: -16.5, y: .16, z: 17 }, { x: 31, y: .16, z: 17 }])
  const label = (text: string, x: number, z: number, rotation = 0) => {
    box(0.09, 2.8, 0.09, x, 1.5, z, pole)
    const face = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 0.9), mats.signMaterial(text, { bg: '#183d32', fg: '#ffffff', w: 768, h: 128 }))
    face.position.set(x, 2.65, z + 0.06)
    face.rotation.y = rotation
    group.add(face)
  }
  label('BAY A  /  B1 CITY LOOP', 8, 19.2)
  label('BUS ARRIVALS', 42, 18.7, -Math.PI / 2)
  label('BUS EXIT', 41, 39.3, -Math.PI / 2)
  label('WALK TO TRAM T1', -33.5, 13.5)
  // Flush paths meet the two real entrance portals, no glass wall in the way.
  for (const x of [-13, 13]) box(4.2, 0.045, 4.4, x, 0.045, 16.5, mats.parkPath)
  // A signed pedestrian connection follows the western side of the hall.
  box(3.0, 0.045, 49, -34, 0.045, -9, mats.parkPath)
  // Painted directional arrows trace arrival, the turning circle and exit.
  const arrow = (x: number, z: number, ry: number) => {
    const shape = new THREE.Shape()
    shape.moveTo(-.3,-2); shape.lineTo(.3,-2); shape.lineTo(.3,.6)
    shape.lineTo(1.0,.6); shape.lineTo(0,2); shape.lineTo(-1.0,.6)
    shape.lineTo(-.3,.6); shape.closePath()
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mats.roadLine)
    mesh.rotation.set(-Math.PI/2, 0, ry)
    mesh.position.set(x, .075, z)
    group.add(mesh)
  }
  arrow(24, 21.4, -Math.PI/2)
  arrow(-19, 32, 0)
  arrow(24, 42.6, Math.PI/2)
  return group
}
