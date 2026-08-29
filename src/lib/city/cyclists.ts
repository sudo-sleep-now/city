import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MAX_CYCLISTS, ROAD_WIDTH } from './constants'
import type { CityMaterials, CityPlan } from './types'

/* ============================================================
 * CyclistSystem — riders on the painted bike lanes of arterials
 * and collectors (transport hierarchy in action: bikes get their
 * own protected space on the biggest streets).
 *
 * Bikes are built like everything else here: small primitives
 * merged into one geometry per material group, drawn as
 * InstancedMeshes. Riders stream around the player and fade out
 * at night.
 * ============================================================ */

interface BikePath {
  axis: 'x' | 'z'
  coord: number // lateral centerline of the bike lane
  from: number
  to: number
  dir: 1 | -1
}

interface CyclistState {
  pathIdx: number
  dist: number
  speed: number
  /** eased current speed (slows for pedestrians ahead) */
  cur: number
  x: number
  z: number
  heading: number
  visible: boolean
  phase: number
}

const FRAME_COLORS = ['#c94f3d', '#d8a832', '#e8e4d8', '#e07a3f', '#5a8a6a', '#8c5a3a']
const CLOTHES = ['#8a6a4f', '#5b7461', '#7a5a68', '#96865c', '#a0522d', '#c94f3d', '#3f4a42', '#4a6a5a']

function vBox(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  if (rx) g.rotateX(rx)
  g.translate(x, y, z)
  return g
}
function vCyl(r1: number, r2: number, h: number, x: number, y: number, z: number, seg = 8, rx = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg)
  if (rx) g.rotateX(rx)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

export class CyclistSystem {
  group = new THREE.Group()
  /** flat ped positions (set by the engine) — riders slow down for them */
  pedQuery: (() => { count: number; data: Float32Array }) | null = null
  private paths: BikePath[] = []
  private riders: CyclistState[] = []
  private frameIM: THREE.InstancedMesh | null = null
  private tireIM: THREE.InstancedMesh | null = null
  private riderIM: THREE.InstancedMesh | null = null
  private helmetIM: THREE.InstancedMesh | null = null
  private rng = (() => {
    let s = 60606
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
  })()

