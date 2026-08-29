import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getStorefrontMaterial, tintGeo } from './materials'
import type { AABB, BuildingSpec, CityMaterials, CityPlan, EnterableSpec } from './types'

/* ============================================================
 * Procedural buildings — merged walls per facade variant,
 * roofs, parapets, instanced rooftops & balconies, special
 * buildings, storefronts, signs, doors.
 * ============================================================ */

export interface BuildingsResult {
  group: THREE.Group
  colliders: AABB[]
  doorMarkers: { id: string; x: number; z: number }[]
}

/* Sky Deck registry — filled by buildSpecial() when the twinTowers special
 * builds its cantilevered observation platform. The engine reads this to
 * teleport the player up/down (the deck is at REAL city height, so the view
 * is the actual skyline, not a faked room). */
export interface SkyDeckInfo {
  center: { x: number; z: number }
  floorY: number
  half: number
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number }[]
  arrive: { x: number; z: number; yaw: number }
  liftZone: { x: number; z: number; r: number }
}
export let skyDeck: SkyDeckInfo | null = null

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** plane facing +Z, uv scaled for repeats, transformed by matrix */
function wall(w: number, h: number, uvX: number, uvY: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h)
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * uvX, uv.getY(i) * uvY)
  }
  return g
}

const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
function place(geo: THREE.BufferGeometry, rotY: number, x: number, y: number, z: number): THREE.BufferGeometry {
  _r.makeRotationY(rotY)
  _m.makeTranslation(x, y, z)
  _m.multiply(_r)
  geo.applyMatrix4(_m)
  return geo
}

