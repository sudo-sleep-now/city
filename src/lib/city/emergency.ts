import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GRID_LINES, ROAD_WIDTH, SIDEWALK_WIDTH, lineClass } from './constants'
import { canvas, tex } from './materials'
import type { CityMaterials, CityPlan } from './types'
import { useCityStore } from './store'

/* ============================================================
 * EmergencySystem — random city events that actually HAPPEN:
 *   · structure fires  (smoke + flames + scorch, fire engine
 *     + ambulance respond with flashing beacons and a siren)
 *   · medical emergencies (ambulance run)
 * Vehicles route along the street grid (right-hand lane offsets),
 * park at the curb by the incident, stand by while the event
 * resolves, then drive back to Station 1 and despawn.
 * The siren is strictly EVENT-GATED (round-13 rule: nothing
 * always-on) — the level returned by update() is fed to the
 * AmbientAudio siren voice and follows the nearest vehicle.
 * ============================================================ */

interface EventSite {
  name: string
  /** street centerline coord + which axis the street runs along */
  line: number
  axis: 'x' | 'z'
  /** coordinate ALONG the street */
  along: number
  side: 1 | -1
}

interface Responder {
  group: THREE.Group
  beacons: { lamp: THREE.Mesh; on: THREE.MeshBasicMaterial; off: THREE.MeshBasicMaterial }[]
  wheels: THREE.Mesh[]
  route: THREE.Vector2[] // offset polyline (x, z)
  seg: number
  segT: number
  speed: number
  heading: number
  phase: 'respond' | 'scene' | 'return' | 'done'
  sceneSlot: number // parking offset along the curb (0 = lead vehicle)
  wheelSpin: number
}

type EventKind = 'fire' | 'medical'

const DEPOT = { x: 330, z: -2.4 } // westbound curb bay in front of FIRE STATION 1 (330,-27, block 9,5)
const ROAD_HALF: Record<string, number> = { arterial: 8, collector: 5.5, local: 3.5 }

export class EmergencySystem {
  group = new THREE.Group()
  private plan: CityPlan
  private mats: CityMaterials
  private rng = () => Math.random()
  private nextIn = 24 + Math.random() * 18
  private active: {
    kind: EventKind
    site: EventSite
    incident: { x: number; z: number }
    responders: Responder[]
    sceneTimer: number
    sceneTotal: number
    burn: number // fire: seconds left burning (0 for medical)
    controlled: boolean
    smoke?: { points: THREE.Points; pos: Float32Array; vel: Float32Array; life: Float32Array; maxLife: Float32Array }
    flames?: { points: THREE.Points; pos: Float32Array; life: Float32Array; maxLife: Float32Array }
    light?: THREE.PointLight
    scorch?: THREE.Mesh
    crowd?: THREE.Group
    crowdBase?: { m: THREE.Object3D; x: number; z: number; ph: number }[]
  } | null = null

  constructor(plan: CityPlan, mats: CityMaterials) {
    this.plan = plan
    this.mats = mats
  }

  /** manual trigger for QA / demos */
  trigger(kind?: EventKind) {
    if (this.active) return false
    this.begin(kind ?? (this.rng() < 0.55 ? 'fire' : 'medical'))
    return true
  }

