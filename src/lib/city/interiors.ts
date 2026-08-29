import * as THREE from 'three'
import { getStorefrontMaterial } from './materials'
import type { CityMaterials, CityPlan, EnterableSpec } from './types'

/* ============================================================
 * InteriorManager — lazily-built procedural interiors placed far
 * from the city (world offset), teleported into via doors.
 * ============================================================ */

export interface InteriorHandle {
  group: THREE.Group
  spawn: { x: number; z: number; yaw: number }
  exit: { x: number; z: number }
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number }[]
  /** optional in-interaction spots (e.g. the Skylink elevator) — the engine
   *  offers them as prompts while the player is inside */
  interactZones?: { id: string; x: number; z: number; r: number; title: string; action: string }[]
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASE_X = 12000

function wallTexture(tint: string, wainscot: string | null): THREE.MeshStandardMaterial {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.fillStyle = tint
  ctx.fillRect(0, 0, 128, 128)
  const rng = mulberry32(tint.length * 31)
  for (let i = 0; i < 200; i++) {
    ctx.globalAlpha = 0.05
    ctx.fillStyle = rng() < 0.5 ? '#000' : '#fff'
    ctx.fillRect(rng() * 128, rng() * 128, 2, 2)
  }
  ctx.globalAlpha = 1
  if (wainscot) {
    ctx.fillStyle = wainscot
    ctx.fillRect(0, 88, 128, 40)
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 2
    ctx.strokeRect(0, 88, 128, 40)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 })
}

export class InteriorManager {
  current: InteriorHandle | null = null
  private cache = new Map<string, InteriorHandle>()
  private plan: CityPlan
  private mats: CityMaterials

  constructor(plan: CityPlan, mats: CityMaterials) {
    this.plan = plan
    this.mats = mats
  }

  specOf(id: string): EnterableSpec | undefined {
    return this.plan.enterables.find((e) => e.id === id)
  }

  enter(id: string): InteriorHandle | null {
    const spec = this.specOf(id)
    if (!spec) return null
    let h = this.cache.get(id)
    if (!h) {
      h = this.build(spec)
      this.cache.set(id, h)
    }
    this.current = h
    return h
  }

  leave() {
    this.current = null
  }

  /* ============================================================ */