  constructor(plan: CityPlan, mats: CityMaterials) {
    /* ---- bike lanes: same offsets as the painted strips in roads.ts ---- */
    for (const road of plan.roads) {
      if (road.pedestrianOnly) continue
      if (road.cls !== 'arterial' && road.cls !== 'collector') continue
      const width = road.cls === 'arterial' ? (road.coord === 0 ? 20 : ROAD_WIDTH.arterial) : ROAD_WIDTH[road.cls]
      const off = width / 2 - 1.0
      if (road.axis === 'x') {
        // eastbound (+x) keeps right → positive z side
        this.paths.push({ axis: 'x', coord: road.coord + off, from: road.from + 2, to: road.to - 2, dir: 1 })
        this.paths.push({ axis: 'x', coord: road.coord - off, from: road.from + 2, to: road.to - 2, dir: -1 })
      } else {
        // southbound (+z) keeps right → negative x side
        this.paths.push({ axis: 'z', coord: road.coord - off, from: road.from + 2, to: road.to - 2, dir: 1 })
        this.paths.push({ axis: 'z', coord: road.coord + off, from: road.from + 2, to: road.to - 2, dir: -1 })
      }
    }
    if (this.paths.length === 0) return

    /* ---- geometry: bike + rider, merged per material group ---- */
    // tires — cylinder axis along X (axle) so the wheel rolls along Z
    const tireGeo = mergeGeometries(
      [vCyl(0.34, 0.34, 0.07, 0, 0.34, 0.53, 12, 0, Math.PI / 2), vCyl(0.34, 0.34, 0.07, 0, 0.34, -0.53, 12, 0, Math.PI / 2)],
      false,
    )!
    // frame: diamond layout — down tube, seat tube, top tube, stays, fork, bars
    const frameGeo = mergeGeometries(
      [
        vBox(0.07, 0.07, 0.66, 0, 0.48, 0.24, -0.62), // down tube (head tube → crank)
        vBox(0.07, 0.5, 0.07, 0, 0.52, -0.18, -0.15), // seat tube
        vBox(0.06, 0.06, 0.72, 0, 0.76, 0.12, 0.06), // top tube
        vBox(0.06, 0.06, 0.6, 0, 0.33, -0.24), // chain stay
        vBox(0.06, 0.06, 0.52, 0, 0.56, -0.4, -0.52), // seat stay
        vBox(0.07, 0.42, 0.07, 0, 0.72, 0.44, -0.28), // head/steer tube (fork rakes FORWARD at the bottom)
        vBox(0.52, 0.05, 0.05, 0, 0.96, 0.48), // handlebar
        vBox(0.26, 0.06, 0.14, 0, 0.86, -0.28), // saddle
        vBox(0.07, 0.07, 0.36, 0, 0.32, 0.06), // crank
        vCyl(0.1, 0.1, 0.04, 0, 0.32, 0.06, 8, 0, Math.PI / 2), // chainring (axle along X)
      ],
      false,
    )!
    // rider: seated pose — hips on saddle, torso leaned to the bars, legs on pedals
    const riderGeo = mergeGeometries(
      [
        vBox(0.32, 0.18, 0.26, 0, 0.98, -0.24), // hips on the saddle
        vBox(0.34, 0.52, 0.24, 0, 1.24, -0.1, 0.28), // torso leaning forward
        vBox(0.09, 0.4, 0.09, -0.19, 1.2, 0.18, 0.75), // upper arms → bars
        vBox(0.09, 0.4, 0.09, 0.19, 1.2, 0.18, 0.75),
        vBox(0.12, 0.42, 0.13, -0.13, 0.76, -0.02, -0.85), // thighs
        vBox(0.12, 0.42, 0.13, 0.13, 0.74, -0.1, -0.6),
        vBox(0.09, 0.42, 0.09, -0.13, 0.46, 0.14, 0.45), // shins
        vBox(0.09, 0.42, 0.09, 0.13, 0.44, 0.06, 0.3),
        vBox(0.09, 0.07, 0.2, -0.14, 0.28, 0.24), // feet on pedals
        vBox(0.09, 0.07, 0.2, 0.14, 0.26, 0.16),
      ],
      false,
    )!
    const headGeo = new THREE.SphereGeometry(0.115, 8, 6)
    headGeo.translate(0, 1.56, 0.04)
    const helmetGeo = new THREE.SphereGeometry(0.14, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55)
    helmetGeo.translate(0, 1.58, 0.04)

    this.frameIM = new THREE.InstancedMesh(frameGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, metalness: 0.5 }), MAX_CYCLISTS)
    this.tireIM = new THREE.InstancedMesh(tireGeo, mats.tire, MAX_CYCLISTS)
    this.riderIM = new THREE.InstancedMesh(riderGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }), MAX_CYCLISTS)
    this.helmetIM = new THREE.InstancedMesh(helmetGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), MAX_CYCLISTS)
    for (const im of [this.frameIM, this.tireIM, this.riderIM, this.helmetIM]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      im.castShadow = im !== this.tireIM
      this.group.add(im)
    }

    /* ---- spawn ---- */
    for (let i = 0; i < MAX_CYCLISTS; i++) {
      const pathIdx = Math.floor(this.rng() * this.paths.length)
      const path = this.paths[pathIdx]
      this.riders.push({
        pathIdx,
        dist: this.rng() * (path.to - path.from),
        speed: 4.2 + this.rng() * 2.2,
        cur: 4.2 + this.rng() * 2.2,
        x: 0,
        z: 0,
        heading: 0,
        visible: true,
        phase: this.rng() * Math.PI * 2,
      })
      this.frameIM.setColorAt(i, new THREE.Color(FRAME_COLORS[i % FRAME_COLORS.length]))
      this.riderIM.setColorAt(i, new THREE.Color(CLOTHES[(i * 5 + 1) % CLOTHES.length]))
      this.helmetIM.setColorAt(i, new THREE.Color(['#e8e4d8', '#d84a3a', '#3f6d54', '#d8a832', '#26282a'][i % 5]))
    }
    this.flushColors()
  }

  private flushColors() {
    for (const im of [this.frameIM, this.riderIM, this.helmetIM]) {
      if (im?.instanceColor) im.instanceColor.needsUpdate = true
    }
  }

  update(dt: number, cameraPos: THREE.Vector3, nightFactor: number) {
    const frameIM = this.frameIM
    const tireIM = this.tireIM
    const riderIM = this.riderIM
    const helmetIM = this.helmetIM
    if (!frameIM || !tireIM || !riderIM || !helmetIM || this.riders.length === 0) return
    const dummy = new THREE.Object3D()
    dummy.rotation.order = 'YXZ'
    const nightOff = nightFactor > 0.6
    const t = performance.now() * 0.001

    this.streamTimer -= dt
    if (this.streamTimer <= 0) {
      this.streamTimer = 2.2
      this.stream(cameraPos)
    }

    for (let i = 0; i < this.riders.length; i++) {
      const r = this.riders[i]
      // night fade (fewer cyclists after dark)
      if (nightOff && r.visible && this.rng() < 0.004) r.visible = false
      if (!nightOff && !r.visible && this.rng() < 0.006) r.visible = true
      const sc = r.visible ? 1 : 0.0001

      const path = this.paths[r.pathIdx]
      // shared-street courtesy: slow (and stop) for pedestrians in the way
      let target = r.speed
      if (this.pedQuery) {
        const { count, data } = this.pedQuery()
        const dirX = path.axis === 'x' ? path.dir : 0
        const dirZ = path.axis === 'z' ? path.dir : 0
        for (let k = 0; k < count; k++) {
          const dx = data[k * 2] - r.x
          const dz = data[k * 2 + 1] - r.z
          const ahead = dx * dirX + dz * dirZ
          const lateral = Math.abs(dx * dirZ - dz * dirX)
          if (ahead > -0.6 && ahead < 7.0 && lateral < 2.3) {
            target = ahead < 2.2 ? 0 : Math.max(0.9, r.speed * (ahead / 7))
            break
          }
        }
      }
      r.cur += (target - r.cur) * Math.min(1, dt * 3)
      r.dist += r.cur * dt
      const len = path.to - path.from
      if (r.dist >= len) r.dist -= len
      const along = path.from + r.dist
      if (path.axis === 'x') {
        r.x = along
        r.z = path.coord
        r.heading = path.dir > 0 ? Math.PI / 2 : -Math.PI / 2
      } else {
        r.x = path.coord
        r.z = along
        r.heading = path.dir > 0 ? 0 : Math.PI
      }
      // gentle out-of-saddle sway + bob + slight forward pitch
      const sway = Math.sin(t * r.speed * 1.7 + r.phase) * 0.045
      const bob = Math.abs(Math.sin(t * r.speed * 1.7 + r.phase)) * 0.02

      dummy.position.set(r.x, bob, r.z)
      dummy.rotation.set(0, r.heading, sway)
      dummy.scale.setScalar(sc)
      dummy.updateMatrix()
      frameIM.setMatrixAt(i, dummy.matrix)
      tireIM.setMatrixAt(i, dummy.matrix)
      riderIM.setMatrixAt(i, dummy.matrix)
      helmetIM.setMatrixAt(i, dummy.matrix)
    }
    frameIM.instanceMatrix.needsUpdate = true
    tireIM.instanceMatrix.needsUpdate = true
    riderIM.instanceMatrix.needsUpdate = true
    helmetIM.instanceMatrix.needsUpdate = true
  }

  /* keep riders near the player */
  private streamTimer = 0

  private stream(cameraPos: THREE.Vector3) {
    const px = cameraPos.x
    const pz = cameraPos.z
    for (const r of this.riders) {
      const d2 = (r.x - px) ** 2 + (r.z - pz) ** 2
      if (d2 < 260 * 260) continue
      for (let tries = 0; tries < 14; tries++) {
        const pi = Math.floor(this.rng() * this.paths.length)
        const p = this.paths[pi]
        const mid = (p.from + p.to) / 2
        const mx = p.axis === 'x' ? mid : p.coord
        const mz = p.axis === 'x' ? p.coord : mid
        const d2s = (mx - px) ** 2 + (mz - pz) ** 2
        if (d2s > 70 * 70 && d2s < 210 * 210) {
          r.pathIdx = pi
          r.dist = this.rng() * (p.to - p.from)
          r.speed = 4.2 + this.rng() * 2.2
          r.cur = r.speed
          break
        }
      }
    }
  }
}