export function createBuildings(plan: CityPlan, mats: CityMaterials): BuildingsResult {
  const group = new THREE.Group()
  const extraColliders: AABB[] = []
  const rng = mulberry32(777)

  // ---- collect wall geometries per material bucket ----
  const buckets = new Map<string, THREE.BufferGeometry[]>()
  const bucketMats = new Map<string, THREE.Material>()
  const push = (key: string, mat: THREE.Material, geo: THREE.BufferGeometry) => {
    if (!buckets.has(key)) {
      buckets.set(key, [])
      bucketMats.set(key, mat)
    }
    buckets.get(key)!.push(geo)
  }

  const roofGeos: THREE.BufferGeometry[] = []
  const parapetGeos: THREE.BufferGeometry[] = []
  const storefrontGeos = new Map<number, THREE.BufferGeometry[]>()

  interface RoofDetail {
    x: number
    z: number
    w: number
    d: number
    h: number
    rot: number
    b: BuildingSpec
  }
  const acUnits: RoofDetail[] = []
  const waterTowers: RoofDetail[] = []
  const solarPanels: RoofDetail[] = []
  const balconySlabs: { x: number; y: number; z: number; rot: number; sz?: number }[] = []
  const balconyRails: { x: number; y: number; z: number; rot: number }[] = []
  const containers: { x: number; z: number; rot: number; c: number }[] = []
  const bulkheads: RoofDetail[] = []
  const antennas: RoofDetail[] = []
  const chimneyItems: { x: number; y: number; z: number; rot: number }[] = []
  const UPY = new THREE.Vector3(0, 1, 0)

  const glassBucket = 'glass'
  bucketMats.set(glassBucket, mats.glassTower)
  // structural glass mullions — one merged always-lit steel bucket citywide
  const mullionMat = new THREE.MeshBasicMaterial({ color: '#6f7873' })

  for (const b of plan.buildings) {
    const rot = (b.rotation * Math.PI) / 180
    const isGlass = b.kind === 'office' && b.floors >= 14
    const fm = mats.facades[b.facadeVariant % mats.facades.length]
    const variant = b.facadeVariant % mats.facades.length
    // per-building weathered tint — every building gets its own subtle tone
    // even when it shares a facade texture family with its neighbours
    const tintL = 0.9 + rng() * 0.16
    const tintW = (rng() - 0.5) * 0.06
    const tint = new THREE.Color(tintL + tintW, tintL, tintL - tintW)
    let pentH = 0
    let pitched = false

    // ---- walls ----
    const addWalls = (w: number, d: number, h: number, mat: THREE.Material, key: string, y0 = 0) => {
      const uvX = Math.max(1, Math.round(w / 3.3))
      const uvD = Math.max(1, Math.round(d / 3.3))
      const uvY = Math.max(1, Math.round(h / 3.05))
      const parts: [number, number, number, number, number][] = [
        // rotY, cx, cz, wallLen (x-extent), uv rep for that wall
        [0, 0, d / 2, w, uvX],
        [Math.PI, 0, -d / 2, w, uvX],
        [-Math.PI / 2, -w / 2, 0, d, uvD],
        [Math.PI / 2, w / 2, 0, d, uvD],
      ]
      for (const [ry, lx, lz, len, uv] of parts) {
        const g = wall(len, h, uv, uvY)
        place(g, ry, 0, 0, 0)
        tintGeo(g, tint)
        // local → building rotation → world
        const r2 = new THREE.Matrix4().makeRotationY(rot)
        const t2 = new THREE.Matrix4().makeTranslation(b.x, y0 + h / 2, b.z)
        const m2 = t2.multiply(r2)
        const off = new THREE.Matrix4().makeTranslation(lx, 0, lz)
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m2, off))
        push(key, mat, g)
      }
    }

    // storefront band condition (needed early: the plinth skips wrapped bases)
    const wantsStorefront = (fm.storefront || b.kind === 'mixed' || b.kind === 'retail') && b.kind !== 'industrial' && b.kind !== 'utility' && b.kind !== 'depot' && b.kind !== 'transit-hub' && b.kind !== 'market' && b.kind !== 'hospital' && b.kind !== 'twinTowers' && b.floors <= 12 && (!b.label || b.kind === 'retail')

    // Special buildings build their OWN shell inside buildSpecial().
    // The generic walls/roof/parapet below used to be generated for them as
    // well — TWO exactly-coplanar shells (plus the special box used default
    // BoxGeometry UVs, so a second stretched-texen face flickered against
    // the properly-tiled generic one → the "z-layers on buildings" bug).
    // Unlabeled hospital towers (the helipad tower) are specials too.
    const specialShell = !!b.label || b.kind === 'hospital'

    if (!specialShell) {
      if (isGlass) {
        // STEPPED SILHOUETTE: tall glass towers (≥ 20 floors) get a setback
        // tier 40% of the time — three identical pale slabs on every block
        // read as clone boxes; a shoulder + inset crown varies the skyline
        const setBack = b.floors >= 20 && rng() < 0.4
        const sbY = setBack ? Math.round(b.height * 0.62) : b.height
        const iw = Math.max(10, b.w * 0.76)
        const idp = Math.max(10, b.d * 0.76)
        addWalls(b.w, b.d, sbY, mats.glassTower, glassBucket)
        if (setBack) {
          // shoulder roof at the setback line
          const shoulder = new THREE.PlaneGeometry(b.w, b.d)
          shoulder.rotateX(-Math.PI / 2)
          tintGeo(shoulder, tint)
          place(shoulder, rot, b.x, sbY, b.z)
          roofGeos.push(shoulder)
          // parapet rim around the shoulder
          const rim = new THREE.BoxGeometry(b.w + 0.14, 0.4, b.d + 0.14)
          place(rim, rot, b.x, sbY - 0.3, b.z)
          push('trimDark', new THREE.MeshBasicMaterial({ color: '#79827f' }), rim)
          addWalls(iw, idp, b.height - sbY, mats.glassTower, glassBucket, sbY)
        }
        // roof edge trim — always 6 cm BELOW the roof plane (coplanar = flicker).
        // Always-lit steel tone: a lit-only material rendered far trims as
        // detached BLACK SLABS once the pale tower body faded into haze.
        const trim = new THREE.BoxGeometry((setBack ? iw : b.w) + 0.14, 0.5, (setBack ? idp : b.d) + 0.14)
        place(trim, rot, b.x, b.height - 0.3, b.z)
        push('trimDark', new THREE.MeshBasicMaterial({ color: '#79827f' }), trim)

        // REAL WINDOW SUPPORTS: structural mullions — vertical fins every
        // ~1.65 m (matching the baked curtain-wall pane grid) + horizontal
        // spandrel bands at every floor line, proud of the glass. This is
        // what was missing: the towers read as unsupported glass stickers.
        const mullify = (mw: number, md: number, y0: number, y1: number) => {
          const hgt = y1 - y0
          const midY = y0 + hgt / 2
          const apply = (g: THREE.BufferGeometry, lx: number, ly: number, lz: number) => {
            const r2 = new THREE.Matrix4().makeRotationY(rot)
            const t2 = new THREE.Matrix4().makeTranslation(b.x, ly, b.z)
            g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(t2.multiply(r2), new THREE.Matrix4().makeTranslation(lx, 0, lz)))
            push('mullion', mullionMat, g)
          }
          // vertical fins on all 4 faces (pane module 3.3 m tile / 2 panes)
          const finNX = Math.max(2, Math.round(mw / 1.65))
          const finNZ = Math.max(2, Math.round(md / 1.65))
          for (let i = 0; i <= finNX; i++) {
            const lx = -mw / 2 + (mw / finNX) * i
            for (const sz of [-1, 1]) {
              const fin = new THREE.BoxGeometry(0.1, hgt, 0.16)
              apply(fin, lx, midY, (sz * md) / 2 + 0.08)
            }
          }
          for (let i = 0; i <= finNZ; i++) {
            const lz = -md / 2 + (md / finNZ) * i
            for (const sx of [-1, 1]) {
              const fin = new THREE.BoxGeometry(0.16, hgt, 0.1)
              apply(fin, (sx * mw) / 2 + 0.08, midY, lz)
            }
          }
          // horizontal spandrel bands at every floor line (ground floor 4 m,
          // then 3.1 m — mirrors height = floors*3.1 + 4)
          const bandY: number[] = []
          if (y0 === 0) bandY.push(4)
          for (let y = (y0 === 0 ? 4 : y0) + 3.1; y < y1 - 0.8; y += 3.1) bandY.push(y)
          for (const y of bandY) {
            for (const sz of [-1, 1]) {
              const band = new THREE.BoxGeometry(mw + 0.18, 0.15, 0.18)
              apply(band, 0, y, (sz * md) / 2 + 0.09)
            }
            for (const sx of [-1, 1]) {
              const band = new THREE.BoxGeometry(0.18, 0.15, md + 0.18)
              apply(band, (sx * mw) / 2 + 0.09, y, 0)
            }
          }
        }
        mullify(b.w, b.d, 0, sbY)
        if (setBack) mullify(iw, idp, sbY, b.height)
      } else {
        addWalls(b.w, b.d, b.height, fm.material, `f${variant}`)

        // ---- roof shape: low homes get pitched roofs, everything else flat ----
        const lowRise = b.floors <= 3 && (b.kind === 'apartment' || b.kind === 'residential')
        pitched = lowRise && rng() < 0.85
        const hipStyle = pitched && rng() < 0.32
        const classic = variant !== 5 && variant !== 6 && variant !== 8 && variant !== 16

        // chimney helper (local building coords → world)
        const chimneyAt = (lx: number, lz: number, y: number) => {
          const wp = new THREE.Vector3(lx, 0, lz).applyAxisAngle(UPY, rot).add(new THREE.Vector3(b.x, 0, b.z))
          chimneyItems.push({ x: wp.x, y, z: wp.z, rot })
        }

        if (!pitched) {
          const roof = new THREE.PlaneGeometry(b.w, b.d)
          roof.rotateX(-Math.PI / 2)
          tintGeo(roof, tint)
          place(roof, rot, b.x, b.height, b.z)
          roofGeos.push(roof)

          // parapet: 4 thin boxes around roof edge
          const pw = b.w + 0.3
          const pd = b.d + 0.3
          const edge = (ew: number, ed: number, ox: number, oz: number) => {
            const g = new THREE.BoxGeometry(ew, 0.45, ed)
            place(g, rot, b.x + ox * Math.cos(rot) + oz * Math.sin(rot), b.height + 0.2, b.z - ox * Math.sin(rot) + oz * Math.cos(rot))
            parapetGeos.push(g)
          }
          edge(pw, 0.28, 0, -pd / 2)
          edge(pw, 0.28, 0, pd / 2)
          edge(0.28, pd, -pw / 2, 0)
          edge(0.28, pd, pw / 2, 0)
        } else if (hipStyle) {
          // hip roof — 4-sided pyramid scaled onto the footprint
          const riseH = Math.min(2.6, Math.max(1.0, Math.min(b.w, b.d) * 0.33))
          const cone = new THREE.ConeGeometry(0.5, riseH, 4)
          cone.rotateY(Math.PI / 4)
          cone.scale((b.w + 0.9) * Math.SQRT2, 1, (b.d + 0.9) * Math.SQRT2)
          const cuv = cone.attributes.uv as THREE.BufferAttribute
          for (let i = 0; i < cuv.count; i++) cuv.setXY(i, cuv.getX(i) * Math.max(1, b.w / 3), cuv.getY(i))
          cone.translate(0, riseH / 2, 0)
          // non-indexed so prism (ExtrudeGeometry) + cone buckets merge —
          // mergeGeometries returns null on mixed indexed/non-indexed input
          const coneNI = cone.index ? cone.toNonIndexed() : cone
          place(coneNI, rot, b.x, b.height, b.z)
          push(`r${variant}`, fm.roof, coneNI)
          if (rng() < 0.5) chimneyAt(b.w * 0.3, b.d * 0.26, b.height + riseH * 0.45)
        } else {
          // gable roof — triangular prism, ridge along the longer axis
          const alongW = b.w >= b.d
          const span = (alongW ? b.d : b.w) + 0.9
          const run = (alongW ? b.w : b.d) + 0.9
          const rise = Math.min(3.1, Math.max(1.3, (alongW ? b.d : b.w) * 0.3))
          const tri = new THREE.Shape()
          tri.moveTo(-span / 2, 0)
          tri.lineTo(span / 2, 0)
          tri.lineTo(0, rise)
          tri.closePath()
          const prism = new THREE.ExtrudeGeometry(tri, { depth: run, bevelEnabled: false })
          prism.translate(0, 0, -run / 2)
          if (alongW) prism.rotateY(Math.PI / 2)
          const puv = prism.attributes.uv as THREE.BufferAttribute
          for (let i = 0; i < puv.count; i++) puv.setXY(i, puv.getX(i) / 3, puv.getY(i) / 3)
          const prismNI = prism.index ? prism.toNonIndexed() : prism
          place(prismNI, rot, b.x, b.height, b.z)
          push(`r${variant}`, fm.roof, prismNI)
          // ridge cap
          const cap = alongW ? new THREE.BoxGeometry(run + 0.2, 0.14, 0.36) : new THREE.BoxGeometry(0.36, 0.14, run + 0.2)
          place(cap, rot, b.x, b.height + rise + 0.03, b.z)
          push('ridgeCap', mats.metalDark, cap)
          if (rng() < 0.55) {
            const cx2 = alongW ? (rng() < 0.5 ? -1 : 1) * b.w * 0.28 : (rng() - 0.5) * b.d * 0.4
            const cz2 = alongW ? (rng() - 0.5) * b.w * 0.4 : (rng() < 0.5 ? -1 : 1) * b.d * 0.28
            chimneyAt(cx2, cz2, b.height + rise + 0.1)
          }
        }

        // cornice under the roofline (classic families only)
        if (classic && !pitched) {
          const cor = new THREE.BoxGeometry(b.w + 0.55, 0.42, b.d + 0.55)
          place(cor, rot, b.x, b.height - 0.43, b.z)
          push(`t${variant}`, fm.trim, cor)
        }
        // stone plinth at the base (skip where a storefront band wraps the base)
        if (classic && b.floors >= 3 && !wantsStorefront) {
          const pl = new THREE.BoxGeometry(b.w + 0.26, 1.1, b.d + 0.26)
          place(pl, rot, b.x, 0.55, b.z)
          push(`t${variant}`, fm.trim, pl)
        }

        // setback penthouse on mid-rise offices (10-13 floors, non-glass)
        if (!pitched && b.kind === 'office' && b.floors >= 10 && b.floors < 16) {
          const iw = Math.max(8, b.w * 0.74)
          const idp = Math.max(8, b.d * 0.74)
          pentH = Math.max(3, b.height * 0.14)
          addWalls(iw, idp, pentH, fm.material, `f${variant}`, b.height)
          const proof = new THREE.PlaneGeometry(iw, idp)
          proof.rotateX(-Math.PI / 2)
          tintGeo(proof, tint)
          place(proof, rot, b.x, b.height + pentH, b.z)
          roofGeos.push(proof)
          const pcor = new THREE.BoxGeometry(iw + 0.34, 0.3, idp + 0.34)
          place(pcor, rot, b.x, b.height + pentH - 0.17, b.z)
          push(`t${variant}`, fm.trim, pcor)
        }
      }
    }

    // ---- podium for very tall towers (NOT for specials — they build their own) ----
    if (b.floors >= 16 && !specialShell) {
      const podW = b.w + 6
      const podD = b.d + 6
      const parts: [number, number, number, number][] = [
        [0, 0, podD / 2, podW],
        [Math.PI, 0, -podD / 2, podW],
        [-Math.PI / 2, -podW / 2, 0, podD],
        [Math.PI / 2, podW / 2, 0, podD],
      ]
      for (const [ry, lx, lz, len] of parts) {
        const g = wall(len, 5.5, Math.max(1, Math.round(len / 4)), 1)
        place(g, ry, 0, 0, 0)
        const r2 = new THREE.Matrix4().makeRotationY(rot)
        const t2 = new THREE.Matrix4().makeTranslation(b.x, 2.75, b.z)
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(t2.multiply(r2), new THREE.Matrix4().makeTranslation(lx, 0, lz)))
        if (!storefrontGeos.has(-1)) storefrontGeos.set(-1, [])
        storefrontGeos.get(-1)!.push(g)
      }
      // podium collider (AABB since rotation only changes footprint swap)
      const swap = b.rotation === 90 || b.rotation === 270
      const ew = swap ? podD : podW
      const ed = swap ? podW : podD
      extraColliders.push({ minX: b.x - ew / 2, maxX: b.x + ew / 2, minZ: b.z - ed / 2, maxZ: b.z + ed / 2, h: 6 })
    }

    // ---- storefront band ----
    if (wantsStorefront) {
      const sw = b.w + 0.3
      const sd = b.d + 0.3
      const sv = (b.id.length + b.w) % 4
      const key2 = sv
      const parts: [number, number, number, number][] = [
        [0, 0, sd / 2, sw],
        [Math.PI, 0, -sd / 2, sw],
        [-Math.PI / 2, -sw / 2, 0, sd],
        [Math.PI / 2, sw / 2, 0, sd],
      ]
      for (const [ry, lx, lz, len] of parts) {
        const g = wall(len, 4.2, Math.max(1, Math.round(len / 5)), 1)
        place(g, ry, 0, 0, 0)
        const r2 = new THREE.Matrix4().makeRotationY(rot)
        const t2 = new THREE.Matrix4().makeTranslation(b.x, 2.1, b.z)
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(t2.multiply(r2), new THREE.Matrix4().makeTranslation(lx, 0, lz)))
        if (!storefrontGeos.has(key2)) storefrontGeos.set(key2, [])
        storefrontGeos.get(key2)!.push(g)
      }
    }

    // ---- rooftop details ----
    const detail: RoofDetail = { x: b.x, z: b.z, w: b.w, d: b.d, h: b.height + pentH, rot, b }
    if (b.floors >= 8 && !specialShell && pentH === 0) {
      const n = 1 + Math.floor(rng() * 3)
      for (let i = 0; i < n; i++) acUnits.push(detail)
    }
    // stair bulkheads on flat mid-rise roofs
    if (!specialShell && !pitched && b.floors >= 4 && rng() < 0.62) {
      bulkheads.push(detail)
    }
    // antenna masts on taller blocks
    if (!specialShell && !pitched && b.floors >= 11 && rng() < 0.55) {
      antennas.push(detail)
    }
    if (b.units > 0 && b.floors >= 4 && b.floors <= 9 && rng() < 0.35) {
      waterTowers.push(detail)
    }
    // rooftop solar only on LOW buildings (≤ 6 floors): on towers the panels
    // hang against bare sky from street level and read as floating black
    // blocks no matter how they're toned
    if (b.units > 0 && b.floors >= 4 && b.floors <= 6 && rng() < 0.3) {
      const rows = 1 + Math.floor(rng() * 2)
      for (let i = 0; i < rows * 3; i++) solarPanels.push(detail)
    }

    // ---- balconies on brick/painted residential (wider variety of facades) ----
    if ((b.kind === 'apartment' || b.kind === 'residential' || b.kind === 'mixed') && (b.facadeVariant <= 4 || b.facadeVariant === 12 || b.facadeVariant === 13) && b.floors >= 3) {
      const perFloor = Math.max(2, Math.min(4, Math.floor(b.w / 7)))
      for (let f = 1; f < b.floors; f++) {
        for (let i = 0; i < perFloor; i++) {
          if (rng() < 0.25) continue
          // front facade local coords: facing +Z local → rotate by b.rotation
          const lx = -b.w / 2 + (b.w / perFloor) * (i + 0.5)
          const lz = b.d / 2 + 0.55
          const deep = rng() < 0.3
          const local = new THREE.Vector3(lx, f * 2.9 + 0.1, lz)
          const wp = local.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).add(new THREE.Vector3(b.x, 0, b.z))
          balconySlabs.push({ x: wp.x, y: wp.y, z: wp.z, rot, sz: deep ? 1.3 : 1 })
          balconyRails.push({ x: wp.x, y: wp.y + 0.5, z: wp.z, rot })
        }
      }
    }

    // ---- awnings over storefront fronts (mixed/retail) ----
    if (wantsStorefront && !specialShell && (b.kind === 'mixed' || b.kind === 'retail') && b.floors <= 6) {
      const nA = Math.max(2, Math.min(5, Math.round(b.w / 6)))
      const ai = Math.floor(rng() * 3)
      const fab = [mats.fabricRed, mats.fabricGreen, mats.fabricOrange][ai]
      for (let i = 0; i < nA; i++) {
        const g = new THREE.BoxGeometry(2.5, 0.08, 1.5)
        g.rotateX(0.34)
        const lx = -b.w / 2 + (b.w / nA) * (i + 0.5)
        const wp = new THREE.Vector3(lx, 0, b.d / 2 + 0.55).applyAxisAngle(UPY, rot).add(new THREE.Vector3(b.x, 0, b.z))
        place(g, rot, wp.x, 3.5, wp.z)
        push(`awn${ai}`, fab, g)
      }
    }

    // ---- industrial containers ----
    if (b.kind === 'industrial' && !b.label) {
      const n = 1 + Math.floor(rng() * 3)
      for (let i = 0; i < n; i++) {
        containers.push({
          x: b.x + (rng() - 0.5) * (b.w + 10),
          z: b.z + b.d / 2 + 4 + rng() * 4,
          rot: rng() < 0.8 ? 0 : Math.PI / 2,
          c: Math.floor(rng() * 3),
        })
      }
    }
  }

  // ---- merge wall buckets ----
  for (const [key, geos] of buckets) {
    if (geos.length === 0) continue
    const merged = mergeGeometries(geos, false)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, bucketMats.get(key)!)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    geos.forEach((g) => g.dispose())
  }

  // roofs merged
  if (roofGeos.length) {
    const merged = mergeGeometries(roofGeos, false)
    if (merged) {
      const mesh = new THREE.Mesh(merged, mats.roofCommon)
      mesh.receiveShadow = true
      mesh.castShadow = true
      group.add(mesh)
    }
  }
  // parapets merged
  if (parapetGeos.length) {
    const merged = mergeGeometries(parapetGeos, false)
    if (merged) {
      const mesh = new THREE.Mesh(merged, mats.concrete)
      mesh.castShadow = true
      group.add(mesh)
    }
  }
  // storefronts merged per texture variant
  for (const [variant, geos] of storefrontGeos) {
    const merged = mergeGeometries(geos, false)
    if (!merged) continue
    const mat = variant === -1 ? getStorefrontMaterial(0) : getStorefrontMaterial(variant)
    const mesh = new THREE.Mesh(merged, mat)
    mesh.castShadow = true
    group.add(mesh)
  }

  // ---- instanced rooftop details ----
  const dummy = new THREE.Object3D()
  const addInstanced = (geo: THREE.BufferGeometry, mat: THREE.Material, items: { x: number; y: number; z: number; rot?: number; sy?: number; sz?: number }[], shadow = true) => {
    if (items.length === 0) return
    const im = new THREE.InstancedMesh(geo, mat, items.length)
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y, it.z)
      dummy.rotation.set(0, it.rot ?? 0, 0)
      if (it.sy || it.sz) dummy.scale.set(1, it.sy ?? 1, it.sz ?? 1)
      else dummy.scale.setScalar(1)
      dummy.updateMatrix()
      im.setMatrixAt(i, dummy.matrix)
    })
    im.castShadow = shadow
    im.receiveShadow = true
    group.add(im)
  }

  // AC units
  if (acUnits.length) {
    const items = acUnits.map((a, i) => {
      const rngA = mulberry32(9000 + i)
      const lx = (rngA() - 0.5) * (a.w - 4)
      const lz = (rngA() - 0.5) * (a.d - 4)
      const wp = new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), a.rot).add(new THREE.Vector3(a.x, a.h + 0.6, a.z))
      return { x: wp.x, y: wp.y, z: wp.z, rot: a.rot + rngA() * 0.2 }
    })
    addInstanced(new THREE.BoxGeometry(1.6, 1.0, 1.2), new THREE.MeshBasicMaterial({ color: '#8d9497' }), items)
  }
  // water towers
  if (waterTowers.length) {
    const tankGeo = mergeGeometries([
      new THREE.CylinderGeometry(1.5, 1.6, 2.4, 10).translate(0, 1.9, 0),
      new THREE.ConeGeometry(1.65, 0.9, 10).translate(0, 3.55, 0),
      new THREE.CylinderGeometry(0.12, 0.12, 1.4, 6).translate(0.8, 0.7, 0.8),
      new THREE.CylinderGeometry(0.12, 0.12, 1.4, 6).translate(-0.8, 0.7, -0.8),
      new THREE.CylinderGeometry(0.12, 0.12, 1.4, 6).translate(-0.8, 0.7, 0.8),
      new THREE.CylinderGeometry(0.12, 0.12, 1.4, 6).translate(0.8, 0.7, -0.8),
    ], false)
    if (tankGeo) {
      const items = waterTowers.map((a, i) => {
        const rngW = mulberry32(9500 + i)
        const lx = (rngW() - 0.5) * (a.w - 6)
        const lz = (rngW() - 0.5) * (a.d - 6)
        // +5 cm: leg bases were EXACTLY coplanar with the roof plane → flicker
        const wp = new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), a.rot).add(new THREE.Vector3(a.x, a.h + 0.05, a.z))
        return { x: wp.x, y: wp.y, z: wp.z, rot: a.rot }
      })
      // always-lit tone: the tank sits under its own overhanging cone lid, so
      // a lit-only material rendered the whole tower as a black silhouette
      // against the sky ("random floating black blocks" reports)
      addInstanced(tankGeo, new THREE.MeshBasicMaterial({ color: '#9c7b52' }), items)
    }
  }
  // solar panels
  if (solarPanels.length) {
    const geo = new THREE.BoxGeometry(1.7, 0.06, 1.1)
    const items: { x: number; y: number; z: number; rot?: number }[] = []
    solarPanels.forEach((a, i) => {
      const rngS = mulberry32(9800 + i)
      const row = i % 3
      const col = Math.floor(i / 3)
      const lx = -a.w / 3 + row * (a.w / 3)
      const lz = -a.d / 3 + col * (a.d / 3)
      const wp = new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), a.rot).add(new THREE.Vector3(a.x, a.h + 0.35, a.z))
      items.push({ x: wp.x, y: wp.y, z: wp.z, rot: a.rot + 0.2 })
    })
    // steel-blue glass with a built-in sheen: rooftop panels sit against the
    // sky from street level, and ANY dark tone reads as a detached black
    // block once the host roof fades into haze — keep them mid-tone
    const solarMat = new THREE.MeshStandardMaterial({
      color: '#7e8c96',
      roughness: 0.28,
      metalness: 0.5,
      emissive: new THREE.Color('#4a5a64'),
      emissiveIntensity: 0.5,
    })
    addInstanced(geo, solarMat, items)
  }
  // stair bulkheads — always-lit tone (rooftop objects die against the sky otherwise)
  if (bulkheads.length) {
    const geo = mergeGeometries(
      [
        new THREE.BoxGeometry(2.4, 2.2, 3.2).translate(0, 1.1, 0),
        new THREE.BoxGeometry(2.9, 0.14, 3.7).translate(0, 2.27, 0),
      ],
      false,
    )
    if (geo) {
      const items = bulkheads.map((a, i) => {
        const rngB = mulberry32(11000 + i)
        const lx = (rngB() - 0.5) * (a.w - 6)
        const lz = (rngB() - 0.5) * (a.d - 6)
        // +4 cm: the box bottom was EXACTLY coplanar with the roof plane
        const wp = new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), a.rot).add(new THREE.Vector3(a.x, a.h + 0.04, a.z))
        return { x: wp.x, y: wp.y, z: wp.z, rot: a.rot }
      })
      addInstanced(geo, new THREE.MeshBasicMaterial({ color: '#a9a59b' }), items)
    }
  }
  // chimneys on pitched roofs — brick tone, always-lit
  if (chimneyItems.length) {
    const geo = mergeGeometries(
      [
        new THREE.CylinderGeometry(0.26, 0.34, 1.4, 8).translate(0, 0.7, 0),
        new THREE.BoxGeometry(0.74, 0.1, 0.74).translate(0, 1.44, 0),
        new THREE.CylinderGeometry(0.09, 0.09, 0.5, 6).translate(0, 1.72, 0),
      ],
      false,
    )
    if (geo) addInstanced(geo, new THREE.MeshBasicMaterial({ color: '#8a6a52' }), chimneyItems)
  }
  // antenna masts on taller blocks
  if (antennas.length) {
    const geo = mergeGeometries(
      [
        new THREE.CylinderGeometry(0.05, 0.08, 4.6, 6).translate(0, 2.3, 0),
        new THREE.BoxGeometry(1.2, 0.05, 0.05).translate(0, 4.0, 0),
        new THREE.BoxGeometry(0.7, 0.05, 0.05).translate(0, 3.2, 0),
      ],
      false,
    )
    if (geo) {
      const items = antennas.map((a, i) => {
        const rngAn = mulberry32(13000 + i)
        const lx = (rngAn() - 0.5) * (a.w - 8)
        const lz = (rngAn() - 0.5) * (a.d - 8)
        // +5 cm off the roof plane (was exactly coplanar)
        const wp = new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), a.rot).add(new THREE.Vector3(a.x, a.h + 0.05, a.z))
        return { x: wp.x, y: wp.y, z: wp.z, rot: a.rot }
      })
      addInstanced(geo, new THREE.MeshBasicMaterial({ color: '#8b9094' }), items)
    }
  }
  // balconies — always-lit concrete tones: seen from below against a bright
  // sky the lit-only trim went near-black and read as "floating blocks"
  addInstanced(new THREE.BoxGeometry(2.2, 0.16, 1.05), new THREE.MeshBasicMaterial({ color: '#b3aa96' }), balconySlabs)
  addInstanced(new THREE.BoxGeometry(2.2, 0.06, 0.06), new THREE.MeshBasicMaterial({ color: '#5a615e' }), balconyRails)
  // containers
  if (containers.length) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 2.6, 2.4), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0.3 }), containers.length)
    const cols = ['#8c4a3a', '#5b6b4a', '#7a7d80']
    containers.forEach((c, i) => {
      dummy.position.set(c.x, 1.3, c.z)
      dummy.rotation.set(0, c.rot, 0)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      im.setMatrixAt(i, dummy.matrix)
      im.setColorAt(i, new THREE.Color(cols[c.c]))
    })
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.castShadow = true
    group.add(im)
    // container colliders
    for (const c of containers) {
      const w = c.rot === 0 ? 6 : 2.4
      const d = c.rot === 0 ? 2.4 : 6
      extraColliders.push({ minX: c.x - w / 2, maxX: c.x + w / 2, minZ: c.z - d / 2, maxZ: c.z + d / 2, h: 2.6 })
    }
  }

  // ---- special buildings ----
  // (label OR special archetype — e.g. the unlabeled hospital helipad tower)
  const specials = plan.buildings.filter((b) => b.label || b.kind === 'hospital')
  for (const b of specials) {
    buildSpecial(group, b, mats, extraColliders, rng)
  }

  // ---- doors for enterables ----
  const doorMarkers: { id: string; x: number; z: number }[] = []
  for (const e of plan.enterables) {
    doorMarkers.push({ id: e.id, x: e.doorX, z: e.doorZ })
    buildDoor(group, e, mats)
  }

  return { group, colliders: extraColliders, doorMarkers }
}