  update(dt: number, playerPos: { x: number; z: number }): number {
    if (!this.active) {
      this.nextIn -= dt
      if (this.nextIn <= 0) this.begin(this.rng() < 0.55 ? 'fire' : 'medical')
      return 0
    }
    const ev = this.active
    let sirenLevel = 0

    const flashT = performance.now() / 1000
    for (const r of this.responders(ev)) {
      // beacon flash — red/blue alternating ~3 Hz while the unit is out
      if (r.phase !== 'done') {
        const alt = Math.floor(flashT * 3.2) % 2 === 0
        r.beacons.forEach((b, bi) => {
          const isRed = bi % 2 === 0
          b.lamp.material = alt ? (isRed ? b.on : b.off) : isRed ? b.off : b.on
        })
      }
      if (r.phase === 'respond' || r.phase === 'return') {
        this.drive(r, dt)
        const d = Math.hypot(r.group.position.x - playerPos.x, r.group.position.z - playerPos.z)
        sirenLevel = Math.max(sirenLevel, Math.pow(Math.max(0, 1 - d / 170), 1.5))
      }
    }

    // scene phase lifecycle
    ev.sceneTimer += dt
    if (ev.kind === 'fire') {
      const burnLeft = ev.burn
      if (burnLeft > 0) {
        ev.burn = Math.max(0, burnLeft - dt)
        if (ev.burn === 0) {
          ev.controlled = true
          this.toast('Fire under control — crews clearing up')
        }
      }
      this.updateFireVfx(dt, ev)
      if (ev.light) {
        const flick = ev.burn > 0 ? 9 + 3 * Math.sin(ev.sceneTimer * 23) + this.rng() * 2.5 : Math.max(0, 14 * (1 - ev.sceneTimer / 8))
        ev.light.intensity = flick
      }
    }

    // vehicles leave once the scene is resolved
    const sceneOver = ev.kind === 'fire' ? ev.burn <= 0 && ev.sceneTimer > 26 : ev.sceneTimer > 24
    if (sceneOver) {
      for (const r of ev.responders) {
        if (r.phase === 'scene') {
          r.phase = 'return'
          r.route = [...r.route].reverse()
          r.seg = 0
          r.segT = 0
        }
      }
    }
    // despawn vehicles once they are back at the depot
    for (const r of ev.responders) {
      if (r.phase === 'return' && r.seg >= r.route.length - 1) {
        r.phase = 'done'
        r.group.visible = false
      }
    }
    if (ev.responders.every((r) => r.phase === 'done')) {
      this.endEvent()
    }

    // smoke keeps decaying after the fire is out even as vehicles leave
    if (ev.controlled && ev.smoke) {
      const m = ev.smoke.points.material as THREE.PointsMaterial
      m.opacity = Math.max(0, m.opacity - dt * 0.02)
      if (m.opacity <= 0) ev.smoke.points.visible = false
    }
    if (ev.scorch) {
      const m = ev.scorch.material as THREE.MeshBasicMaterial
      m.opacity = Math.max(0, m.opacity - dt * (ev.controlled ? 0.02 : 0))
    }
    this.updateCrowd(dt)

    return sirenLevel
  }

  private responders(ev: NonNullable<EmergencySystem['active']>) {
    return ev.responders
  }

  /* ---------------- event lifecycle ---------------- */

  private begin(kind: EventKind) {
    const site = SITES[Math.floor(this.rng() * SITES.length)]
    const cls = lineClass(Math.abs(site.line))
    const hw = ROAD_HALF[cls]
    const incidentOff = site.side * (hw + Math.max(2.2, SIDEWALK_WIDTH[cls] - 1))
    const incident =
      site.axis === 'x' ? { x: site.along, z: site.line + incidentOff } : { x: site.line + incidentOff, z: site.along }
    this.active = {
      kind,
      site,
      incident,
      responders: [],
      sceneTimer: 0,
      sceneTotal: kind === 'fire' ? 62 + this.rng() * 26 : 24,
      // the burn must outlast the drive from Station 1 (~20-35 s) so the
      // crews always arrive to a still-burning scene
      burn: kind === 'fire' ? 42 + this.rng() * 20 : 0,
      controlled: false,
    }
    const kindList: ('engine' | 'ambulance')[] = kind === 'fire' ? ['engine', 'ambulance'] : ['ambulance']
    kindList.forEach((vk, i) => {
      const r = this.makeResponder(vk, site, hw, i * 6.5)
      this.group.add(r.group)
      this.active!.responders.push(r)
      if (i > 0) {
        // staggering: the ambulance rolls out a beat behind the engine
        r.group.visible = false
        setTimeout(() => {
          r.group.visible = true
        }, 2200 * i)
      }
    })
    if (kind === 'fire') this.setupFireVfx(incident)
    this.setupCrowd(incident, site)
    this.toast(kind === 'fire' ? `Structure fire reported at ${site.name} — Station 1 responding` : `Medical emergency at ${site.name} — ambulance dispatched`)
  }