  private build(spec: EnterableSpec): InteriorHandle {
    const idx = this.plan.enterables.findIndex((e) => e.id === spec.id)
    const cx = BASE_X + idx * 400 + spec.w / 2
    const cz = spec.d / 2 // room spans z 0..d, door on south wall (+Z)
    const group = new THREE.Group()
    const colliders: { minX: number; maxX: number; minZ: number; maxZ: number }[] = []
    const rng = mulberry32(1000 + idx * 77)
    const W = spec.w
    const D = spec.d
    const H = spec.h

    // room palette per kind
    let wallTint = '#d8d2c2'
    let wainscot: string | null = null
    let floorMat: THREE.Material = this.mats.wood
    if (spec.interiorKind === 'hub') { wallTint = '#cfd4c8'; floorMat = this.mats.concreteLight }
    if (spec.interiorKind === 'market') { wallTint = '#d9cbb4'; wainscot = '#8a6a48'; floorMat = this.mats.concreteLight }
    if (spec.interiorKind === 'cafe') { wallTint = '#c9b8a0'; wainscot = '#5c4a38' }
    if (spec.interiorKind === 'grocery') { wallTint = '#d4d8d2'; floorMat = getStorefrontMaterial(2) }
    if (spec.interiorKind === 'office') { wallTint = '#c8ccc8'; floorMat = this.mats.metalDark }
    if (spec.interiorKind === 'library') { wallTint = '#d6ccba'; wainscot = '#6a4f38' }
    if (spec.interiorKind === 'clinic') { wallTint = '#dfe6df'; floorMat = this.mats.concreteLight }
    if (spec.interiorKind === 'skylink') { wallTint = '#ccd6d0'; floorMat = this.mats.concreteLight }
    const wallMat = wallTexture(wallTint, wainscot)
    const wallMatRep = wallMat
    wallMatRep.map!.repeat.set(W / 4, 1)

    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, collide = false, shadow = true) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
      m.position.set(x, y, z)
      m.castShadow = shadow
      m.receiveShadow = true
      group.add(m)
      if (collide) colliders.push({ minX: x - w / 2 - 0.1, maxX: x + w / 2 + 0.1, minZ: z - d / 2 - 0.1, maxZ: z + d / 2 + 0.1 })
      return m
    }

    // floor & ceiling
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.2, D), floorMat)
    floor.position.set(cx, -0.1, cz)
    floor.receiveShadow = true
    group.add(floor)
    const ceilMat = new THREE.MeshStandardMaterial({ color: spec.interiorKind === 'cafe' ? '#8a7460' : '#b8b4a8', roughness: 0.95 })
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(W, 0.2, D), ceilMat)
    ceil.position.set(cx, H, cz)
    group.add(ceil)

    // walls (door gap 2.4m centered on south wall)
    const wallT = 0.3
    const gap = 2.6
    // south wall (+Z) two segments
    const segW = (W - gap) / 2
    box(segW, H, wallT, cx - gap / 2 - segW / 2, H / 2, cz + D / 2, wallMat, true)
    box(segW, H, wallT, cx + gap / 2 + segW / 2, H / 2, cz + D / 2, wallMat, true)
    box(0.4, H, wallT, cx - gap / 2 - 0.2, H / 2, cz + D / 2, wallMat, true)
    box(0.4, H, wallT, cx + gap / 2 + 0.2, H / 2, cz + D / 2, wallMat, true)
    box(gap, H - 2.5, wallT, cx, 2.5 + (H - 2.5) / 2, cz + D / 2, wallMat, true)
    // north, west, east
    box(W, H, wallT, cx, H / 2, cz - D / 2, wallMat, true)
    box(wallT, H, D, cx - W / 2, H / 2, cz, wallMat, true)
    box(wallT, H, D, cx + W / 2, H / 2, cz, wallMat, true)

    // vestibule BEHIND the door gap — looking through the doorway now shows
    // a small entry hall with a closed door, never the void/skybox
    const vz = cz + D / 2 // doorway plane
    const vDepth = 2.4
    box(gap + 1.2, 0.2, vDepth, cx, -0.1, vz + vDepth / 2, floorMat) // floor
    box(0.3, H, vDepth, cx - gap / 2 - 0.15, H / 2, vz + vDepth / 2, wallMat, true)
    box(0.3, H, vDepth, cx + gap / 2 + 0.15, H / 2, vz + vDepth / 2, wallMat, true)
    box(gap + 1.2, 0.2, vDepth, cx, H, vz + vDepth / 2, ceilMat) // ceiling
    box(gap + 0.6, H, 0.3, cx, H / 2, vz + vDepth + 0.15, wallMat, true) // end wall
    // the (closed) exit door seen from inside
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(2.1, 2.6, 0.14), new THREE.MeshStandardMaterial({ color: '#4a4038', roughness: 0.75 }))
    doorFrame.position.set(cx, 1.3, vz + vDepth - 0.06)
    group.add(doorFrame)
    const doorLeaf = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.3), new THREE.MeshStandardMaterial({ color: '#5a4634', roughness: 0.8 }))
    doorLeaf.position.set(cx, 1.18, vz + vDepth + 0.02)
    doorLeaf.rotation.y = Math.PI
    group.add(doorLeaf)
    const doorHandle = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), this.mats.metal)
    doorHandle.position.set(cx + 0.6, 1.15, vz + vDepth - 0.14)
    group.add(doorHandle)

    // baseboards
    const baseMat = new THREE.MeshStandardMaterial({ color: '#4a4038', roughness: 0.8 })
    box(W, 0.12, 0.06, cx, 0.06, cz - D / 2 + 0.18, baseMat, false, false)
    box(W, 0.12, 0.06, cx, 0.06, cz + D / 2 - 0.18, baseMat, false, false)
    box(0.06, 0.12, D, cx - W / 2 + 0.18, 0.06, cz, baseMat, false, false)
    box(0.06, 0.12, D, cx + W / 2 - 0.18, 0.06, cz, baseMat, false, false)

    // fake windows on north wall (daylight)
    const winMat = new THREE.MeshStandardMaterial({ color: '#e8e4d4', emissive: '#fff2d8', emissiveIntensity: 0.7, roughness: 0.3 })
    const frameMat = new THREE.MeshStandardMaterial({ color: '#5a5248', roughness: 0.7 })
    const winCount = Math.max(2, Math.floor(W / 10))
    for (let i = 0; i < winCount; i++) {
      const wx = cx - W / 2 + (W / (winCount + 1)) * (i + 1)
      const win = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(6, W / (winCount + 2)), H * 0.45), winMat)
      win.position.set(wx, H * 0.55, cz - D / 2 + 0.2)
      group.add(win)
      const fr = new THREE.Mesh(new THREE.BoxGeometry(Math.min(6, W / (winCount + 2)) + 0.3, H * 0.45 + 0.3, 0.08), frameMat)
      fr.position.set(wx, H * 0.55, cz - D / 2 + 0.16)
      group.add(fr)
    }

    // ceiling light fixtures + point lights
    const lampMat = new THREE.MeshStandardMaterial({ color: '#f0e8d0', emissive: '#ffe8c0', emissiveIntensity: 1.4 })
    const lightCount = Math.max(2, Math.floor(W / 14))
    for (let i = 0; i < lightCount; i++) {
      const lx = cx - W / 2 + (W / (lightCount + 1)) * (i + 1)
      box(2.4, 0.1, 0.5, lx, H - 0.35, cz, lampMat, false, false)
    }
    const pl1 = new THREE.PointLight(0xffe0b0, 30, Math.max(W, D) * 1.3, 1.6)
    pl1.position.set(cx, H - 1.5, cz)
    group.add(pl1)
    if (W > 30) {
      const pl2 = new THREE.PointLight(0xffe0b0, 22, W * 0.9, 1.6)
      pl2.position.set(cx - W / 4, H - 2, cz)
      group.add(pl2)
    }

    // exit sign + door leaf
    const exitMat = this.mats.signMaterial('EXIT', { bg: '#1f4d38', fg: '#eaffea', w: 128, h: 48 })
    const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.36), exitMat)
    exitSign.position.set(cx, 2.75, cz + D / 2 - 0.45)
    group.add(exitSign)
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 0.08), new THREE.MeshStandardMaterial({ color: '#4a4038', roughness: 0.7 }))
    leaf.position.set(cx - 0.65, 1.2, cz + D / 2 - 0.3)
    leaf.rotation.y = -0.7
    group.add(leaf)

    /* ---------------- per-kind contents ---------------- */
    const woodMat = this.mats.wood
    const metalMat = this.mats.metal
    const darkMat = this.mats.metalDark

    if (spec.interiorKind === 'skylink') {
      /* ---- SKYLINK TOWERS LOBBY — double-height civic glass hall ---- */
      // reception desk with the tower logo
      box(6, 1.05, 1.2, cx, 0.52, cz - D / 2 + 5, this.mats.white, true)
      box(6.5, 0.06, 1.3, cx, 1.08, cz - D / 2 + 5, darkMat, false, false)
      const logo = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.7), this.mats.signMaterial('SKYLINK TOWERS', { bg: '#14261e', fg: '#7ee0a8', w: 512, h: 72 }))
      logo.position.set(cx, 2.3, cz - D / 2 + 4.35)
      group.add(logo)
      colliders.push({ minX: cx - 3.2, maxX: cx + 3.2, minZ: cz - D / 2 + 4.3, maxZ: cz - D / 2 + 5.7 })
      // lobby directory
      const dir = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.4), this.mats.signMaterial('PODIUM RETAIL · L2-8 OFFICES · L9-29 SKY OFFICES · 79M SKY DECK', { bg: '#20261e', fg: '#d8e2d0', w: 512, h: 288 }))
      dir.position.set(cx - W / 2 + 0.35, 1.9, cz - 2)
      dir.rotation.y = Math.PI / 2
      group.add(dir)
      // lounge sofas + table (east half)
      box(2.8, 0.5, 1.1, cx + 7, 0.25, cz + 2, this.mats.fabricGreen, true)
      box(2.8, 0.6, 0.25, cx + 7, 0.75, cz + 2.45, this.mats.fabricGreen, false, false)
      colliders.push({ minX: cx + 5.5, maxX: cx + 8.5, minZ: cz + 1.3, maxZ: cz + 2.7 })
      box(1.1, 0.5, 2.8, cx + 4.4, 0.25, cz - 0.6, this.mats.fabricGreen, true)
      box(0.25, 0.6, 2.8, cx + 3.95, 0.75, cz - 0.6, this.mats.fabricGreen, false, false)
      colliders.push({ minX: cx + 3.6, maxX: cx + 5.2, minZ: cz - 2.1, maxZ: cz + 0.9 })
      box(1.4, 0.36, 0.8, cx + 6.2, 0.18, cz - 0.4, woodMat, true)
      // coffee bar (west wall)
      box(3.2, 1.0, 0.8, cx - W / 2 + 2.2, 0.5, cz + D / 2 - 3, woodMat, true)
      box(3.4, 0.06, 0.9, cx - W / 2 + 2.2, 1.03, cz + D / 2 - 3, darkMat, false, false)
      const barSign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), this.mats.signMaterial('CAFÉ', { bg: '#3a3026', fg: '#f0e8d0', w: 256, h: 64 }))
      barSign.position.set(cx - W / 2 + 2.2, 1.6, cz + D / 2 - 2.5)
      group.add(barSign)
      colliders.push({ minX: cx - W / 2 + 0.4, maxX: cx - W / 2 + 4, minZ: cz + D / 2 - 3.6, maxZ: cz + D / 2 - 2.4 })
      /* ---- ELEVATOR BANK (north wall) — the ride to the sky deck ---- */
      for (const ex of [-2.1, 2.1]) {
        const el = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.6, 0.24), metalMat)
        el.position.set(cx + ex, 1.8, cz - D / 2 + 0.42)
        group.add(el)
        // brushed doors with a center seam
        box(0.03, 3.2, 0.06, cx + ex, 1.7, cz - D / 2 + 0.58, darkMat, false, false)
        // floor indicator above each door
        const ind = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.3), new THREE.MeshBasicMaterial({ color: '#7ee0a8', toneMapped: false }))
        ind.position.set(cx + ex, 3.85, cz - D / 2 + 0.58)
        group.add(ind)
      }
      const liftSign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.6), this.mats.signMaterial('SKY DECK ↑ 79 M · PRESS E', { bg: '#14261e', fg: '#7ee0a8', w: 640, h: 96 }))
      liftSign.position.set(cx, 4.6, cz - D / 2 + 0.62)
      group.add(liftSign)
      // call panel on a pillar between the doors
      box(0.5, 3.6, 0.5, cx, 1.8, cz - D / 2 + 2.2, metalMat, true)
      const btn = new THREE.Mesh(new THREE.CircleGeometry(0.09, 10), new THREE.MeshBasicMaterial({ color: '#ffb84a', toneMapped: false }))
      btn.position.set(cx, 1.35, cz - D / 2 + 2.48)
      group.add(btn)
      colliders.push({ minX: cx - 0.35, maxX: cx + 0.35, minZ: cz - D / 2 + 1.85, maxZ: cz - D / 2 + 2.55 })
      colliders.push({ minX: cx - 4.3, maxX: cx - 0.2, minZ: cz - D / 2, maxZ: cz - D / 2 + 0.75 })
      colliders.push({ minX: cx + 0.2, maxX: cx + 4.3, minZ: cz - D / 2, maxZ: cz - D / 2 + 0.75 })
      // turnstile line at the lobby mouth
      for (const tx of [-1.4, 1.4]) {
        box(0.14, 1.0, 0.14, cx + tx, 0.5, cz + 3.4, metalMat, false, false)
        box(0.7, 0.9, 0.08, cx + tx + 0.5, 0.55, cz + 3.4, this.mats.glassDark, false)
      }
      // planters + ring light
      for (const [px2, pz2] of [[cx - W / 2 + 1.6, cz - D / 2 + 1.6], [cx + W / 2 - 1.6, cz - D / 2 + 1.6], [cx - W / 2 + 1.6, cz + D / 2 - 1.6], [cx + W / 2 - 1.6, cz + D / 2 - 1.6]] as const) {
        box(0.6, 0.6, 0.6, px2, 0.3, pz2, this.mats.planter, true)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.6, 7, 5), this.mats.foliage)
        bush.position.set(px2, 1.05, pz2)
        bush.castShadow = true
        group.add(bush)
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.09, 8, 32), new THREE.MeshStandardMaterial({ color: '#f0e8d0', emissive: '#ffe8c0', emissiveIntensity: 1.3 }))
      ring.rotation.x = Math.PI / 2
      ring.position.set(cx, H - 0.7, cz)
      group.add(ring)
    }

    if (spec.interiorKind === 'market') {
      // 2 rows × 4 stalls
      const canopies = [this.mats.fabricRed, this.mats.fabricGreen, this.mats.fabricOrange]
      const labels = ['BAKERY', 'PRODUCE', 'FLOWERS', 'CHEESE', 'COFFEE', 'FISH', 'BUTCHER', 'SWEETS']
      let li = 0
      for (const rowZ of [cz - D / 4, cz + D / 4]) {
        for (let i = 0; i < 4; i++) {
          const sx = cx - W / 2 + 8 + i * ((W - 16) / 3)
          box(3.4, 0.9, 1.2, sx, 0.45, rowZ, woodMat, true)
          // canopy posts + top
          for (const pz of [rowZ - 1.4, rowZ + 1.4]) {
            box(0.08, 2.4, 0.08, sx - 1.6, 1.2, pz, darkMat, false, false)
            box(0.08, 2.4, 0.08, sx + 1.6, 1.2, pz, darkMat, false, false)
          }
          const canopy = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.07, 3.2), canopies[li % 3])
          canopy.rotation.x = -0.1
          canopy.position.set(sx, 2.5, rowZ)
          canopy.castShadow = true
          group.add(canopy)
          // fabric valance on the front edge of the canopy
          const valance = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.3, 0.05), canopies[li % 3])
          valance.position.set(sx, 2.32, rowZ + 1.62)
          group.add(valance)
          const signM = this.mats.signMaterial(labels[li % labels.length], { bg: '#3a3026', fg: '#f0e8d0', w: 256, h: 64 })
          // hanging sign below the canopy — two real faces (0.03 apart),
          // readable from BOTH aisles and no longer coplanar/z-fighting
          const hangSign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), signM)
          hangSign.position.set(sx, 2.05, rowZ - 0.02)
          hangSign.rotation.y = Math.PI
          group.add(hangSign)
          const hangSign2 = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), signM)
          hangSign2.position.set(sx, 2.05, rowZ + 0.02)
          group.add(hangSign2)
          // hanging wires
          box(0.02, 0.45, 0.02, sx - 0.9, 2.28, rowZ, darkMat, false, false)
          box(0.02, 0.45, 0.02, sx + 0.9, 2.28, rowZ, darkMat, false, false)
          // produce crates
          const crateCols = ['#c94f3d', '#e8a03a', '#5b8c4a', '#9a5a8a']
          for (let ccount = 0; ccount < 5; ccount++) {
            box(0.55, 0.35, 0.45, sx - 1.2 + ccount * 0.6, 1.05, rowZ + (rng() - 0.5) * 0.4, new THREE.MeshStandardMaterial({ color: crateCols[(ccount + li) % 4], roughness: 0.8 }), false, false)
          }
          li++
        }
      }
      // string lights
      const bulbGeo = new THREE.SphereGeometry(0.07, 6, 5)
      const bulbs = new THREE.InstancedMesh(bulbGeo, new THREE.MeshBasicMaterial({ color: '#ffd9a0', toneMapped: false }), 40)
      const dm = new THREE.Object3D()
      let bi = 0
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 4; j++) {
          dm.position.set(cx - W / 2 + 5 + i * ((W - 10) / 9), H - 0.8 - Math.sin((j / 3) * Math.PI) * 0.5, cz - D / 2 + 4 + j * ((D - 8) / 3))
          dm.updateMatrix()
          bulbs.setMatrixAt(bi++, dm.matrix)
        }
      }
      bulbs.instanceMatrix.needsUpdate = true
      group.add(bulbs)
      // rug
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(6, D - 12), new THREE.MeshStandardMaterial({ color: '#7a3a3a', roughness: 1 }))
      rug.rotation.x = -Math.PI / 2
      rug.position.set(cx, 0.012, cz)
      group.add(rug)
    }

    if (spec.interiorKind === 'cafe') {
      // counter
      box(W * 0.55, 1.0, 0.7, cx - W / 2 + W * 0.3, 0.5, cz - D / 2 + 2.2, woodMat, true)
      box(W * 0.55, 0.06, 0.8, cx - W / 2 + W * 0.3, 1.03, cz - D / 2 + 2.2, darkMat, false, false)
      // espresso machine + display
      box(0.9, 0.5, 0.6, cx - W / 2 + 2.2, 1.3, cz - D / 2 + 2.2, metalMat, false)
      const display = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 0.55), new THREE.MeshStandardMaterial({ color: '#c8b89a', emissive: '#ffd9a0', emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.3 }))
      display.position.set(cx - W / 2 + 4.4, 1.4, cz - D / 2 + 2.2)
      group.add(display)
      // menu board
      const menu = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.6), new THREE.MeshStandardMaterial({ color: '#26302a', roughness: 0.9 }))
      menu.position.set(cx, 2.6, cz - D / 2 + 0.3)
      group.add(menu)
      const menuText = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), this.mats.signMaterial('MENU · COFFEE · TEA · CAKES', { bg: '#26302a', fg: '#e8dcc0', w: 512, h: 192 }))
      menuText.position.set(cx, 2.6, cz - D / 2 + 0.32)
      menuText.rotation.y = Math.PI
      group.add(menuText)
      // tables + chairs
      for (const [tx, tz] of [[cx - 2.5, cz + 1], [cx + 2, cz + 1.8], [cx + 3.5, cz - 1], [cx - 3.5, cz - 1.5]] as const) {
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 12), woodMat)
        top.position.set(tx, 0.75, tz)
        top.castShadow = true
        group.add(top)
        box(0.08, 0.75, 0.08, tx, 0.37, tz, darkMat, false, false)
        for (let a = 0; a < 2; a++) {
          const ang = a * Math.PI + 0.5
          const chx = tx + Math.cos(ang) * 0.85
          const chz = tz + Math.sin(ang) * 0.85
          box(0.42, 0.08, 0.42, chx, 0.48, chz, woodMat, false, false)
          box(0.42, 0.5, 0.07, chx - Math.cos(ang) * 0.18, 0.75, chz - Math.sin(ang) * 0.18, woodMat, false, false)
          box(0.06, 0.48, 0.06, chx, 0.24, chz, darkMat, false, false)
        }
        colliders.push({ minX: tx - 0.6, maxX: tx + 0.6, minZ: tz - 0.6, maxZ: tz + 0.6 })
      }
      // pendants
      for (const [px, pz] of [[cx - 2.5, cz + 1], [cx + 2, cz + 1.8], [cx - 1, cz - D / 2 + 2.2]] as const) {
        box(0.06, 0.9, 0.06, px, H - 0.5, pz, darkMat, false, false)
        const shade = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.3, 10, 1, true), new THREE.MeshStandardMaterial({ color: '#4a6a52', roughness: 0.6, side: THREE.DoubleSide }))
        shade.position.set(px, H - 0.95, pz)
        group.add(shade)
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 5), new THREE.MeshBasicMaterial({ color: '#ffd9a0', toneMapped: false }))
        bulb.position.set(px, H - 1.05, pz)
        group.add(bulb)
      }
      // plants
      for (const [px, pz] of [[cx + W / 2 - 1.2, cz - D / 2 + 1.2], [cx - W / 2 + 1, cz + D / 2 - 1.6]] as const) {
        box(0.4, 0.45, 0.4, px, 0.22, pz, this.mats.planter, false)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.42, 7, 5), this.mats.foliage)
        bush.position.set(px, 0.85, pz)
        bush.castShadow = true
        group.add(bush)
      }
    }

    if (spec.interiorKind === 'grocery') {
      // 4 shelf aisles — same 2.33 m spacing but shifted north so the ENTRY
      // ZONE (spawn at cz + D/2 − 3.6) stays ~1.7 m clear of the last shelf's
      // collider (the old layout put row 4 exactly under the spawn → stuck)
      const productCols = ['#c94f3d', '#e8a03a', '#5b8c4a', '#d8c890', '#9a5a3a', '#c8c8c8']
      for (let row = 0; row < 4; row++) {
        const rz = cz - D / 2 + 2.2 + row * ((D - 8) / 3)
        // frame
        box(W * 0.62, 0.1, 0.8, cx, 0.05, rz, darkMat, true)
        for (let lv = 1; lv <= 3; lv++) {
          box(W * 0.62, 0.06, 0.8, cx, lv * 0.62, rz, metalMat, false, false)
          // products
          for (let p = 0; p < 14; p++) {
            if (rng() < 0.2) continue
            box(0.5, 0.34, 0.5, cx - W * 0.29 + p * (W * 0.58 / 13), lv * 0.62 + 0.22, rz + (rng() - 0.5) * 0.2, new THREE.MeshStandardMaterial({ color: productCols[Math.floor(rng() * 6)], roughness: 0.75 }), false, false)
          }
        }
        // shelf back
        box(W * 0.62, 2.1, 0.06, cx, 1.05, rz + 0.4, metalMat, false, false)
        colliders.push({ minX: cx - W * 0.31, maxX: cx + W * 0.31, minZ: rz - 0.5, maxZ: rz + 0.5 })
      }
      // fridges along north wall
      for (let i = 0; i < 4; i++) {
        const fx = cx - W / 2 + 4 + i * 4.6
        const fr = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.6, 0.9), new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.4, metalness: 0.2 }))
        fr.position.set(fx, 1.3, cz - D / 2 + 1.0)
        group.add(fr)
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.0), new THREE.MeshStandardMaterial({ color: '#c8ccc8', emissive: '#f0f4e8', emissiveIntensity: 0.5, roughness: 0.15, metalness: 0.3 }))
        glass.position.set(fx, 1.3, cz - D / 2 + 1.5)
        group.add(glass)
        colliders.push({ minX: fx - 2.1, maxX: fx + 2.1, minZ: cz - D / 2, maxZ: cz - D / 2 + 1.6 })
      }
      // checkouts
      for (const cox of [cx - 4, cx + 4]) {
        box(2.6, 0.95, 1.0, cox, 0.47, cz + D / 2 - 2.4, woodMat, true)
        box(0.5, 0.4, 0.5, cox + 0.8, 1.25, cz + D / 2 - 2.4, darkMat, false)
        box(2.4, 0.05, 0.7, cox, 1.0, cz + D / 2 - 2.4, metalMat, false, false)
      }
      // baskets
      for (let i = 0; i < 4; i++) box(0.5, 0.18, 0.36, cx - W / 2 + 1.5, 0.4 + i * 0.14, cz + D / 2 - 1.5, i % 2 ? this.mats.fabricRed : darkMat, false, false)
    }

    if (spec.interiorKind === 'hub') {
      // pillars
      for (const px of [-W / 4, 0, W / 4]) {
        for (const pz of [-D / 4, D / 4]) {
          const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, H, 10), this.mats.concrete)
          pil.position.set(cx + px, H / 2, cz + pz)
          pil.castShadow = true
          group.add(pil)
          colliders.push({ minX: cx + px - 0.55, maxX: cx + px + 0.55, minZ: cz + pz - 0.55, maxZ: cz + pz + 0.55 })
        }
      }
      // ticket counters (west wall)
      for (let i = 0; i < 3; i++) {
        const kz = cz - D / 2 + 6 + i * 6
        box(4.2, 1.1, 1.0, cx - W / 2 + 3.4, 0.55, kz, woodMat, true)
        box(0.7, 0.5, 0.5, cx - W / 2 + 3.4, 1.35, kz, darkMat, false)
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), new THREE.MeshStandardMaterial({ color: '#2a3230', emissive: '#8affb0', emissiveIntensity: 0.6 }))
        screen.position.set(cx - W / 2 + 3.75, 1.4, kz)
        screen.rotation.y = Math.PI / 2
        group.add(screen)
      }
      // departure board
      const board = new THREE.Mesh(new THREE.BoxGeometry(10, 2.6, 0.3), new THREE.MeshStandardMaterial({ color: '#1a201c', roughness: 0.5 }))
      board.position.set(cx, H - 2.6, cz - D / 2 + 0.6)
      group.add(board)
      const boardText = new THREE.Mesh(new THREE.PlaneGeometry(9.4, 2.1), this.mats.signMaterial('T1 GREEN LINE — P1 — ON TIME · T2 SUN LINE — P2 — 2 MIN · B1 INNER — GATE A — ON TIME', { bg: '#10160f', fg: '#ffb84a', w: 1024, h: 224 }))
      boardText.position.set(cx, H - 2.6, cz - D / 2 + 0.78)
      group.add(boardText)
      // big clock
      const clock = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), this.mats.white)
      clock.position.set(cx, H - 1.2, cz)
      group.add(clock)
      const hand1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.04), this.mats.black)
      hand1.position.set(cx, H - 1.0, cz + 0.02)
      group.add(hand1)
      const hand2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.04), this.mats.black)
      hand2.position.set(cx + 0.2, H - 1.3, cz + 0.02)
      hand2.rotation.z = -1.1
      group.add(hand2)
      // benches
      for (const [bx, bz, ry] of [[cx - 6, cz + D / 4, 0], [cx + 6, cz + D / 4, 0], [cx - 6, cz - D / 4, Math.PI], [cx + 6, cz - D / 4, Math.PI]] as const) {
        const bench = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.08, 0.5), woodMat)
        bench.position.set(bx, 0.45, bz)
        bench.rotation.y = ry
        bench.castShadow = true
        group.add(bench)
        for (const lo of [-1.4, 1.4]) {
          box(0.08, 0.45, 0.45, bx + lo, 0.22, bz, darkMat, false, false)
        }
        colliders.push({ minX: bx - 1.6, maxX: bx + 1.6, minZ: bz - 0.3, maxZ: bz + 0.3 })
      }
      // floor guide lines
      for (let i = 0; i < 3; i++) {
        const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.25, D - 6), new THREE.MeshStandardMaterial({ color: '#c9a437', roughness: 0.6 }))
        gl.rotation.x = -Math.PI / 2
        gl.position.set(cx + 8 + i * 2.5, 0.015, cz)
        group.add(gl)
      }
      // center bench islands (back to back pairs)
      for (let i = 0; i < 3; i++) {
        const bx = cx - 10 + i * 10
        const bA = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.09, 0.5), woodMat)
        bA.position.set(bx, 0.46, cz - 0.45)
        bA.castShadow = true
        group.add(bA)
        const bB = bA.clone()
        bB.position.z = cz + 0.45
        group.add(bB)
        box(3.6, 0.5, 0.24, bx, 0.23, cz, darkMat, false, false)
        colliders.push({ minX: bx - 1.8, maxX: bx + 1.8, minZ: cz - 0.8, maxZ: cz + 0.8 })
      }
      // kiosk
      box(2.6, 2.4, 2.2, cx + 14, 1.2, cz, woodMat, true)
      const ksign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), this.mats.signMaterial('KIOSK', { bg: '#8a5a2a', fg: '#ffe8c8', w: 256, h: 56 }))
      ksign.position.set(cx + 14, 2.2, cz + 1.12)
      group.add(ksign)
      // planters by entrance
      for (const px2 of [cx - W / 2 + 6, cx + W / 2 - 6]) {
        box(1.0, 0.7, 1.0, px2, 0.35, cz + D / 2 - 4, this.mats.planter, true)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5), this.mats.foliage)
        bush.position.set(px2, 1.05, cz + D / 2 - 4)
        bush.castShadow = true
        group.add(bush)
      }
      // central floor medallion
      const med = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.9, 24), new THREE.MeshStandardMaterial({ color: '#7a8a6a', roughness: 0.5 }))
      med.rotation.x = -Math.PI / 2
      med.position.set(cx, 0.02, cz - 4)
      group.add(med)
      // vending machines
      for (const vx of [cx + W / 2 - 2.2, cx + W / 2 - 4.6]) {
        const vm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 0.8), new THREE.MeshStandardMaterial({ color: '#5a6a5c', roughness: 0.5, metalness: 0.3 }))
        vm.position.set(vx, 1.1, cz + D / 2 - 1.0)
        group.add(vm)
        const front = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.5), new THREE.MeshStandardMaterial({ color: '#c8ccc8', emissive: '#f0f4e8', emissiveIntensity: 0.55 }))
        front.position.set(vx, 1.3, cz + D / 2 - 1.4)
        front.rotation.y = Math.PI
        group.add(front)
        colliders.push({ minX: vx - 0.8, maxX: vx + 0.8, minZ: cz + D / 2 - 1.5, maxZ: cz + D / 2 - 0.5 })
      }
    }

    if (spec.interiorKind === 'office') {
      // reception desk
      box(5, 1.1, 1.2, cx, 0.55, cz - D / 2 + 4, this.mats.white, true)
      box(5.4, 0.9, 0.15, cx, 2.2, cz - D / 2 + 3.4, woodMat, false)
      const logo = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.6), this.mats.signMaterial('GREENWORKS', { bg: '#14261e', fg: '#7ee0a8', w: 512, h: 72 }))
      logo.position.set(cx, 2.2, cz - D / 2 + 3.55)
      group.add(logo)
      // sofas
      for (const sx of [-4, 4]) {
        box(3.0, 0.5, 1.1, cx + sx, 0.25, cz + D / 4, this.mats.fabricGreen, true)
        box(3.0, 0.6, 0.25, cx + sx, 0.75, cz + D / 4 + 0.45, this.mats.fabricGreen, false)
        colliders.push({ minX: cx + sx - 1.5, maxX: cx + sx + 1.5, minZ: cz + D / 4 - 0.6, maxZ: cz + D / 4 + 0.6 })
      }
      box(1.6, 0.4, 0.8, cx, 0.2, cz + D / 4, woodMat, true)
      // elevators
      for (const ex of [-1.6, 1.6]) {
        const el = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.2, 0.2), metalMat)
        el.position.set(cx + ex + 5, 1.6, cz - D / 2 + 0.4)
        group.add(el)
        const btn = new THREE.Mesh(new THREE.CircleGeometry(0.06, 8), new THREE.MeshBasicMaterial({ color: '#ffb84a', toneMapped: false }))
        btn.position.set(cx + ex + 5 + 1.35, 1.2, cz - D / 2 + 0.52)
        group.add(btn)
      }
      colliders.push({ minX: cx + 2.5, maxX: cx + 9, minZ: cz - D / 2, maxZ: cz - D / 2 + 0.8 })
      // directory board
      const dir = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.9), this.mats.signMaterial('L1 LOBBY · L2-5 STUDIOS · L6-9 OFFICES · R CAFÉ', { bg: '#20261e', fg: '#d8e2d0', w: 512, h: 288 }))
      dir.position.set(cx - W / 2 + 0.4, 1.7, cz)
      dir.rotation.y = Math.PI / 2
      group.add(dir)
      // plants
      for (const [px, pz] of [[cx - W / 2 + 1.6, cz + D / 2 - 1.6], [cx + W / 2 - 1.6, cz + D / 2 - 1.6]] as const) {
        box(0.5, 0.55, 0.5, px, 0.27, pz, this.mats.planter, false)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5), this.mats.foliage)
        bush.position.set(px, 1.0, pz)
        bush.castShadow = true
        group.add(bush)
      }
      // turnstiles
      for (const tx of [-1, 1]) {
        box(0.15, 1.0, 0.15, cx + tx * 2.2 - 0.4, 0.5, cz - D / 2 + 6.4, metalMat, false)
        box(0.6, 0.9, 0.08, cx + tx * 2.2, 0.55, cz - D / 2 + 6.4, this.mats.glassDark, false)
      }
    }

    if (spec.interiorKind === 'apartment') {
      box(2.1, 0.5, 1.7, cx - W / 2 + 2, 0.25, cz - D / 2 + 2, woodMat, true)
      box(2.1, 0.6, 0.2, cx - W / 2 + 2, 0.6, cz - D / 2 + 1.2, this.mats.fabricGreen, false)
      box(3.4, 0.9, 0.6, cx + W / 2 - 2.4, 0.45, cz - D / 2 + 1.2, woodMat, true)
      box(1.4, 0.75, 0.8, cx, 0.37, cz, woodMat, true)
      for (const chx of [cx - 1, cx + 1]) box(0.45, 0.9, 0.45, chx, 0.45, cz, woodMat, true)
      box(1.8, 2.2, 0.6, cx + W / 2 - 1.2, 1.1, cz + D / 2 - 1, woodMat, true)
    }

    if (spec.interiorKind === 'library') {
      /* ---- book stacks: 3 double-sided shelf rows with instanced book spines ---- */
      const shelfWood = woodMat
      const spineCols = ['#8a3030', '#2f5a44', '#3a4a6a', '#9a6a2a', '#6a3a6a', '#4a6a7a', '#a04848', '#3f5a3a', '#7a5a30', '#54426a']
      const bookIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 1, 0.05), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 }), 4600)
      bookIM.castShadow = true
      let bookN = 0
      const bd = new THREE.Object3D()
      const bc = new THREE.Color()
      /** baseY = the surface the book stands on (books sized to fit the 0.55 shelf gap) */
      const addBook = (x: number, baseY: number, z: number, ry: number) => {
        if (bookN >= 4600) return
        const s = 0.4 + rng() * 0.15
        bd.position.set(x, baseY + s / 2, z)
        bd.rotation.set(0, ry, 0)
        bd.scale.set(1, s, 1)
        bd.updateMatrix()
        bookIM.setMatrixAt(bookN, bd.matrix)
        bookIM.setColorAt(bookN, bc.set(spineCols[Math.floor(rng() * spineCols.length)]))
        bookN++
      }
      let rowI = 0
      for (const rz of [cz - D / 2 + 7, cz, cz + D / 2 - 7]) {
        const len = W - 14 - (rowI % 2) * 6
        for (const side of [-1, 1]) {
          // shelf frame (uprights + 4 boards per side)
          const sx0 = cx - len / 2 + (rowI % 2) * 3
          for (let u = 0; u <= 6; u++) box(0.1, 2.3, 0.5, sx0 + (u * len) / 6, 1.15, rz + side * 0.26, shelfWood, u === 0 || u === 6)
          for (let lv = 0; lv < 4; lv++) box(len, 0.07, 0.55, sx0 + len / 2, 0.35 + lv * 0.62, rz + side * 0.26, shelfWood, false, false)
          // books on each level (seated ON the board top)
          for (let lv = 0; lv < 4; lv++) {
            const boardTop = 0.385 + lv * 0.62
            for (let bx = 0.35; bx < len - 0.4; bx += 0.14) {
              if (rng() < 0.22) continue
              addBook(sx0 + bx, boardTop, rz + side * 0.26, Math.PI / 2)
            }
          }
        }
        // center spine panel
        box(len, 2.3, 0.12, cx - len / 2 + len / 2 + (rowI % 2) * 3, 1.15, rz, shelfWood, true)
        rowI++
      }
      if (bookN > 0) {
        bookIM.count = bookN
        bookIM.instanceMatrix.needsUpdate = true
        if (bookIM.instanceColor) bookIM.instanceColor.needsUpdate = true
        group.add(bookIM)
      }
      // rolling ladder against the middle stack
      const ladderX = cx + 4
      for (let r = 0; r < 5; r++) box(0.05, 0.05, 0.9, ladderX - 0.22 + (r % 2) * 0.44, 0.3 + r * 0.45, cz - 0.05, shelfWood, false, false)
      box(0.05, 2.6, 0.05, ladderX - 0.22, 1.3, cz + 0.42, shelfWood, false, false)
      box(0.05, 2.6, 0.05, ladderX + 0.22, 1.3, cz + 0.42, shelfWood, false, false)

      /* ---- reading tables with green banker's lamps ---- */
      const lampShade = new THREE.MeshStandardMaterial({ color: '#2f5a44', emissive: '#ffd9a0', emissiveIntensity: 0.35, roughness: 0.5 })
      for (const [tx, tz, ry] of [[cx - 8, cz + 4.5, 0], [cx + 9, cz + 4.5, 0], [cx - 8, cz - 3.5, 0], [cx + 9, cz - 3.5, 0]] as const) {
        const top = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.08, 1.4), shelfWood)
        top.position.set(tx, 0.76, tz)
        top.castShadow = true
        group.add(top)
        for (const lx of [-1.5, 1.5]) box(0.1, 0.76, 0.1, tx + lx, 0.38, tz, darkMat, false, false)
        colliders.push({ minX: tx - 1.9, maxX: tx + 1.9, minZ: tz - 0.8, maxZ: tz + 0.8 })
        // two banker's lamps
        for (const lx of [-0.8, 0.8]) {
          box(0.06, 0.3, 0.06, tx + lx, 0.95, tz, metalMat, false, false)
          const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.13, 0.12, 8), lampShade)
          shade.position.set(tx + lx, 1.12, tz)
          group.add(shade)
        }
        // chairs
        for (const [chx, chz] of [[tx - 1, tz + 1.15], [tx + 1, tz + 1.15], [tx - 1, tz - 1.15], [tx + 1, tz - 1.15]] as const) {
          box(0.42, 0.07, 0.42, chx, 0.47, chz, shelfWood, false, false)
          box(0.42, 0.5, 0.06, chx, 0.75, chz + (chz > tz ? 0.18 : -0.18), shelfWood, false, false)
          box(0.05, 0.47, 0.05, chx, 0.23, chz, darkMat, false, false)
        }
      }

      /* ---- study carrels along the north wall ---- */
      for (let i = 0; i < 4; i++) {
        const px = cx - 13.5 + i * 9
        box(2.2, 0.08, 1.0, px, 0.74, cz - D / 2 + 1.6, shelfWood, true)
        box(0.06, 1.1, 1.0, px - 1.1, 1.29, cz - D / 2 + 1.6, shelfWood, false, false)
        box(0.06, 1.1, 1.0, px + 1.1, 1.29, cz - D / 2 + 1.6, shelfWood, false, false)
        const cl = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.11, 0.1, 8), lampShade)
        cl.position.set(px, 0.92, cz - D / 2 + 1.6)
        group.add(cl)
        box(0.42, 0.07, 0.42, px, 0.46, cz - D / 2 + 2.7, shelfWood, false, false)
      }

      /* ---- children's corner (southeast): round rug, low shelves, beanbags ---- */
      const rug = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.03, 20), new THREE.MeshStandardMaterial({ color: '#c2763a', roughness: 1 }))
      rug.position.set(cx + W / 2 - 7, 0.015, cz + D / 2 - 6)
      group.add(rug)
      const rugInner = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.035, 20), new THREE.MeshStandardMaterial({ color: '#7a9a6a', roughness: 1 }))
      rugInner.position.set(cx + W / 2 - 7, 0.02, cz + D / 2 - 6)
      group.add(rugInner)
      // low picture-book bins
      for (const bxx of [cx + W / 2 - 11.5, cx + W / 2 - 3]) {
        box(2.6, 0.7, 0.8, bxx, 0.35, cz + D / 2 - 10, shelfWood, true)
        for (let b = 0; b < 6; b++) addBook(bxx - 1 + b * 0.4, 0.71, cz + D / 2 - 10, 0)
      }
      // beanbags
      for (const [bx2, bz2] of [[cx + W / 2 - 5.5, cz + D / 2 - 5], [cx + W / 2 - 8.5, cz + D / 2 - 4.2], [cx + W / 2 - 7, cz + D / 2 - 7.8]] as const) {
        const bag = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), new THREE.MeshStandardMaterial({ color: ['#c94f3d', '#3a6a4e', '#c8a03a'][Math.floor(rng() * 3)], roughness: 1 }))
        bag.scale.set(1, 0.55, 1)
        bag.position.set(bx2, 0.3, bz2)
        bag.castShadow = true
        group.add(bag)
      }
      // low table
      box(1.2, 0.35, 0.8, cx + W / 2 - 7, 0.18, cz + D / 2 - 6.2, shelfWood, true)

      /* ---- librarian desk + return chute by the entrance ---- */
      box(4.2, 1.05, 1.0, cx - 4, 0.52, cz + D / 2 - 3.4, shelfWood, true)
      box(4.4, 0.06, 1.1, cx - 4, 1.07, cz + D / 2 - 3.4, darkMat, false, false)
      box(0.5, 0.35, 0.4, cx - 3.2, 1.28, cz + D / 2 - 3.4, darkMat, false, false)
      colliders.push({ minX: cx - 6.3, maxX: cx - 1.7, minZ: cz + D / 2 - 4, maxZ: cz + D / 2 - 2.8 })
      // return chute (freestanding, west wall)
      box(1.1, 1.1, 0.7, cx - W / 2 + 2, 0.55, cz + D / 2 - 2.4, shelfWood, true)
      box(0.7, 0.09, 0.3, cx - W / 2 + 2, 1.12, cz + D / 2 - 2.4, darkMat, false, false)
      const retSign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.3), this.mats.signMaterial('BOOK RETURN', { bg: '#3a3026', fg: '#f0e8d0', w: 256, h: 80 }))
      retSign.position.set(cx - W / 2 + 2, 1.45, cz + D / 2 - 2.05)
      group.add(retSign)

      /* ---- hanging wayfinding signs + notice board ---- */
      const signDefs: [string, number, number][] = [['FICTION', cx - 9, cz - 7], ['NON-FICTION', cx + 9, cz - 7], ['CHILDREN’S', cx + W / 2 - 7, cz + 2], ['QUIET PLEASE', cx - 12, cz + 8]]
      for (const [txt, sx, sz] of signDefs) {
        const sgn = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.5), this.mats.signMaterial(txt, { bg: '#1f4d38', fg: '#f0e8d0', w: 384, h: 80 }))
        sgn.position.set(sx, 3.3, sz)
        group.add(sgn)
        const sgn2 = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.5), this.mats.signMaterial(txt, { bg: '#1f4d38', fg: '#f0e8d0', w: 384, h: 80 }))
        sgn2.position.set(sx, 3.3, sz)
        sgn2.rotation.y = Math.PI
        group.add(sgn2)
        box(0.02, 0.5, 0.02, sx - 0.9, 3.8, sz, darkMat, false, false)
        box(0.02, 0.5, 0.02, sx + 0.9, 3.8, sz, darkMat, false, false)
      }
      const board = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.8, 0.08), new THREE.MeshStandardMaterial({ color: '#5a4634', roughness: 0.8 }))
      board.position.set(cx + W / 2 - 0.4, 1.8, cz - D / 2 + 6, )
      board.rotation.y = -Math.PI / 2
      group.add(board)
      // notices on the board
      for (let n = 0; n < 6; n++) {
        const note = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.7), new THREE.MeshStandardMaterial({ color: ['#f0e8d0', '#e8d8a0', '#d0e0c8'][n % 3], roughness: 0.9 }))
        note.position.set(cx + W / 2 - 0.47, 2.1 - (n % 3) * 0.62, cz - D / 2 + 5.1 + Math.floor(n / 3) * 1.1)
        note.rotation.y = -Math.PI / 2
        note.rotation.z = (rng() - 0.5) * 0.15
        group.add(note)
      }
      // arched window glow on the east & west walls (tall clerestory feel)
      const archGlow = new THREE.MeshStandardMaterial({ color: '#e8e4d4', emissive: '#fff2d8', emissiveIntensity: 0.7, roughness: 0.3 })
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const wz = cz - 6 + i * 6
          const win = new THREE.Mesh(new THREE.PlaneGeometry(1.8, H * 0.5), archGlow)
          win.position.set(cx + side * (W / 2 - 0.25), H * 0.55, wz)
          win.rotation.y = side * -Math.PI / 2
          group.add(win)
          const arch = new THREE.Mesh(new THREE.CircleGeometry(0.9, 12, 0, Math.PI), archGlow)
          arch.position.set(cx + side * (W / 2 - 0.25), H * 0.8, wz)
          arch.rotation.y = side * -Math.PI / 2
          group.add(arch)
        }
      }
      // corner planters
      for (const [px2, pz2] of [[cx - W / 2 + 1.4, cz - D / 2 + 1.4], [cx + W / 2 - 1.4, cz - D / 2 + 1.4]] as const) {
        box(0.6, 0.6, 0.6, px2, 0.3, pz2, this.mats.planter, true)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5), this.mats.foliage)
        bush.position.set(px2, 1.05, pz2)
        bush.castShadow = true
        group.add(bush)
      }
    }

    if (spec.interiorKind === 'clinic') {
      /* ---- waiting room (west half): chair rows, table, TV, water cooler ---- */
      const chairFrame = new THREE.MeshStandardMaterial({ color: '#4a7a62', roughness: 0.7 })
      for (let row = 0; row < 2; row++) {
        const rz = cz - 1.5 + row * 2.6
        for (let c = 0; c < 4; c++) {
          const chx = cx - W / 2 + 3 + c * 0.95
          box(0.8, 0.09, 0.55, chx, 0.45, rz, chairFrame, false, false)
          box(0.8, 0.55, 0.09, chx, 0.75, rz - 0.24, chairFrame, false, false)
          for (const lx of [-0.32, 0.32]) box(0.06, 0.45, 0.06, chx + lx, 0.22, rz, metalMat, false, false)
        }
        colliders.push({ minX: cx - W / 2 + 2.4, maxX: cx - W / 2 + 6.6, minZ: rz - 0.5, maxZ: rz + 0.5 })
      }
      // coffee table with magazines
      box(1.1, 0.06, 0.6, cx - W / 2 + 4.5, 0.42, cz + 2.6, woodMat, true)
      box(0.9, 0.04, 0.5, cx - W / 2 + 4.5, 0.47, cz + 2.6, this.mats.white, false, false)
      for (const lx of [-0.4, 0.4]) box(0.06, 0.42, 0.06, cx - W / 2 + 4.5 + lx, 0.2, cz + 2.6, metalMat, false, false)
      // wall TV (health info channel)
      const tv = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.0, 0.08), new THREE.MeshStandardMaterial({ color: '#182020', roughness: 0.4 }))
      tv.position.set(cx - W / 2 + 4.5, 2.6, cz - D / 2 + 0.35)
      group.add(tv)
      const tvScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.85), new THREE.MeshStandardMaterial({ color: '#9ac8b8', emissive: '#7ee0a8', emissiveIntensity: 0.55, roughness: 0.3 }))
      tvScreen.position.set(cx - W / 2 + 4.5, 2.6, cz - D / 2 + 0.4)
      group.add(tvScreen)
      // water cooler
      box(0.5, 1.1, 0.5, cx - W / 2 + 1.2, 0.55, cz - D / 2 + 1.2, this.mats.white, true)
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.5, 10), new THREE.MeshStandardMaterial({ color: '#bcd8e0', roughness: 0.2, transparent: true, opacity: 0.75 }))
      bottle.position.set(cx - W / 2 + 1.2, 1.35, cz - D / 2 + 1.2)
      group.add(bottle)
      colliders.push({ minX: cx - W / 2 + 0.9, maxX: cx - W / 2 + 1.5, minZ: cz - D / 2 + 0.9, maxZ: cz - D / 2 + 1.5 })

      /* ---- reception desk + glass screen + kiosk ---- */
      box(4.4, 1.1, 0.8, cx + 1, 0.55, cz - D / 2 + 3.2, woodMat, true)
      box(4.6, 0.06, 0.9, cx + 1, 1.12, cz - D / 2 + 3.2, darkMat, false, false)
      const screen = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.1, 0.06), this.mats.glassDark)
      screen.position.set(cx + 1, 1.75, cz - D / 2 + 3.2)
      group.add(screen)
      const recSign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.45), this.mats.signMaterial('RECEPTION', { bg: '#1f4d38', fg: '#f0e8d0', w: 384, h: 66 }))
      recSign.position.set(cx + 1, 2.5, cz - D / 2 + 3.0)
      group.add(recSign)
      colliders.push({ minX: cx - 1.4, maxX: cx + 3.4, minZ: cz - D / 2 + 2.7, maxZ: cz - D / 2 + 3.7 })
      // check-in kiosk
      box(0.7, 1.5, 0.5, cx - 2.6, 0.75, cz - D / 2 + 2.2, darkMat, true)
      const kScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.4), new THREE.MeshStandardMaterial({ color: '#c8d8cc', emissive: '#8affb0', emissiveIntensity: 0.5 }))
      kScreen.position.set(cx - 2.6, 1.35, cz - D / 2 + 2.46)
      group.add(kScreen)
      colliders.push({ minX: cx - 3.1, maxX: cx - 2.1, minZ: cz - D / 2 + 1.9, maxZ: cz - D / 2 + 2.5 })

      /* ---- exam rooms along the east wall: bed, curtain, stool, lamp ---- */
      for (let r = 0; r < 3; r++) {
        const rz = cz - D / 2 + 3.2 + r * 4.2
        // room divider walls
        box(0.18, H - 0.4, 3.4, cx + W / 2 - 5.4, (H - 0.4) / 2, rz - 2.1 + 0.4, wallMat, true)
        // exam bed
        box(2.0, 0.55, 0.9, cx + W / 2 - 2.6, 0.32, rz, this.mats.white, true)
        box(1.9, 0.1, 0.8, cx + W / 2 - 2.6, 0.65, rz, new THREE.MeshStandardMaterial({ color: '#7aa89a', roughness: 0.85 }), false, false)
        box(0.42, 0.12, 0.55, cx + W / 2 - 3.3, 0.71, rz, this.mats.white, false, false) // pillow
        colliders.push({ minX: cx + W / 2 - 3.7, maxX: cx + W / 2 - 1.5, minZ: rz - 0.55, maxZ: rz + 0.55 })
        // privacy curtain (double-sided, on a rail)
        box(2.4, 0.05, 0.05, cx + W / 2 - 5.2, H - 0.45, rz, metalMat, false, false)
        const curtain = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.9), new THREE.MeshStandardMaterial({ color: '#8fb8a8', roughness: 0.9, side: THREE.DoubleSide }))
        curtain.position.set(cx + W / 2 - 5.2, H - 1.4, rz)
        group.add(curtain)
        // stool + instrument trolley
        box(0.42, 0.06, 0.42, cx + W / 2 - 4.2, 0.55, rz + 1.1, metalMat, false, false)
        box(0.05, 0.55, 0.05, cx + W / 2 - 4.2, 0.27, rz + 1.1, metalMat, false, false)
        box(0.55, 0.75, 0.45, cx + W / 2 - 1.6, 0.42, rz + 1.2, this.mats.white, false, false)
        // room number sign
        const num = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.35), this.mats.signMaterial(`EXAM ${r + 1}`, { bg: '#26302a', fg: '#d8e8d8', w: 160, h: 80 }))
        num.position.set(cx + W / 2 - 5.3, 2.4, rz + 0.8)
        num.rotation.y = -Math.PI / 2
        group.add(num)
      }

      /* ---- pharmacy counter (north-east) ---- */
      box(5.0, 1.05, 0.8, cx + 4.5, 0.52, cz - D / 2 + 1.1, woodMat, true)
      box(5.2, 0.06, 0.9, cx + 4.5, 1.07, cz - D / 2 + 1.1, darkMat, false, false)
      const phSign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.45), this.mats.signMaterial('PHARMACY', { bg: '#1f4d38', fg: '#f0e8d0', w: 320, h: 66 }))
      phSign.position.set(cx + 4.5, 2.0, cz - D / 2 + 1.55)
      group.add(phSign)
      colliders.push({ minX: cx + 1.9, maxX: cx + 7.1, minZ: cz - D / 2 + 0.6, maxZ: cz - D / 2 + 1.6 })
      // medicine shelves behind the counter
      const medCols = ['#e8e8e2', '#c8e0d0', '#e0d8b8', '#d0c0d8']
      for (let lv = 0; lv < 2; lv++) {
        box(5.0, 0.05, 0.4, cx + 4.5, 1.5 + lv * 0.6, cz - D / 2 + 0.45, woodMat, false, false)
        for (let m = 0; m < 9; m++) {
          if (rng() < 0.18) continue
          box(0.32, 0.3, 0.24, cx + 2.3 + m * 0.55, 1.68 + lv * 0.6, cz - D / 2 + 0.45, new THREE.MeshStandardMaterial({ color: medCols[Math.floor(rng() * 4)], roughness: 0.7 }), false, false)
        }
      }

      /* ---- corridor wayfinding (hanging, both faces) ---- */
      for (const [txt, sx] of [['WAITING', cx - W / 2 + 4], ['EXAM ROOMS →', cx + 1]] as const) {
        const sg = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.42), this.mats.signMaterial(txt, { bg: '#1f4d38', fg: '#f0e8d0', w: 384, h: 72 }))
        sg.position.set(sx, H - 0.9, cz + 2)
        group.add(sg)
        const sg2 = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.42), this.mats.signMaterial(txt, { bg: '#1f4d38', fg: '#f0e8d0', w: 384, h: 72 }))
        sg2.position.set(sx, H - 0.9, cz + 2)
        sg2.rotation.y = Math.PI
        group.add(sg2)
        box(0.02, 0.45, 0.02, sx - 0.8, H - 0.55, cz + 2, darkMat, false, false)
        box(0.02, 0.45, 0.02, sx + 0.8, H - 0.55, cz + 2, darkMat, false, false)
      }
      // sanitizer stands + plants
      for (const [px2, pz2] of [[cx - W / 2 + 1.2, cz + D / 2 - 1.4], [cx + 1.2, cz + D / 2 - 1.4]] as const) {
        box(0.08, 1.0, 0.08, px2, 0.5, pz2, metalMat, false, false)
        box(0.28, 0.35, 0.2, px2, 1.15, pz2, this.mats.white, false, false)
      }
      for (const [px2, pz2] of [[cx - W / 2 + 1.2, cz - 3.4], [cx + W / 2 - 1.2, cz + 4]] as const) {
        box(0.5, 0.5, 0.5, px2, 0.25, pz2, this.mats.planter, true)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.5, 7, 5), this.mats.foliage)
        bush.position.set(px2, 0.9, pz2)
        bush.castShadow = true
        group.add(bush)
      }
    }

    // spawn just inside the doorway; if ANY collider covers the spawn
    // (per-kind furniture layouts vary), nudge it out along −Z (into the
    // room) then in a small ring until the spot is clear. Prevents the
    // classic "spawn wedged inside a shelf/counter" softlock.
    let sx = cx
    let sz = cz + D / 2 - 3.6
    const hits = (x: number, z: number, r: number) =>
      colliders.some((c) => x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r)
    if (hits(sx, sz, 0.45)) {
      let done = false
      for (let zoff = 0.4; zoff <= 6 && !done; zoff += 0.4) {
        for (const [dx, dz] of [[0, -zoff], [0, zoff], [-zoff, 0], [zoff, 0]] as const) {
          if (!hits(cx + dx, sz + dz, 0.45)) {
            sx = cx + dx
            sz = sz + dz
            done = true
            break
          }
        }
      }
    }
    const spawn = { x: sx, z: sz, yaw: 0 }
    const exit = { x: cx, z: cz + D / 2 - 0.6 }
    // the Skylink lobby exposes its elevator bank as an interaction spot —
    // the engine turns this into a "Ride to Sky Deck" prompt + teleport
    const interactZones =
      spec.interiorKind === 'skylink'
        ? [{ id: 'skydeck-up', x: cx, z: cz - D / 2 + 3.1, r: 3.4, title: 'Panoramic Elevator', action: 'Ride to Sky Deck' }]
        : undefined

    return { group, spawn, exit, colliders, interactZones }
  }
}