/* ---------------- special buildings ---------------- */

function buildSpecial(group: THREE.Group, b: BuildingSpec, mats: CityMaterials, colliders: AABB[], rng: () => number) {
  const rot = (b.rotation * Math.PI) / 180
  const g = new THREE.Group()
  g.position.set(b.x, 0, b.z)
  g.rotation.y = rot
  const W = b.w
  const D = b.d
  const H = b.height

  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, shadow = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    m.position.set(x, y, z)
    m.castShadow = shadow
    m.receiveShadow = true
    g.add(m)
    return m
  }
  const cyl = (r: number, h: number, x: number, y: number, z: number, mat: THREE.Material, seg = 12) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat)
    m.position.set(x, y, z)
    m.castShadow = true
    m.receiveShadow = true
    g.add(m)
    return m
  }
  const sign = (text: string, w: number, hgt: number, x: number, y: number, z: number, opts?: { bg?: string; fg?: string }) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), mats.signMaterial(text, opts))
    m.position.set(x, y, z)
    g.add(m)
    return m
  }
  // facade-textured building shell with PROPERLY TILED UVs (one window
  // module per ~3.3 × 3.05 m, matching the generic walls) — plain
  // BoxGeometry stretches one texture across the whole face and reads as
  // a featureless smear
  const shell = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const geo = new THREE.BoxGeometry(w, h, d)
    const uv = geo.attributes.uv as THREE.BufferAttribute
    const su = [d, d, w, w, w, w].map((v) => Math.max(1, Math.round(v / 3.3)))
    const sv = [h, h, d, d, h, h].map((v) => Math.max(1, Math.round(v / 3.05)))
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < 4; i++) {
        const k = f * 4 + i
        uv.setXY(k, uv.getX(k) * su[f], uv.getY(k) * sv[f])
      }
    }
    // white vertex tint — keeps shells compatible with the shared
    // vertexColors facade materials (special facades ignore it)
    tintGeo(geo, new THREE.Color(1, 1, 1))
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    m.castShadow = true
    m.receiveShadow = true
    g.add(m)
    return m
  }
  // wide painted frieze above the entrance — the building's nameplate
  const mural = (text: string, kind: string, w: number, hgt: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), mats.muralMaterial(text, kind))
    m.position.set(x, y, z)
    g.add(m)
    return m
  }

  switch (b.kind) {
    case 'transit-hub': {
      // stone walls + barrel roof
      shell(W, H - 2, D, 0, (H - 2) / 2, 0, mats.specialFacade('hub'))
      const vault = new THREE.Mesh(new THREE.CylinderGeometry(D / 2, D / 2, W, 16, 1, false, 0, Math.PI), mats.metal)
      vault.rotation.z = Math.PI / 2
      vault.position.y = H - 2
      vault.castShadow = true
      g.add(vault)
      // lit hall glazing — warm glowing wall + mullions read as the station interior
      // (every layer at its own depth: wall 0 · glow +0.04 · mullions +0.09 · portal +0.22)
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(W * 0.7, 5.6),
        new THREE.MeshStandardMaterial({ color: '#a8875c', emissive: '#ffd9a0', emissiveIntensity: 1.15, roughness: 0.5 }),
      )
      glow.position.set(0, 2.8, D / 2 + 0.04)
      g.add(glow)
      for (let i = -3; i <= 3; i++) {
        const mul = new THREE.Mesh(new THREE.BoxGeometry(0.18, 5.6, 0.1), mats.metalDark)
        mul.position.set((i * W * 0.7) / 7, 2.8, D / 2 + 0.09)
        g.add(mul)
      }
      const transom = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 0.16, 0.1), mats.metalDark)
      transom.position.set(0, 4.4, D / 2 + 0.09)
      g.add(transom)
      // entrance portal (aligns with the enterable door; sits proud of the glow wall)
      const portal = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.2, 0.22), mats.glassDark)
      portal.position.set(0, 1.6, D / 2 + 0.22)
      g.add(portal)
      // canopy + warm wall lamps over the entrance
      const can = new THREE.Mesh(new THREE.BoxGeometry(9, 0.28, 2.6), mats.metalDark)
      can.position.set(0, 3.8, D / 2 + 1.2)
      can.castShadow = true
      g.add(can)
      for (const lx of [-3.4, 3.4]) {
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.18, 0.18),
          new THREE.MeshStandardMaterial({ color: '#e8dfc8', emissive: '#ffca7a', emissiveIntensity: 1.2 }),
        )
        lamp.position.set(lx, 3.35, D / 2 + 0.14)
        g.add(lamp)
      }
      // columns
      for (const i of [-2, -1, 1, 2]) cyl(0.4, H - 2, i * 12, (H - 2) / 2, D / 2 + 1, mats.metalDark, 8)
      mural('CENTRAL STATION', 'hub', 16, 2.2, 0, H - 0.5, D / 2 + 0.3)
      // clock (well clear of the wall and of the hour hand)
      const clock = new THREE.Mesh(new THREE.CircleGeometry(1.2, 24), mats.white)
      clock.position.set(0, H - 3.4, D / 2 + 0.12)
      g.add(clock)
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.05), mats.black)
      hand.position.set(0, H - 3.2, D / 2 + 0.22)
      g.add(hand)
      // flags
      for (const fx of [-W / 2 + 3, W / 2 - 3]) {
        cyl(0.07, 9, fx, 4.5, D / 2 + 1.5, mats.metal, 6)
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1), mats.fabricGreen)
        flag.position.set(fx + 0.85, 8.2, D / 2 + 1.64)
        g.add(flag)
      }
      break
    }
    case 'market': {
      shell(W, H - 3, D, 0, (H - 3) / 2, 0, mats.specialFacade('market'))
      // pitched roof — pivot at the eaves so the panels meet wall-top & ridge exactly
      const wallTop = H - 3
      const overhang = 0.8
      const rise = Math.min(4.2, Math.max(2.6, D * 0.14))
      const halfSpan = D / 2 + overhang
      const slope = Math.sqrt(halfSpan * halfSpan + rise * rise)
      const pitch = Math.atan2(rise, halfSpan)
      const roofL = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 0.28, slope), mats.roofCommon)
      roofL.position.set(0, wallTop + rise / 2, -halfSpan / 2)
      roofL.rotation.x = -pitch
      roofL.castShadow = true
      roofL.receiveShadow = true
      g.add(roofL)
      const roofR = roofL.clone()
      roofR.position.z = halfSpan / 2
      roofR.rotation.x = pitch
      g.add(roofR)
      // ridge cap
      const cap = new THREE.Mesh(new THREE.BoxGeometry(W + 1.7, 0.16, 0.6), mats.metalDark)
      cap.position.set(0, wallTop + rise + 0.08, 0)
      cap.castShadow = true
      g.add(cap)
      // gable end walls closing the triangle under each roof end
      const triShape = new THREE.Shape()
      triShape.moveTo(-halfSpan, 0)
      triShape.lineTo(halfSpan, 0)
      triShape.lineTo(0, rise)
      triShape.closePath()
      const triGeo = new THREE.ExtrudeGeometry(triShape, { depth: 0.26, bevelEnabled: false })
      for (const ex of [-1, 1]) {
        const end = new THREE.Mesh(triGeo, mats.specialFacade('market'))
        end.rotation.y = ex < 0 ? Math.PI / 2 : -Math.PI / 2
        end.position.set((ex * (W + 0.7)) / 2, wallTop, 0)
        end.castShadow = true
        end.receiveShadow = true
        g.add(end)
      }
      // skylights laid ON each roof slope (replaces the old clerestory that
      // was buried inside the roof volume and never visible)
      for (const sz of [-1, 1]) {
        const sky = new THREE.Mesh(new THREE.BoxGeometry(W * 0.42, 0.09, slope * 0.42), mats.glassDark)
        sky.position.set(0, wallTop + rise / 2 + 0.24, (sz * halfSpan) / 2)
        sky.rotation.x = sz * pitch
        g.add(sky)
      }
      // arched windows sides (emissive strips)
      for (const sz of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const win = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), new THREE.MeshStandardMaterial({ color: '#5a5148', emissive: '#ffd9a0', emissiveIntensity: 0.35, roughness: 0.4 }))
          win.position.set(-W / 2 + 8 + i * (W - 16) / 3, 5, (sz * (D + 0.18)) / 2)
          if (sz < 0) win.rotation.y = Math.PI
          g.add(win)
        }
      }
      mural('MARKET HALL', 'market', 14, 2, 0, H - 3.6, D / 2 + 0.2)
      // awning
      const awn = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 0.15, 2.4), mats.fabricRed)
      awn.position.set(0, 4.8, D / 2 + 1.1)
      awn.rotation.x = 0.18
      awn.castShadow = true
      g.add(awn)
      break
    }
    case 'hospital': {
      if (b.d < 28 && b.floors >= 9) {
        // tower → helipad (pad uses an always-lit tone: from street level you
        // see the pad's UNDERSIDE, and a lit-only material rendered it as a
        // black slab floating on the roofline)
        shell(W, H, D, 0, H / 2, 0, mats.specialFacade('hospital'))
        const pad = new THREE.Mesh(
          new THREE.CylinderGeometry(6, 6, 0.35, 20),
          new THREE.MeshBasicMaterial({ color: '#c6c2b4' }),
        )
        pad.position.set(0, H + 0.3, 0)
        g.add(pad)
        const hMat = new THREE.MeshBasicMaterial({ color: '#c23a2a' })
        for (const [ox, oz, w2, d2] of [[-1.4, 0, 0.6, 4], [1.4, 0, 0.6, 4], [0, 0, 2.4, 0.6]] as const) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(w2, 0.06, d2), hMat)
          bar.position.set(ox, H + 0.52, oz)
          g.add(bar)
        }
      } else {
        shell(W, H, D, 0, H / 2, 0, mats.specialFacade('hospital'))
        // canopy + entrance
        box(10, 0.4, 4, 0, 4.2, D / 2 + 2, mats.white)
        for (const cx of [-4.5, 4.5]) cyl(0.15, 4.2, cx, 2.1, D / 2 + 3.5, mats.metal, 6)
        // glass bands (proud of the facade, thicker so they never z-fight)
        for (let f = 1; f < 3; f++) {
          const band = new THREE.Mesh(new THREE.BoxGeometry(W - 2, 1.2, 0.14), mats.glassDark)
          band.position.set(0, f * 3.4, D / 2 + 0.14)
          g.add(band)
        }
        mural('CITY HOSPITAL', 'hospital', 12, 1.6, 0, 5.2, D / 2 + 0.25)
      }
      break
    }
    case 'fire': {
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('fire'))
      // concrete apron in front of the bay doors (rigs pull across it)
      box(W - 14, 0.06, 9, 0, 0.05, D / 2 + 4.5, mats.concrete, false)
      // garage doors
      for (let i = -1; i <= 1; i++) {
        const door = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 3.4), mats.metalDark)
        door.position.set(i * 7, 1.7, D / 2 + 0.05)
        g.add(door)
        const frame = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 0.3), mats.neonRed)
        frame.position.set(i * 7, 3.6, D / 2 + 0.14)
        g.add(frame)
      }
      // drill tower
      cyl(2.2, 14, W / 2 + 2.6, 7, 0, mats.brickRed, 10)
      box(5, 2.5, 5, W / 2 + 2.6, 15.2, 0, mats.metalDark)
      mural(b.label || 'FIRE STATION 1', 'fire', 11, 1.7, 0, H - 1, D / 2 + 0.2)
      colliders.push({ minX: b.x + (W / 2 + 0.4) * Math.cos(rot) - 2.6, maxX: b.x + (W / 2 + 0.4) * Math.cos(rot) + 2.6, minZ: b.z - (W / 2 + 0.4) * Math.sin(rot) - 2.6, maxZ: b.z - (W / 2 + 0.4) * Math.sin(rot) + 2.6, h: 15 })
      break
    }
    case 'police': {
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('police'))
      for (let i = -1; i <= 1; i++) box(1, H, 1, i * (W / 3), H / 2, D / 2 + 0.4, mats.concreteLight)
      mural('POLICE HQ', 'police', 9, 1.6, 0, H - 1.2, D / 2 + 0.2)
      break
    }
    case 'school': {
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('school'))
      // wings
      shell(W * 0.35, H * 0.8, D + 8, -W * 0.32, (H * 0.8) / 2, 0, mats.specialFacade('school'))
      shell(W * 0.35, H * 0.8, D + 8, W * 0.32, (H * 0.8) / 2, 0, mats.specialFacade('school'))
      // entrance canopy
      box(8, 0.35, 3.5, 0, 3.6, D / 2 + 1.6, mats.fabricGreen)
      // window strips: center bay between the wings + matching strips on the wings
      // (the old full-width strips sliced through the wing volumes)
      const bayW = Math.max(4, W * 0.29 - 1)
      for (let f = 0; f < 3; f++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(bayW, 1.4, 0.12), mats.glassDark)
        strip.position.set(0, 2.4 + f * 3, D / 2 + 0.1)
        g.add(strip)
        for (const sx of [-1, 1]) {
          const wstrip = new THREE.Mesh(new THREE.BoxGeometry(W * 0.35 - 1.2, 1.4, 0.12), mats.glassDark)
          wstrip.position.set(sx * W * 0.32, 2.4 + f * 3, D / 2 + 4.1)
          g.add(wstrip)
        }
      }
      // flagpole (clear of the wing face)
      cyl(0.06, 7, -W / 2 - 3, 3.5, D / 2 + 4.5, mats.metal, 6)
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), mats.fabricGreen)
      flag.position.set(-W / 2 - 2.3, 6.4, D / 2 + 4.6)
      g.add(flag)
      if (b.label) mural(b.label, 'school', 14, 1.5, 0, H - 0.8, D / 2 + 0.2)
      break
    }
    case 'utility': {
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('depot'))
      // tanks
      cyl(4, 6, -W / 2 - 5, 3, -2, mats.concrete, 14)
      cyl(4, 6, -W / 2 - 5, 3, 6, mats.concrete, 14)
      // pipes
      cyl(0.3, 12, -W / 2 + 1, 5.5, D / 2 + 2, mats.metalDark, 8).rotation.z = Math.PI / 2
      if (b.label) mural(b.label, 'works', 12, 1.4, 0, H - 0.8, D / 2 + 0.2)
      colliders.push({ minX: b.x + (-W / 2 - 9) * Math.cos(rot) - 4, maxX: b.x + (-W / 2 - 1) * Math.cos(rot) + 4, minZ: b.z - 6, maxZ: b.z + 10, h: 6 })
      break
    }
    case 'depot': {
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('depot'))
      for (let i = 0; i < 4; i++) {
        const door = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 4.6), mats.metalDark)
        door.position.set(-W / 2 + 8 + i * (W - 16) / 3, 2.3, D / 2 + 0.06)
        g.add(door)
      }
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(W - 4, 0.25, 3), mats.metal)
      canopy.position.set(0, 5.4, D / 2 + 1.4)
      canopy.castShadow = true
      g.add(canopy)
      mural('BUS DEPOT', 'depot', 10, 1.5, 0, H - 1, D / 2 + 0.2)
      break
    }
    case 'industrial': {
      if (b.label === 'FACTORY') {
        shell(W, H, D, 0, H / 2, 0, mats.specialFacade('factory'))
        // sawtooth roof
        for (let i = 0; i < 3; i++) {
          const tooth = new THREE.Mesh(new THREE.BoxGeometry(W / 3, 0.3, D + 1), mats.metalDark)
          tooth.position.set(-W / 3 + i * (W / 3), H + 2.0, 0)
          tooth.rotation.z = -0.2
          tooth.castShadow = true
          g.add(tooth)
        }
        // chimneys
        cyl(1.2, 16, -W / 2 + 5, 8, -D / 2 + 5, mats.brickRed, 10)
        cyl(1.4, 1.5, -W / 2 + 5, 16.4, -D / 2 + 5, mats.metalDark, 10)
        cyl(1.2, 16, -W / 2 + 5, 8, -D / 2 + 12, mats.brickRed, 10)
        cyl(1.4, 1.5, -W / 2 + 5, 16.4, -D / 2 + 12, mats.metalDark, 10)
        // tanks
        cyl(2.6, 5, W / 2 - 4, 2.5, D / 2 + 5, mats.metal, 12)
        colliders.push({ minX: b.x - W / 2 + 1, maxX: b.x - W / 2 + 9, minZ: b.z - D / 2, maxZ: b.z - D / 2 + 18, h: 16 })
      } else if (b.label === 'RECYCLING') {
        shell(W, H, D, 0, H / 2, 0, mats.specialFacade('depot'))
        cyl(1.0, 8, -W / 2 + 3, 4, D / 2 + 2, mats.metalDark, 8)
        for (let i = 0; i < 3; i++) box(2.2, 1.6, 1.4, -3 + i * 3, 0.8, D / 2 + 3, i % 2 ? mats.fabricGreen : mats.planter)
        if (b.label) mural(b.label, 'recycling', 10, 1.3, 0, H - 0.8, D / 2 + 0.2)
      } else {
        // warehouse/depot-adjacent
        shell(W, H, D, 0, H / 2, 0, mats.specialFacade('depot'))
        const dock = box(W * 0.7, 1.2, 3, 0, 0.6, D / 2 + 1.5, mats.concrete)
        void dock
        if (b.label) mural(b.label, 'works', 10, 1.3, 0, H - 0.8, D / 2 + 0.2)
      }
      break
    }
    case 'retail': {
      // café / grocery handled mostly by storefront band; add labels + awnings
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('retail'))
      if (b.label) {
        mural(b.label, 'retail', Math.min(W * 0.85, 12), 1.2, 0, Math.min(H - 0.6, 4.4), D / 2 + 0.15)
        const awn = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.12, 1.6), mats.fabricGreen)
        awn.position.set(0, 3.4, D / 2 + 0.7)
        awn.rotation.x = 0.2
        awn.castShadow = true
        g.add(awn)
      }
      break
    }
    case 'office': {
      if (b.label) {
        shell(W, H, D, 0, H / 2, 0, mats.specialFacade('office'))
        // vertical sign panel
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(3, H * 0.55), mats.signMaterial(b.label, { bg: '#14261e', fg: '#7ee0a8', w: 128, h: 512 }))
        panel.position.set(0, H * 0.55, D / 2 + 0.12)
        g.add(panel)
        // entrance portal
        box(5, 3.4, 0.3, 0, 1.7, D / 2 + 0.1, mats.glassDark)
        box(6.4, 0.5, 2.6, 0, 3.8, D / 2 + 1.1, mats.metalDark)
      }
      break
    }
    case 'library': {
      // civic brick hall with tall arched windows + clerestory
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('library'))
      // cornice + parapet
      box(W + 0.9, 0.55, D + 0.9, 0, H - 0.28, 0, mats.concreteLight)
      box(W + 0.4, 0.5, D + 0.4, 0, H + 0.08, 0, mats.facades[7].material)
      // tall arched windows on the south face (glass + half-disc arch + stone surround)
      const archGeo = new THREE.CircleGeometry(1.05, 14, 0, Math.PI)
      const nWin = Math.max(4, Math.round(W / 9))
      for (let i = 0; i < nWin; i++) {
        const wx = -W / 2 + (W / (nWin + 1)) * (i + 1)
        // surround
        box(2.7, 6.9, 0.18, wx, 3.9, D / 2 + 0.06, mats.concreteLight, false)
        const glass = new THREE.Mesh(new THREE.BoxGeometry(2.2, 4.8, 0.1), mats.glassDark)
        glass.position.set(wx, 3.55, D / 2 + 0.12)
        g.add(glass)
        const arch = new THREE.Mesh(archGeo, mats.glassDark)
        arch.position.set(wx, 5.95, D / 2 + 0.12)
        g.add(arch)
        // mullions
        box(0.09, 4.8, 0.14, wx, 3.55, D / 2 + 0.15, mats.metalDark, false)
        box(2.2, 0.09, 0.14, wx, 3.55, D / 2 + 0.15, mats.metalDark, false)
        // sill
        box(2.9, 0.22, 0.3, wx, 1.02, D / 2 + 0.16, mats.concreteLight, false)
      }
      // clerestory band under the cornice
      const clere = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 1.0, 0.1), mats.glassDark)
      clere.position.set(0, H - 1.45, D / 2 + 0.06)
      g.add(clere)
      for (let i = -4; i <= 4; i++) box(0.12, 1.0, 0.13, (i * W * 0.86) / 9, H - 1.45, D / 2 + 0.08, mats.metalDark, false)
      // stone entrance portal + double doors + canopy + steps
      box(5.2, 3.6, 0.4, 0, 1.8, D / 2 + 0.08, mats.concreteLight)
      const door = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.9, 0.14), mats.glassDark)
      door.position.set(0, 1.45, D / 2 + 0.18)
      g.add(door)
      box(0.08, 2.9, 0.16, 0, 1.45, D / 2 + 0.2, mats.metalDark, false)
      const lcan = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.24, 2.4), mats.metalDark)
      lcan.position.set(0, 4.0, D / 2 + 1.1)
      lcan.castShadow = true
      g.add(lcan)
      for (const px of [-3.2, 3.2]) cyl(0.09, 3.8, px, 1.9, D / 2 + 2.0, mats.metalDark, 6)
      // steps
      box(6.5, 0.18, 1.1, 0, 0.09, D / 2 + 0.75, mats.concreteLight, false)
      box(5.6, 0.18, 0.6, 0, 0.27, D / 2 + 0.55, mats.concreteLight, false)
      // warm wall lamps beside the portal
      for (const lx of [-2.9, 2.9]) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.14), new THREE.MeshStandardMaterial({ color: '#e8dfc8', emissive: '#ffca7a', emissiveIntensity: 1.1 }))
        lamp.position.set(lx, 3.15, D / 2 + 0.16)
        g.add(lamp)
      }
      // "CITY LIBRARY" letters above the cornice line
      mural(b.label || 'CITY LIBRARY', 'library', 15, 1.7, 0, H - 2.6, D / 2 + 0.2)
      break
    }
    case 'clinic': {
      // modern white pavilion: ribbon windows, green cross, drop-off canopy
      shell(W, H, D, 0, H / 2, 0, mats.specialFacade('clinic'))
      box(W + 0.5, 0.45, D + 0.5, 0, H + 0.1, 0, mats.white) // parapet
      // roof AC units
      box(1.6, 0.7, 1.4, -W * 0.22, H + 0.6, -D * 0.15, mats.metal, false)
      box(1.2, 0.55, 1.1, W * 0.18, H + 0.52, D * 0.2, mats.metal, false)
      // ribbon windows (2 rows)
      for (const ry of [1.6, 3.4]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(W - 3, 1.1, 0.12), mats.glassDark)
        rib.position.set(0, ry, D / 2 + 0.05)
        g.add(rib)
        for (let i = -3; i <= 3; i++) box(0.1, 1.1, 0.14, (i * (W - 3)) / 7, ry, D / 2 + 0.08, mats.white, false)
      }
      // glowing green cross (right of the entrance)
      const crossMat = new THREE.MeshStandardMaterial({ color: '#1d5c38', emissive: '#2ecc71', emissiveIntensity: 0.85, roughness: 0.4 })
      const cv = new THREE.Mesh(new THREE.BoxGeometry(0.55, 2.1, 0.16), crossMat)
      cv.position.set(W * 0.28, H - 1.5, D / 2 + 0.08)
      g.add(cv)
      const ch = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.55, 0.16), crossMat)
      ch.position.set(W * 0.28, H - 1.5, D / 2 + 0.08)
      g.add(ch)
      // glazed entrance + canopy on posts
      box(4.6, 3.0, 0.2, 0, 1.5, D / 2 + 0.08, mats.glassDark)
      box(0.1, 3.0, 0.22, 0, 1.5, D / 2 + 0.1, mats.metalDark, false)
      const ccan = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.2, 2.6), mats.metalDark)
      ccan.position.set(0, 3.5, D / 2 + 1.2)
      ccan.castShadow = true
      g.add(ccan)
      for (const px of [-2.9, 2.9]) cyl(0.08, 3.4, px, 1.7, D / 2 + 2.2, mats.metal, 6)
      // ambulance / drop-off bay on the east side
      const bay = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.18, 6.5), mats.metalDark)
      bay.position.set(W / 2 + 2.4, 3.5, 0)
      bay.castShadow = true
      g.add(bay)
      for (const bz of [-2.6, 2.6]) cyl(0.08, 3.4, W / 2 + 2.4, 1.7, bz, mats.metal, 6)
      box(3.4, 0.14, 5.4, W / 2 + 2.4, 0.07, 0, mats.concreteLight, false) // bay pad
      sign('EMERGENCY', 2.6, 0.55, W / 2 + 2.4, 4.05, 0, { bg: '#8a1f1f', fg: '#ffe8e0' })
      mural(b.label || 'CLINIC', 'clinic', 8.5, 1.2, -W * 0.14, H - 0.5, D / 2 + 0.22)
      break
    }
    case 'twinTowers': {
      // SKYLINK TOWERS — the city's landmark: two glass towers of DIFFERENT
      // heights sharing a podium, bridged by a glazed sky lobby high in the
      // air. One merged curtain-wall mesh + one merged mullion mesh keep the
      // draw calls sane for this geometry-dense special.
      const mull = new THREE.MeshBasicMaterial({ color: '#6f7873' })
      const glassGeos: THREE.BufferGeometry[] = []
      const glassShell = (w2: number, h2: number, d2: number, x: number, y: number, z: number) => {
        const geo = new THREE.BoxGeometry(w2, h2, d2)
        const uv = geo.attributes.uv as THREE.BufferAttribute
        const su = [d2, d2, w2, w2, w2, w2].map((v) => Math.max(1, Math.round(v / 3.3)))
        const sv = [h2, h2, d2, d2, h2, h2].map((v) => Math.max(1, Math.round(v / 3.05)))
        for (let f = 0; f < 6; f++) {
          for (let i = 0; i < 4; i++) {
            const k = f * 4 + i
            uv.setXY(k, uv.getX(k) * su[f], uv.getY(k) * sv[f])
          }
        }
        tintGeo(geo, new THREE.Color(1, 1, 1))
        glassGeos.push(geo.translate(x, y, z))
      }
      const mullGeos: THREE.BufferGeometry[] = []
      const mullAt = (w2: number, h2: number, d2: number, x: number, y: number, z: number) => {
        mullGeos.push(new THREE.BoxGeometry(w2, h2, d2).translate(x, y, z))
      }
      const mullify = (cx: number, cz: number, w2: number, d2: number, y0: number, y1: number) => {
        const hgt = y1 - y0
        const finNX = Math.max(2, Math.round(w2 / 1.65))
        const finNZ = Math.max(2, Math.round(d2 / 1.65))
        for (let i = 0; i <= finNX; i++) {
          const lx = -w2 / 2 + (w2 / finNX) * i
          for (const sz of [-1, 1]) mullAt(0.1, hgt, 0.16, cx + lx, y0 + hgt / 2, cz + (sz * d2) / 2 + 0.08)
        }
        for (let i = 0; i <= finNZ; i++) {
          const lz = -d2 / 2 + (d2 / finNZ) * i
          for (const sx of [-1, 1]) mullAt(0.16, hgt, 0.1, cx + (sx * w2) / 2 + 0.08, y0 + hgt / 2, cz + lz)
        }
        if (y0 === 0) mullAt(w2 + 0.18, 0.16, 0.18, cx, 4, cz)
        for (let y = (y0 === 0 ? 4 : y0) + 3.1; y < y1 - 0.8; y += 3.1) {
          for (const sz of [-1, 1]) mullAt(w2 + 0.18, 0.15, 0.18, cx, y, cz + (sz * d2) / 2 + 0.08)
          for (const sx of [-1, 1]) mullAt(0.18, 0.15, d2 + 0.18, cx + (sx * w2) / 2 + 0.08, y, cz)
        }
      }
      const topRoof = (w2: number, d2: number, x: number, z: number, y: number) => {
        const p = new THREE.PlaneGeometry(w2, d2)
        p.rotateX(-Math.PI / 2)
        p.translate(x, y, z)
        const m = new THREE.Mesh(p, mats.roofCommon)
        m.receiveShadow = true
        g.add(m)
      }

      // ---- podium (0..8): full-block glass retail base with corner piers ----
      glassShell(W, 8, D, 0, 4, 0)
      mullify(0, 0, W, D, 0, 8)
      for (const px of [-1, 1]) {
        for (const pz of [-1, 1])
          // piers sit 6 cm PROUD of the glass skin — the old position put the
          // pier's outer face EXACTLY coplanar with the glass → the four
          // podium corners z-fought (the landmark is visible from spawn)
          box(0.9, 8, 0.9, (px * (W - 0.78)) / 2, 4, (pz * (D - 0.78)) / 2, mats.metalDark)
      }
      // dark frame ring at the podium top
      box(W + 0.5, 0.55, D + 0.5, 0, 7.9, 0, mats.metalDark)
      // ---- TOWER A (taller, setbacks) ----
      const ax = -15
      glassShell(22, 50, 22, ax, 8 + 25, 0) // 8..58
      mullify(ax, 0, 22, 22, 8, 58)
      topRoof(22, 22, ax, 0, 58)
      box(22.14, 0.4, 22.14, ax, 57.7, 0, mats.metalDark)
      glassShell(18, 20, 18, ax, 58 + 10, 0) // 58..78
      mullify(ax, 0, 18, 18, 58, 78)
      topRoof(18, 18, ax, 0, 78)
      box(18.14, 0.4, 18.14, ax, 77.7, 0, mats.metalDark)
      glassShell(13, 23, 13, ax, 78 + 11.5, 0) // 78..101
      mullify(ax, 0, 13, 13, 78, 101)
      topRoof(13, 13, ax, 0, 101)
      box(13.14, 0.5, 13.14, ax, 100.7, 0, mats.metalDark)
      // crown: spire + mast + red aviation beacons
      const spire = cyl(0.45, 8, ax, 105, 0, mats.metal, 8)
      void spire
      cyl(0.12, 8, ax, 113, 0, mats.metalDark, 6)
      const beaconMat = new THREE.MeshBasicMaterial({ color: '#ff4038', toneMapped: false })
      const beacon = (x: number, y: number, z: number) => {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), beaconMat)
        s.position.set(x, y, z)
        g.add(s)
      }
      beacon(ax, 117.2, 0)
      beacon(ax - 5.5, 101.5, 5.5)
      beacon(ax + 5.5, 101.5, -5.5)
      // rooftop mechanical box on tier 2
      box(3, 2.4, 4, ax + 3, 79.2, 2, mull)
      // ---- TOWER B (shorter) ----
      const bx = 17
      glassShell(17, 66, 17, bx, 8 + 33, 0) // 8..74
      mullify(bx, 0, 17, 17, 8, 74)
      topRoof(17, 17, bx, 0, 74)
      box(17.14, 0.5, 17.14, bx, 73.7, 0, mats.metalDark)
      // B roof: stair bulkhead + green roof + window-washing davit
      box(2.6, 2.3, 3.4, bx - 4, 75.2, 3, mull)
      box(3.1, 0.14, 3.9, bx - 4, 76.5, 3, mats.metalDark)
      const lawn = new THREE.Mesh(new THREE.BoxGeometry(9, 0.22, 7), mats.grassDark)
      lawn.position.set(bx + 2.5, 74.2, -2.5)
      lawn.receiveShadow = true
      g.add(lawn)
      cyl(0.09, 2.6, bx + 6.5, 75.3, 5.5, mats.metal, 6)
      box(2.4, 0.08, 0.08, bx + 5.4, 76.5, 5.5, mats.metal)
      // ---- SKY BRIDGE (56..63.5): glazed link, A's upper tier → B's top ----
      glassShell(16.5, 7.5, 4.6, 2.4, 59.75, 0)
      // steel chords top + bottom, posts, walkway floor
      box(17.4, 0.55, 5.4, 2.4, 55.7, 0, mats.metalDark)
      box(17.4, 0.55, 5.4, 2.4, 64.1, 0, mats.metalDark)
      const floorSlab = new THREE.Mesh(new THREE.BoxGeometry(16, 0.35, 4.2), mats.concreteLight)
      floorSlab.position.set(2.4, 56.3, 0)
      floorSlab.receiveShadow = true
      g.add(floorSlab)
      for (let i = 0; i <= 7; i++) {
        const px2 = 2.4 - 8.25 + (16.5 / 7) * i
        for (const sz of [-1, 1]) mullAt(0.12, 7.5, 0.14, px2, 59.75, (sz * 4.6) / 2 + 0.07)
      }
      for (const sz of [-1, 1]) mullAt(16.8, 0.14, 0.14, 2.4, 57.2, (sz * 4.6) / 2 + 0.07)
      for (const sz of [-1, 1]) mullAt(16.8, 0.14, 0.14, 2.4, 62.4, (sz * 4.6) / 2 + 0.07)
      // ---- merged curtain wall + mullions ----
      const mergedGlass = mergeGeometries(glassGeos, false)
      if (mergedGlass) {
        const gm = new THREE.Mesh(mergedGlass, mats.glassTower)
        gm.castShadow = true
        gm.receiveShadow = true
        g.add(gm)
      }
      const mergedMull = mergeGeometries(mullGeos, false)
      if (mergedMull) {
        const mm = new THREE.Mesh(mergedMull, mull)
        mm.castShadow = true
        g.add(mm)
      }
      // ---- entrance (south) + plaza ----
      box(7, 4.2, 0.4, 0, 2.1, D / 2 + 0.12, mats.glassDark)
      box(0.14, 4.2, 0.42, 0, 2.1, D / 2 + 0.2, mats.metalDark, false)
      box(11, 0.3, 3.4, 0, 4.6, D / 2 + 1.6, mats.metalDark)
      for (const px2 of [-4.8, 4.8]) cyl(0.14, 4.4, px2, 2.2, D / 2 + 2.9, mats.metal, 6)
      box(7.5, 0.16, 1.2, 0, 0.08, D / 2 + 0.7, mats.concreteLight, false)
      box(6.2, 0.16, 0.7, 0, 0.24, D / 2 + 0.35, mats.concreteLight, false)
      const pad = new THREE.Mesh(new THREE.BoxGeometry(26, 0.12, 9), mats.concreteLight)
      pad.position.set(0, 0.06, D / 2 + 5.5)
      pad.receiveShadow = true
      g.add(pad)
      for (const px2 of [-11, -3.5, 3.5, 11]) {
        box(1.9, 0.85, 1.9, px2, 0.55, D / 2 + 4, mats.planter)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 6), mats.foliage)
        bush.position.set(px2, 1.5, D / 2 + 4)
        bush.castShadow = true
        g.add(bush)
      }
      for (const fx of [-13, 13]) {
        cyl(0.06, 8, fx, 4, D / 2 + 3.6, mats.metal, 6)
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95), mats.fabricGreen)
        flag.position.set(fx + 0.8, 7.4, D / 2 + 3.62)
        g.add(flag)
      }
      mural('SKYLINK TOWERS', 'office', 15, 1.9, 0, 6.4, D / 2 + 0.24)
      // vertical name panel on tower A — mounted ON the crown face (the old
      // panel floated 4.75 m in front of the 13 m crown shaft with nothing
      // holding it, reading as one of the "random floating blocks")
      const vpanel = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 22), mats.signMaterial('SKYLINK', { bg: '#14261e', fg: '#7ee0a8', w: 96, h: 640 }))
      vpanel.position.set(ax, 90, 6.5 + 0.3)
      g.add(vpanel)
      // ---- EXTERNAL PANORAMIC ELEVATOR (west face of tower A) ----
      // glazed shaft from the podium roof up to the sky deck; the cab idles
      // at the top. The engine teleports the player lobby ⇄ deck via this lift.
      const shaftX = ax - 12.7
      glassShell(3.2, 70.35, 3.2, shaftX, 8 + 35.175, 0)
      mullAt(0.14, 70.35, 0.2, shaftX - 1.6, 43.2, 0)
      mullAt(0.14, 70.35, 0.2, shaftX + 1.6, 43.2, 0)
      for (let sy = 14; sy < 78; sy += 8.8) {
        mullAt(3.4, 0.16, 0.24, shaftX, sy, 1.65)
        mullAt(3.4, 0.16, 0.24, shaftX, sy, -1.65)
      }
      const cab = box(2.5, 2.6, 2.5, shaftX, 76.2, 0, new THREE.MeshStandardMaterial({ color: '#d8e2da', emissive: '#ffe9c0', emissiveIntensity: 0.55, roughness: 0.3 }))
      void cab
      box(3.6, 0.4, 3.6, shaftX, 78.5, 0, mats.metalDark) // shaft head
      // ground collider for the shaft (city level — it stands on the court)
      colliders.push({ minX: b.x + shaftX - 1.8, maxX: b.x + shaftX + 1.8, minZ: b.z - 1.8, maxZ: b.z + 1.8, h: 78 })
      // ---- SKY DECK (79): cantilevered public observation platform around
      // the crown of tower A — the player RIDES the lift up here ----
      const DECK_Y = 78.35 // walkable surface (slab top)
      const deckHalf = 10.5
      const deck = new THREE.Mesh(new THREE.BoxGeometry(deckHalf * 2, 0.3, deckHalf * 2), mats.concreteLight)
      deck.position.set(ax, DECK_Y - 0.15, 0)
      deck.receiveShadow = true
      deck.castShadow = true
      g.add(deck)
      // glass parapet + steel handrail around the edge
      const railM = mats.metalDark
      const deckEdges: [number, number, number, number][] = [
        [deckHalf, 0, 0.08, deckHalf * 2 + 0.16], // x+ ...
      ]
      void deckEdges
      const paraX = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.15, deckHalf * 2), mats.glassDark)
      paraX.position.set(ax + deckHalf - 0.04, DECK_Y + 0.575, 0)
      g.add(paraX)
      const paraX2 = paraX.clone()
      paraX2.position.x = ax - deckHalf + 0.04
      g.add(paraX2)
      const paraZ = new THREE.Mesh(new THREE.BoxGeometry(deckHalf * 2, 1.15, 0.08), mats.glassDark)
      paraZ.position.set(ax, DECK_Y + 0.575, deckHalf - 0.04)
      g.add(paraZ)
      const paraZ2 = paraZ.clone()
      paraZ2.position.z = -deckHalf + 0.04
      g.add(paraZ2)
      for (const hx of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, deckHalf * 2), railM)
        rail.position.set(ax + hx * (deckHalf - 0.04), DECK_Y + 1.18, 0)
        g.add(rail)
        const rail2 = new THREE.Mesh(new THREE.BoxGeometry(deckHalf * 2, 0.07, 0.1), railM)
        rail2.position.set(ax, DECK_Y + 1.18, hx * (deckHalf - 0.04))
        g.add(rail2)
      }
      // parapet posts
      for (let pi = 0; pi <= 8; pi++) {
        const off = -deckHalf + (deckHalf * 2 / 8) * pi
        for (const hx of [-1, 1]) {
          mullAt(0.07, 1.15, 0.07, ax + hx * (deckHalf - 0.04), DECK_Y + 0.575, off)
          mullAt(0.07, 1.15, 0.07, ax + off, DECK_Y + 0.575, hx * (deckHalf - 0.04))
        }
      }
      // lift hut on the deck (against the crown, door facing south)
      const hutX = ax + 8.7
      box(3.0, 3.1, 3.2, hutX, DECK_Y + 1.55, 0, mats.metalDark)
      box(2.6, 2.6, 0.12, hutX, DECK_Y + 1.35, 1.62, mats.glassDark, false)
      const deckSign = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 0.5),
        mats.signMaterial('SKY DECK · 79 M', { bg: '#14261e', fg: '#7ee0a8', w: 384, h: 80 }),
      )
      deckSign.position.set(hutX, DECK_Y + 3.4, 1.66)
      g.add(deckSign)
      // viewing telescopes + benches + planters on the open corners
      for (const [tx, tz, ty] of [[ax - 8.2, 8.2, Math.PI * 0.75], [ax - 8.2, -8.2, Math.PI * 1.25]] as const) {
        cyl(0.3, 1.1, tx, DECK_Y + 0.55, tz, mats.metalDark, 8)
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 1.1, 8), mats.metal)
        tube.position.set(tx, DECK_Y + 1.35, tz)
        tube.rotation.x = ty * 0.2
        tube.rotation.z = ty * 0.15
        g.add(tube)
      }
      for (const [bx2, bz2, bry] of [[ax, 8.6, 0], [ax, -8.6, Math.PI]] as const) {
        const bench = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.09, 0.5), mats.wood)
        bench.position.set(bx2, DECK_Y + 0.5, bz2)
        bench.rotation.y = bry
        g.add(bench)
        for (const lo of [-1.1, 1.1]) box(0.09, 0.45, 0.4, bx2 + lo, DECK_Y + 0.25, bz2, mats.metalDark, false)
      }
      for (const [px3, pz3] of [[ax + 8.7, 8.4], [ax + 8.7, -8.4]] as const) {
        box(1.1, 0.7, 1.1, px3, DECK_Y + 0.35, pz3, mats.planter)
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), mats.foliage)
        bush.position.set(px3, DECK_Y + 1.0, pz3)
        g.add(bush)
      }
      // register the deck for the engine's lift teleport (rotation is 0 for
      // this special; center = tower A in world space)
      const dcx = b.x + ax
      const dcz = b.z
      const deckColliders: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [
        { minX: dcx - deckHalf - 0.4, maxX: dcx + deckHalf + 0.4, minZ: dcz + deckHalf - 0.25, maxZ: dcz + deckHalf + 0.25 },
        { minX: dcx - deckHalf - 0.4, maxX: dcx + deckHalf + 0.4, minZ: dcz - deckHalf - 0.25, maxZ: dcz - deckHalf + 0.25 },
        { minX: dcx + deckHalf - 0.25, maxX: dcx + deckHalf + 0.25, minZ: dcz - deckHalf, maxZ: dcz + deckHalf },
        { minX: dcx - deckHalf - 0.25, maxX: dcx - deckHalf + 0.25, minZ: dcz - deckHalf, maxZ: dcz + deckHalf },
        { minX: dcx - 6.9, maxX: dcx + 6.9, minZ: dcz - 6.9, maxZ: dcz + 6.9 }, // crown core
        { minX: dcx + 7.0, maxX: dcx + 10.4, minZ: dcz - 1.8, maxZ: dcz + 1.8 }, // lift hut
      ]
      skyDeck = {
        center: { x: dcx, z: dcz },
        floorY: DECK_Y,
        half: deckHalf,
        colliders: deckColliders,
        arrive: { x: dcx + 8.7, z: dcz + 3.0, yaw: Math.PI / 2 },
        liftZone: { x: dcx + 8.7, z: dcz + 2.3, r: 2.4 },
      }
      break
    }
    default: {
      shell(W, H, D, 0, H / 2, 0, mats.facades[b.facadeVariant % mats.facades.length].material)
      if (b.label) mural(b.label, 'works', Math.min(W * 0.8, 12), 1.4, 0, H - 0.8, D / 2 + 0.2)
    }
  }
  void rng
  group.add(g)
}

