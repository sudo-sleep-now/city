import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { worldUVPlane } from './materials'
import type { AABB, CityMaterials } from './types'
import type { ModelLibrary } from './models'
import { addPropInstances } from './authored-props'

export interface CityCenterResult {
  group: THREE.Group
  colliders: AABB[]
  seats: { x: number; z: number; ry: number; base?: number }[]
  streetLights: THREE.Vector3[]
  animated?: (t: number) => void
}

/** Civic plaza set dressing. Benches are deliberately returned as locations so
 * the environment can render its shared bench model and attach sit behavior. */
export function createCityCenter(mats: CityMaterials, models: ModelLibrary): CityCenterResult {
  const group = new THREE.Group()
  group.name = 'solheim-civic-square'
  const colliders: AABB[] = []
  const seats: CityCenterResult['seats'] = []
  const streetLights: THREE.Vector3[] = []
  const dummy = new THREE.Object3D()

  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, items: { x: number; y: number; z: number; ry?: number; sx?: number; sy?: number; sz?: number }[], shadow = true) => {
    if (!items.length) return
    const mesh = new THREE.InstancedMesh(geo, mat, items.length)
    items.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z)
      dummy.rotation.set(0, p.ry ?? 0, 0)
      dummy.scale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = shadow
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }
  const box = (w: number, h: number, d: number, mat: THREE.Material, items: { x: number; y: number; z: number; ry?: number }[], shadow = true) =>
    instanced(new THREE.BoxGeometry(w, h, d), mat, items, shadow)
  const cylinder = (rt: number, rb: number, h: number, mat: THREE.Material, items: { x: number; y: number; z: number; ry?: number; sx?: number; sy?: number; sz?: number }[], sides = 12, shadow = true) =>
    instanced(new THREE.CylinderGeometry(rt, rb, h, sides), mat, items, shadow)
  const sphere = (mat: THREE.Material, items: { x: number; y: number; z: number; sx?: number; sy?: number; sz?: number }[]) =>
    instanced(new THREE.SphereGeometry(1, 9, 7), mat, items, false)
  const collider = (x: number, z: number, w: number, d: number, h: number) => colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h })

  // Warm, finely jointed stone surfacing with a darker border. Slightly raised
  // above the underlying block deck to avoid z-fighting with the old paving.
  const paving = new THREE.Mesh(worldUVPlane(new THREE.PlaneGeometry(77, 78), 77, 78, 4), mats.plaza)
  paving.rotation.x = -Math.PI / 2
  paving.position.set(55.5, 0.028, -53)
  paving.receiveShadow = true
  group.add(paving)
  const edgeStrips = [
    { w: 76.4, d: 0.42, x: 55.5, z: -14.35 }, { w: 76.4, d: 0.42, x: 55.5, z: -91.65 },
    { w: 0.42, d: 76.4, x: 17.35, z: -53 }, { w: 0.42, d: 76.4, x: 93.65, z: -53 },
  ]
  for (const e of edgeStrips) {
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(e.w, e.d), mats.concreteLight)
    edge.rotation.x = -Math.PI / 2
    edge.position.set(e.x, 0.038, e.z)
    group.add(edge)
  }

  // Contrasting limestone bands keep the routes legible without turning the
  // public square into an asphalt-looking cross.
  const pathStone = mats.plaza.clone()
  pathStone.color.set('#b2a590')
  const axes = [
    { x: 50, z: -76, w: 4, d: 32 }, { x: 50, z: -29, w: 4, d: 30 },
    { x: 29.5, z: -52, w: 25, d: 4 }, { x: 76, z: -52, w: 36, d: 4 },
  ]
  for (const a of axes) {
    const m = new THREE.Mesh(worldUVPlane(new THREE.PlaneGeometry(a.w, a.d), a.w, a.d, 4), pathStone)
    m.rotation.x = -Math.PI / 2
    m.position.set(a.x, 0.04, a.z)
    group.add(m)
  }
  const fountainWalk = new THREE.Mesh(new THREE.RingGeometry(4.75, 6.6, 64), pathStone)
  fountainWalk.rotation.x = -Math.PI / 2
  fountainWalk.position.set(50, .043, -52)
  fountainWalk.receiveShadow = true
  group.add(fountainWalk)

  // Fine modular stone joints, kept outside the clear 4m movement ribbons.
  const jointItems: { x: number; y: number; z: number }[] = []
  for (let x = 20; x <= 91; x += 6) {
    for (let z = -89; z <= -17; z += 6) {
      if ((x >= 48 && x <= 52) || (z >= -54 && z <= -50)) continue
      jointItems.push({ x, y: 0.041, z })
    }
  }
  instanced(new THREE.BoxGeometry(0.035, 0.006, 5.6), mats.concrete, jointItems, false)

  // Main civic fountain. Prefer the authored sculpted stone asset, with a
  // composed tiered basin fallback so an offline asset cache still looks done.
  const hasFountainAsset = addPropInstances(group, models, 'civic_fountain', [{ x: 50, y: 0.05, z: -52 }])
  if (!hasFountainAsset) {
    cylinder(3.65, 3.9, 0.48, mats.concreteLight, [{ x: 50, y: 0.29, z: -52 }], 32)
    cylinder(3.25, 3.55, 0.24, mats.concrete, [{ x: 50, y: 0.64, z: -52 }], 32)
    cylinder(2.8, 3.1, 0.3, mats.concreteLight, [{ x: 50, y: 0.91, z: -52 }], 32)
    cylinder(1.42, 1.72, 0.42, mats.concreteLight, [{ x: 50, y: 1.18, z: -52 }], 24)
    cylinder(0.62, 0.82, 0.65, mats.concrete, [{ x: 50, y: 1.67, z: -52 }], 20)
    cylinder(0.24, 0.34, 0.48, mats.concreteLight, [{ x: 50, y: 2.22, z: -52 }], 16)
    cylinder(2.9, 2.9, 0.045, mats.water, [{ x: 50, y: 0.79, z: -52 }], 32, false)
  }
  collider(50, -52, 8.2, 8.2, 2.55)

  // Four slender rising jets animate as a single instanced batch. The dark
  // water material stays transparent and uses no per-jet point lights.
  const jetMat = new THREE.MeshBasicMaterial({ color: '#b8e5e8', transparent: true, opacity: 0.48, depthWrite: false })
  const jetGeo = new THREE.CylinderGeometry(0.035, 0.075, 1, 7)
  const jets = new THREE.InstancedMesh(jetGeo, jetMat, 4)
  const jetPoints: { x: number; z: number }[] = []
  for (const [dx, dz] of [[-2.1, 0], [2.1, 0], [0, -2.1], [0, 2.1]]) jetPoints.push({ x: 50 + dx, z: -52 + dz })
  const jetBase = hasFountainAsset ? 0.45 : 0.812
  const updateJets = (t: number) => {
    jetPoints.forEach((p, i) => {
      const h = 0.82 + (Math.sin(t * 2.1 + i * 1.7) + 1) * 0.29
      dummy.position.set(p.x, jetBase + h / 2, p.z)
      dummy.scale.set(1, h, 1)
      dummy.updateMatrix()
      jets.setMatrixAt(i, dummy.matrix)
    })
    jets.instanceMatrix.needsUpdate = true
  }
  jets.castShadow = false
  group.add(jets)
  updateJets(0)

  // Market kiosks face west across the square. The authored asset carries the
  // timber counter, canopy and label board; provide a neat fallback shell.
  const kiosks = [{ x: 87, y: 0.04, z: -43, ry: Math.PI / 2 }, { x: 87, y: 0.04, z: -64, ry: Math.PI / 2 }]
  const hasKioskModel = addPropInstances(group, models, 'market_kiosk', kiosks)
  if (!hasKioskModel) {
    box(3.8, 2.25, 2.8, mats.wood, kiosks.map((p) => ({ x: p.x, y: 1.17, z: p.z, ry: p.ry })))
    box(4.1, 0.18, 3.15, mats.fabricGreen, kiosks.map((p) => ({ x: p.x, y: 2.4, z: p.z, ry: p.ry })))
    box(2.4, .44, .08, mats.wood, kiosks.map(p => ({ x: 85.55, y: 2.6, z: p.z, ry: p.ry })), false)
  }
  // The labels sit over the authored fascia as well as the fallback kiosks.
  // Their normal points west, matching the transformed local -Z asset front.
  for (const [i, p] of kiosks.entries()) {
    const fascia = new THREE.Mesh(
      new THREE.PlaneGeometry(hasKioskModel ? 1.7 : 2.2, hasKioskModel ? .13 : .34),
      mats.signMaterial(i === 0 ? 'FLOWERS' : 'COFFEE & LOCAL GOODS', { bg: '#2f5142', fg: '#fff4dc', w: 512, h: 128 }),
    )
    // Match the scaled Blender fascia face, just in front of its brass pins.
    fascia.position.set(hasKioskModel ? 85.68 : 85.48, hasKioskModel ? 2.63 : 2.6, p.z)
    fascia.rotation.y = -Math.PI / 2
    group.add(fascia)
  }
  kiosks.forEach((p) => collider(p.x, p.z, 4.2, 4.7, 3.5))

  // Clock landmark anchors the southeast corner, leaving a broad approach.
  if (!addPropInstances(group, models, 'civic_clock', [{ x: 83, y: 0.04, z: -78 }])) {
    cylinder(0.62, 0.78, 0.42, mats.concreteLight, [{ x: 83, y: 0.25, z: -78 }], 8)
    cylinder(0.31, 0.42, 9.2, mats.concreteLight, [{ x: 83, y: 5.05, z: -78 }], 8)
    cylinder(0.45, 0.4, 0.75, mats.concreteLight, [{ x: 83, y: 10.1, z: -78 }], 10)
    const dial = new THREE.Mesh(new THREE.CircleGeometry(0.31, 20), new THREE.MeshStandardMaterial({ color: '#e8dfc4', emissive: '#e8b96f', emissiveIntensity: 0.12 }))
    dial.position.set(83, 10.1, -77.57)
    group.add(dial)
    box(0.035, 0.22, 0.035, mats.metalDark, [{ x: 83, y: 10.15, z: -77.52 }], false)
    box(0.16, 0.035, 0.035, mats.metalDark, [{ x: 83.06, y: 10.2, z: -77.52 }], false)
  }
  collider(83, -78, 3.8, 3.8, 11)

  // Shaded timber pergola: 4×3 posts and closely spaced open slats. It marks a
  // resting garden room at the west side without roof mass blocking sightlines.
  const px = [21.5, 27, 32.5, 38]
  const pz = [-75.5, -72, -68.5]
  const posts: { x: number; y: number; z: number }[] = []
  px.forEach((x) => pz.forEach((z) => posts.push({ x, y: 1.6, z })))
  box(0.22, 3.2, 0.22, mats.wood, posts)
  box(17, 0.24, 0.24, mats.wood, [-75.5, -68.5].flatMap((z) => [
    { x: 29.75, y: 3.18, z },
  ]))
  const slats: { x: number; y: number; z: number }[] = []
  for (let x = 21.3; x <= 38.2; x += 1.15) slats.push({ x, y: 3.34, z: -72 })
  box(0.12, 0.14, 7.2, mats.wood, slats)
  // Climbing greenery softens the timber edges without closing the slatted
  // roof or placing low obstacles across the seating garden.
  const vines: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = []
  for (let x = 22.2; x < 38; x += 1.1) for (const z of [-75.5, -68.5]) {
    vines.push({ x, y: 3.37 + Math.sin(x) * .08, z, sx: .66, sy: .20, sz: .44 })
  }
  sphere(mats.foliageDark, vines)
  posts.forEach((p) => collider(p.x, p.z, 0.32, 0.32, 3.25))
  // Square name plaque on the north beam, facing the main approach.
  box(2.7, 0.42, 0.08, mats.signMaterial('SOLHEIM SQUARE', { bg: '#35483e', fg: '#f5e7c6', w: 512, h: 112 }), [{ x: 29.75, y: 2.75, z: -68.33 }], false)
  seats.push(
    { x: 24.5, z: -71.9, ry: -Math.PI / 2 }, { x: 35, z: -71.9, ry: Math.PI / 2 },
    { x: 29.75, z: -70, ry: Math.PI }, { x: 29.75, z: -74, ry: 0 },
  )

  // Layered planting beds, with mounded shrub and perennial clusters instead
  // of scattered single dots. Planting remains clear of the two main axes.
  const beds = [
    { x: 21, z: -23.5, w: 7.2, d: 3.2 }, { x: 36, z: -23.5, w: 7.2, d: 3.2 },
    { x: 66, z: -23.5, w: 7.2, d: 3.2 }, { x: 90, z: -23.5, w: 5.8, d: 3.2 },
    { x: 20.5, z: -84.5, w: 6.2, d: 3.2 }, { x: 39, z: -84.5, w: 7.2, d: 3.2 },
    { x: 68, z: -84.5, w: 7.2, d: 3.2 }, { x: 91, z: -84.5, w: 5.5, d: 3.2 },
    { x: 44, z: -36.5, w: 4, d: 7.5 }, { x: 58, z: -67.5, w: 4, d: 7.5 },
  ]
  beds.forEach((b) => {
    box(b.w, 0.48, b.d, mats.planter, [{ x: b.x, y: 0.26, z: b.z }])
    collider(b.x, b.z, b.w, b.d, 0.95)
  })
  const shrubItems: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = []
  const flowerItems: typeof shrubItems = []
  beds.forEach((b, i) => {
    const n = b.w > b.d ? 4 : 3
    for (let j = 0; j < n; j++) {
      const x = b.x + (b.w > b.d ? (j - (n - 1) / 2) * 1.55 : ((j % 2) - 0.5) * 1.2)
      const z = b.z + (b.w > b.d ? ((i % 2) ? 0.25 : -0.25) : (j - (n - 1) / 2) * 1.7)
      shrubItems.push({ x, y: 0.77, z, sx: 0.7, sy: 0.52, sz: 0.7 })
      if (j % 2 === 0) flowerItems.push({ x: x + 0.55, y: 1.05, z: z - 0.65, sx: .16, sy: .16, sz: .16 })
    }
  })
  sphere(mats.foliageDark, shrubItems)
  const petals = mergeGeometries(Array.from({ length: 5 }, (_, i) => {
    const angle = i * Math.PI * 2 / 5
    return new THREE.SphereGeometry(1, 5, 3).scale(.36, .14, .70)
      .rotateY(angle).translate(Math.sin(angle) * .53, 0, Math.cos(angle) * .53)
  }), false)!
  for (const [index, color] of ['#e5d7a4', '#9381a5', '#ce9254'].entries()) {
    instanced(petals, new THREE.MeshStandardMaterial({ color, roughness: 1 }), flowerItems.filter((_, i) => i % 3 === index), false)
  }
  sphere(mats.fabricOrange, flowerItems.map(p => ({ ...p, sy: .09, sx: .05, sz: .05 })))

  // Cafe terrace sits outside the entry route. Four small tables, restrained
  // canvas umbrellas and chairs form a usable edge facing back into the square.
  const tableCenters = [{ x: 72.7, z: -34.7 }, { x: 78, z: -34.7 }, { x: 83.2, z: -34.7 }, { x: 75.4, z: -40.1 }]
  cylinder(0.53, 0.53, 0.09, mats.wood, tableCenters.map((p) => ({ x: p.x, y: 0.82, z: p.z })), 12, false)
  cylinder(0.065, 0.08, 0.76, mats.metalDark, tableCenters.map((p) => ({ x: p.x, y: 0.39, z: p.z })), 8, false)
  const canopy = new THREE.ConeGeometry(1.25, 0.42, 12, 1, true)
  const canopyMaterial = mats.fabricOrange.clone()
  canopyMaterial.side = THREE.DoubleSide
  instanced(canopy, canopyMaterial, tableCenters.map((p) => ({ x: p.x, y: 2.32, z: p.z })), false)
  cylinder(0.045, 0.05, 1.72, mats.wood, tableCenters.map((p) => ({ x: p.x, y: 1.67, z: p.z })), 8, false)
  sphere(mats.metalDark, tableCenters.map((p) => ({ x: p.x, y: 2.55, z: p.z, sx: 0.075, sy: 0.1, sz: 0.075 })))
  const chairSeats: { x: number; y: number; z: number; ry: number }[] = []
  for (const p of tableCenters) {
    for (const [dx, dz, ry] of [[-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2]] as const) {
      const x = p.x + dx
      const z = p.z + dz
      chairSeats.push({ x, y: 0.48, z, ry })
    }
  }
  const chairWood = mergeGeometries([
    new THREE.BoxGeometry(0.46, 0.08, 0.46).translate(0, 0.46, 0),
    new THREE.BoxGeometry(0.46, 0.56, 0.075).translate(0, 0.76, -0.19),
    new THREE.BoxGeometry(0.055, 0.08, 0.46).translate(-0.203, 0.44, 0),
    new THREE.BoxGeometry(0.055, 0.08, 0.46).translate(0.203, 0.44, 0),
  ], false)!
  const chairMetal = mergeGeometries([
    ...[-0.18, 0.18].flatMap((x) => [-0.18, 0.18].map((z) => new THREE.BoxGeometry(0.045, 0.43, 0.045).translate(x, 0.225, z))),
  ], false)!
  instanced(chairWood, mats.wood, chairSeats.map((p) => ({ x: p.x, y: 0, z: p.z, ry: p.ry })), false)
  instanced(chairMetal, mats.metalDark, chairSeats.map((p) => ({ x: p.x, y: 0, z: p.z, ry: p.ry })), false)
  tableCenters.forEach((p) => collider(p.x, p.z, 0.5, 0.5, 0.9))

  // Warm low lantern standards frame the plaza edges; light positions are fed
  // into the renderer's pooled night lighting budget.
  const lamps = [{ x: 24, z: -31 }, { x: 40, z: -31 }, { x: 63, z: -31 }, { x: 90, z: -31 }, { x: 24, z: -77 }, { x: 40, z: -77 }, { x: 62, z: -76 }, { x: 92, z: -76 }]
  cylinder(0.065, 0.09, 2.45, mats.poleMetal, lamps.map((p) => ({ x: p.x, y: 1.23, z: p.z })), 8, false)
  sphere(mats.streetlightHead, lamps.map((p) => ({ x: p.x, y: 2.58, z: p.z, sx: 0.22, sy: 0.22, sz: 0.22 })))
  lamps.forEach((p) => streetLights.push(new THREE.Vector3(p.x, 2.65, p.z)))

  return { group, colliders, seats, streetLights, animated: (t: number) => updateJets(t) }
}