  private endEvent() {
    const ev = this.active
    if (!ev) return
    for (const r of ev.responders) {
      this.group.remove(r.group)
      r.group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
      })
    }
    if (ev.smoke) {
      this.group.remove(ev.smoke.points)
      ev.smoke.points.geometry.dispose()
      ;(ev.smoke.points.material as THREE.Material).dispose()
    }
    if (ev.flames) {
      this.group.remove(ev.flames.points)
      ev.flames.points.geometry.dispose()
      ;(ev.flames.points.material as THREE.Material).dispose()
    }
    if (ev.light) this.group.remove(ev.light)
    if (ev.scorch) {
      this.group.remove(ev.scorch)
      ev.scorch.geometry.dispose()
    }
    if (ev.crowd) {
      this.group.remove(ev.crowd)
      ev.crowd.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
      })
    }
    this.active = null
    this.nextIn = 95 + this.rng() * 115
    this.toast('Scene cleared — units returning to Station 1')
  }

  private toast(msg: string) {
    const s = useCityStore.getState()
    if (s.started) s.showToast(msg)
  }

  /* ---------------- routing ---------------- */

  /**
   * Manhattan route from Station 1 (on the z=0 arterial) to a curb parking
   * spot. Legs run on street centerlines shifted onto the RIGHT-HAND lane
   * (offset = direction × 2.4 m); the final segment is a short diagonal
   * "pull-in" from the traffic lane to the curb. All sites sit west of the
   * depot so leg 1 is always the legal westbound lane (z=-2.4).
   */
  private buildRoute(park: { x: number; z: number }, site: EventSite): THREE.Vector2[] {
    const O = 2.4
    const pts: THREE.Vector2[] = []
    const push = (x: number, z: number) => {
      const p = new THREE.Vector2(x, z)
      const last = pts[pts.length - 1]
      if (!last || last.distanceTo(p) > 1.5) pts.push(p)
    }
    const nearest = (v: number) => GRID_LINES.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
    if (site.axis === 'x' && Math.abs(site.line) < 1) {
      // incident is ON the depot's own arterial — just drive west and pull in
      push(DEPOT.x, DEPOT.z)
      push(park.x, DEPOT.z)
    } else if (site.axis === 'x') {
      // cross-street turn at the grid line nearest the park x, then the site road
      const nx = nearest(park.x)
      const dz = Math.sign(site.line) || -1
      const c2 = nx - dz * O // right-hand lane of the z-axis cross street
      const dx = Math.sign(park.x - nx) || 1
      const c3 = site.line + dx * O // right-hand lane of the x-axis site road
      push(DEPOT.x, DEPOT.z)
      push(c2, DEPOT.z)
      push(c2, c3)
      push(park.x, c3)
    } else {
      // turn off the arterial straight onto the z-axis site road
      const dz = Math.sign(park.z) || -1
      const c2 = site.line - dz * O
      push(DEPOT.x, DEPOT.z)
      push(c2, DEPOT.z)
      push(c2, park.z)
    }
    push(park.x, park.z) // curb pull-in
    return pts
  }

  private drive(r: Responder, dt: number) {
    if (r.seg >= r.route.length - 1) return
    const a = r.route[r.seg]
    const b = r.route[r.seg + 1]
    const len = a.distanceTo(b)
    // slow into corners
    let target = r.speed
    if (r.seg + 1 < r.route.length - 1 && len - r.segT < 10) target = 4.6
    r.segT += target * dt
    if (r.segT >= len) {
      r.segT -= len
      r.seg++
      if (r.seg >= r.route.length - 1) {
        r.seg = r.route.length - 1
        r.group.position.set(b.x, 0, b.y)
        if (r.phase === 'respond') r.phase = 'scene'
        return
      }
      return
    }
    const t = r.segT / Math.max(0.001, len)
    const x = a.x + (b.x - a.x) * t
    const z = a.y + (b.y - a.y) * t
    r.group.position.set(x, 0, z)
    const dir = Math.atan2(b.x - a.x, b.y - a.y)
    // ease heading
    let dh = dir - r.heading
    while (dh > Math.PI) dh -= Math.PI * 2
    while (dh < -Math.PI) dh += Math.PI * 2
    r.heading += dh * Math.min(1, dt * 7)
    r.group.rotation.y = r.heading
    r.wheelSpin += target * dt * 2.2
    for (const w of r.wheels) w.rotation.x = r.wheelSpin
  }

  /* ---------------- vehicles ---------------- */

  private makeResponder(kind: 'engine' | 'ambulance', site: EventSite, hw: number, slot: number): Responder {
    const g = new THREE.Group()
    const mats = this.mats
    const isEngine = kind === 'engine'
    const W = isEngine ? 2.45 : 2.25
    const L = isEngine ? 7.2 : 5.5
    const bodyMat = isEngine ? new THREE.MeshStandardMaterial({ color: '#b3352c', roughness: 0.45, metalness: 0.2 }) : new THREE.MeshStandardMaterial({ color: '#e9e6df', roughness: 0.5, metalness: 0.1 })
    const stripeMat = isEngine ? new THREE.MeshStandardMaterial({ color: '#efe9dc', roughness: 0.5 }) : new THREE.MeshStandardMaterial({ color: '#e0703a', roughness: 0.55 })
    const bodyH = isEngine ? 2.35 : 2.2
    const bodyY = isEngine ? 1.5 : 1.45
    // main box
    const box = new THREE.Mesh(new THREE.BoxGeometry(W, bodyH, L), bodyMat)
    box.position.y = bodyY
    box.castShadow = true
    g.add(box)
    // cab (front third, slightly lower) + stripe band
    const cab = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, bodyH * 0.55, L * 0.28), stripeMat)
    cab.position.set(0, bodyY + bodyH * 0.28, L * 0.34)
    g.add(cab)
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.42, L * 0.96), stripeMat)
    stripe.position.y = bodyY - bodyH * 0.18
    g.add(stripe)
    // windshield
    const glass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.7, 0.06), mats.glassDark)
    glass.position.set(0, bodyY + bodyH * 0.22, L / 2 + 0.01)
    g.add(glass)
    // ladder rack (engine only)
    if (isEngine) {
      const railG: THREE.BufferGeometry[] = []
      for (const sx of [-1, 1]) {
        const rail = new THREE.BoxGeometry(0.09, 0.12, L * 0.62)
        rail.translate(sx * (W / 2 - 0.22), bodyY + bodyH / 2 + 0.22, -L * 0.05)
        railG.push(rail)
      }
      for (let i = 0; i < 6; i++) {
        const rung = new THREE.BoxGeometry(W - 0.5, 0.06, 0.09)
        rung.translate(0, bodyY + bodyH / 2 + 0.22, -L * 0.32 + (i * L * 0.55) / 5)
        railG.push(rung)
      }
      const ladder = new THREE.Mesh(mergeGeometries(railG, false)!, mats.metal)
      ladder.castShadow = true
      g.add(ladder)
    }
    // beacon bar (red + blue lamps, flashed in update via material swap)
    const beacons: Responder['beacons'] = []
    const lampY = bodyY + bodyH / 2 + (isEngine ? 0.42 : 0.24)
    const mkLamp = (x: number, color: string) => {
      const on = new THREE.MeshBasicMaterial({ color, toneMapped: false })
      const off = new THREE.MeshBasicMaterial({ color: '#3a3f45', toneMapped: false })
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.3), off)
      lamp.position.set(x, lampY, isEngine ? L * 0.2 : 0)
      g.add(lamp)
      beacons.push({ lamp, on, off })
    }
    if (isEngine) {
      mkLamp(-0.5, '#ff2418')
      mkLamp(0, '#245bff')
      mkLamp(0.5, '#ff2418')
    } else {
      mkLamp(-0.42, '#245bff')
      mkLamp(0.42, '#ff7a18')
    }
    // wheels
    const wheels: THREE.Mesh[] = []
    const tireG = new THREE.CylinderGeometry(0.44, 0.44, 0.26, 12)
    tireG.rotateZ(Math.PI / 2)
    const hubG = new THREE.CylinderGeometry(0.22, 0.22, 0.28, 8)
    hubG.rotateZ(Math.PI / 2)
    const wheelMeshG = mergeGeometries([tireG, hubG], true)!
    const wheelMat = [mats.tire, mats.metal]
    const wz = isEngine ? [-L * 0.31, L * 0.28] : [-L * 0.3, L * 0.3]
    for (const z of wz) {
      for (const sx of [-1, 1]) {
        const w = new THREE.Mesh(wheelMeshG, wheelMat)
        w.position.set(sx * (W / 2 - 0.06), 0.44, z)
        g.add(w)
        wheels.push(w)
      }
    }
    // headlights
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.06), mats.headlight)
      lamp.position.set(sx * W * 0.3, 0.78, L / 2 + 0.01)
      g.add(lamp)
    }

    // parking spot at the curb, slot-offset further along the street
    const curbOff = site.side * (hw + 1.3)
    const park =
      site.axis === 'x' ? { x: site.along + slot, z: site.line + curbOff } : { x: site.line + curbOff, z: site.along + slot }
    const route = this.buildRoute(park, site)
    const start = route[0]
    g.position.set(start.x, 0, start.y)
    const dir0 = Math.atan2(route[1].x - route[0].x, route[1].y - route[0].y)
    g.rotation.y = dir0
    return {
      group: g,
      beacons,
      wheels,
      route,
      seg: 0,
      segT: 0,
      speed: isEngine ? 11.5 : 12.5,
      heading: dir0,
      phase: 'respond',
      sceneSlot: slot,
      wheelSpin: 0,
    }
  }

  /* ---------------- fire vfx ---------------- */

  private softSprite(): THREE.CanvasTexture {
    const [c, ctx] = canvas(64, 64)
    const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.55, 'rgba(255,255,255,0.55)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 64, 64)
    return tex(c, false)
  }

  private setupFireVfx(at: { x: number; z: number }) {
    const N = 42
    const pos = new Float32Array(N * 3)
    const vel = new Float32Array(N * 3)
    const life = new Float32Array(N)
    const maxLife = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      maxLife[i] = 2.2 + this.rng() * 1.6
      life[i] = this.rng() * maxLife[i]
      pos[i * 3] = at.x + (this.rng() - 0.5) * 2.4
      pos[i * 3 + 1] = this.rng() * 2
      pos[i * 3 + 2] = at.z + (this.rng() - 0.5) * 2.4
      vel[i * 3] = (this.rng() - 0.5) * 0.5
      vel[i * 3 + 1] = 3.2 + this.rng() * 2.4
      vel[i * 3 + 2] = (this.rng() - 0.5) * 0.5
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: this.softSprite(),
        color: '#787880',
        size: 5.2,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    )
    points.frustumCulled = false
    this.group.add(points)

    const FN = 18
    const fpos = new Float32Array(FN * 3)
    const flife = new Float32Array(FN)
    const fmax = new Float32Array(FN)
    for (let i = 0; i < FN; i++) {
      fmax[i] = 0.4 + this.rng() * 0.45
      flife[i] = this.rng() * fmax[i]
    }
    const fgeo = new THREE.BufferGeometry()
    fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3))
    const flames = new THREE.Points(
      fgeo,
      new THREE.PointsMaterial({
        map: this.softSprite(),
        color: '#ff7a2a',
        size: 2.1,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    )
    flames.frustumCulled = false
    this.group.add(flames)

    const light = new THREE.PointLight('#ff8a3a', 0, 40, 1.8)
    light.position.set(at.x, 3.2, at.z)
    this.group.add(light)

    // scorch decal on the sidewalk slab
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 18),
      new THREE.MeshBasicMaterial({ color: '#181410', transparent: true, opacity: 0.75, depthWrite: false }),
    )
    scorch.rotation.x = -Math.PI / 2
    scorch.position.set(at.x, 0.152, at.z)
    this.group.add(scorch)

    const ev = this.active!
    ev.smoke = { points, pos, vel, life, maxLife }
    ev.flames = { points: flames, pos: fpos, life: flife, maxLife: fmax }
    ev.light = light
    ev.scorch = scorch
  }

  private updateFireVfx(dt: number, ev: NonNullable<EmergencySystem['active']>) {
    const burning = ev.burn > 0
    if (ev.smoke) {
      const { points, pos, vel, life, maxLife } = ev.smoke
      const a = points.geometry.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < maxLife.length; i++) {
        life[i] += dt
        if (life[i] > maxLife[i]) {
          life[i] = 0
          pos[i * 3] = ev.incident.x + (this.rng() - 0.5) * (burning ? 2.4 : 3.4)
          pos[i * 3 + 1] = burning ? this.rng() * 1.6 : 0.4 + this.rng() * 0.6
          pos[i * 3 + 2] = ev.incident.z + (this.rng() - 0.5) * (burning ? 2.4 : 3.4)
          vel[i * 3] = (this.rng() - 0.5) * 0.5
          vel[i * 3 + 1] = burning ? 3.2 + this.rng() * 2.4 : 1.1 + this.rng() * 0.8
          vel[i * 3 + 2] = (this.rng() - 0.5) * 0.5
        }
        pos[i * 3] += (vel[i * 3] + 0.35) * dt // slight wind drift +x
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt
      }
      a.needsUpdate = true
      points.visible = true
    }
    if (ev.flames) {
      const f = ev.flames
      const a = f.points.geometry.attributes.position as THREE.BufferAttribute
      ;(f.points.material as THREE.PointsMaterial).opacity = burning ? 0.85 : Math.max(0, (f.points.material as THREE.PointsMaterial).opacity - dt)
      f.points.visible = burning || (f.points.material as THREE.PointsMaterial).opacity > 0.02
      if (f.points.visible) {
        for (let i = 0; i < f.maxLife.length; i++) {
          f.life[i] += dt
          if (f.life[i] > f.maxLife[i]) {
            f.life[i] = 0
            a.setXYZ(i, ev.incident.x + (this.rng() - 0.5) * 2, 0.2 + this.rng() * 1.6, ev.incident.z + (this.rng() - 0.5) * 2)
          } else {
            a.setY(i, a.getY(i) + dt * 2.6)
          }
        }
        a.needsUpdate = true
      }
    }
    if (ev.light) ev.light.visible = burning || ev.light.intensity > 0.1
  }

  /* ---------------- onlookers ---------------- */

  private setupCrowd(at: { x: number; z: number }, site: EventSite) {
    const crowd = new THREE.Group()
    const base: { m: THREE.Object3D; x: number; z: number; ph: number }[] = []
    const palette = ['#8a4f3d', '#5c6b52', '#6b5e86', '#9a7b4f', '#4f6d78', '#7d5a68']
    const cls = lineClass(Math.abs(site.line))
    const sidewalkOff = site.side * (ROAD_HALF[cls] + SIDEWALK_WIDTH[cls] * 0.45)
    const n = 4 + Math.floor(this.rng() * 3)
    for (let i = 0; i < n; i++) {
      const along = site.along + (i - (n - 1) / 2) * 2.6 + (this.rng() - 0.5) * 1.2
      const px = site.axis === 'x' ? along : site.line + sidewalkOff
      const pz = site.axis === 'x' ? site.line + sidewalkOff : along
      const bodyMat = new THREE.MeshStandardMaterial({ color: palette[i % palette.length], roughness: 1 })
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 1.02, 7), bodyMat)
      body.position.y = 0.72
      body.castShadow = true
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshStandardMaterial({ color: '#c9a184', roughness: 0.9 }))
      head.position.y = 1.42
      const fig = new THREE.Group()
      fig.add(body, head)
      fig.position.set(px, 0.14, pz)
      fig.lookAt(at.x, 0.14, at.z)
      crowd.add(fig)
      base.push({ m: fig, x: px, z: pz, ph: this.rng() * 6.28 })
    }
    this.group.add(crowd)
    const ev = this.active!
    ev.crowd = crowd
    ev.crowdBase = base
  }

  private updateCrowd(dt: number) {
    const ev = this.active
    if (!ev || !ev.crowd || !ev.crowdBase) return
    const t = performance.now() / 1000
    for (const b of ev.crowdBase) {
      b.m.position.y = 0.14 + Math.sin(t * 2 + b.ph) * 0.015
    }
  }
}

/* incident sites — every point is derived from a street centerline so it
 * ALWAYS lands on public right-of-way (sidewalk edge / curb), never inside
 * a building lot. */
const SITES: EventSite[] = [
  { name: 'City Hospital', line: 0, axis: 'x', along: 250, side: -1 },
  { name: 'the Market café row', line: 0, axis: 'x', along: 78, side: -1 },
  { name: 'the Skylink podium', line: -100, axis: 'x', along: 150, side: 1 },
  { name: 'Eastgate row homes', line: 200, axis: 'z', along: 250, side: 1 },
  { name: 'a Westbrook corner shop', line: -400, axis: 'z', along: -150, side: 1 },
  { name: 'the Northgate market gardens', line: -200, axis: 'z', along: -350, side: -1 },
]