/* ---------------- doors ---------------- */

function buildDoor(group: THREE.Group, e: EnterableSpec, mats: CityMaterials) {
  const g = new THREE.Group()
  g.position.set(e.doorX, 0, e.doorZ)
  g.rotation.y = (e.facing * Math.PI) / 180

  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.6, 0.6), mats.metalDark)
  frame.position.set(0, 1.3, 0.1)
  frame.castShadow = true
  g.add(frame)
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.3), new THREE.MeshStandardMaterial({ color: '#3a2e24', roughness: 0.8 }))
  door.position.set(0, 1.15, 0.42)
  g.add(door)
  // warm light above
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.2), new THREE.MeshStandardMaterial({ color: '#d8d0b8', emissive: '#ffd9a0', emissiveIntensity: 0.8 }))
  lamp.position.set(0, 2.75, 0.2)
  g.add(lamp)
  // canopy
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.1, 1.2), e.interiorKind === 'cafe' ? mats.fabricGreen : mats.metalDark)
  canopy.position.set(0, 2.95, 0.55)
  canopy.rotation.x = 0.15
  canopy.castShadow = true
  g.add(canopy)
  // doormat
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), mats.gravel)
  mat.rotation.x = -Math.PI / 2
  mat.position.set(0, 0.012, 0.8)
  g.add(mat)

  group.add(g)
}
