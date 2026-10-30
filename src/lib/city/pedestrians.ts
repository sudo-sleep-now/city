import * as THREE from 'three'
import { MAX_PEDESTRIANS } from './constants'
import type { CityMaterials, CityPlan, RoadNetworkData, SidewalkSeg } from './types'

/* ============================================================
 * PedestrianSystem — low-poly instanced pedestrians living on the
 * sidewalk graph: walking, crossing at crosswalks (obeying signals
 * AND yielding to cars), idling in parks, SITTING on benches,
 * WAITING at bus shelters and BOARDING / ALIGHTING buses through
 * their open doors.
 * ============================================================ */

const CLOTHES = ['#8a6a4f', '#5b7461', '#7a5a68', '#96865c', '#4a5a50', '#a0522d', '#c94f3d', '#3f4a42']
const SKINS = ['#d9b08c', '#c49a6c', '#b98a68', '#8a5a3c']

/** a bus dwelling with its doors open (from TrafficSystem.getBoardingBuses) */
export interface BoardingBus {
  x: number
  z: number
  doorX: number
  doorZ: number
  stopId: string
}

type PedRole = 'walker' | 'park' | 'shopper' | 'stopper'
type Arrive = 'sit' | 'attach' | 'board' | 'shelter'

interface PedState {
  segId: string
  dist: number
  speed: number
  state:
    | 'walk'
    | 'wait'
    | 'cross'
    | 'idle'
    | 'toPoint'
    | 'sit'
    | 'waitBus'
    | 'board'
    | 'hidden'
    | 'alight'
  timer: number
  x: number
  z: number
  heading: number
  phase: number
  role: PedRole
  parkTarget: { x: number; z: number } | null
  crossFrom: { x: number; z: number } | null
  crossTo: { x: number; z: number } | null
  crossT: number
  crossLen: number
  visible: boolean
  /** crosswalk the ped intends to take while waiting at the curb */
  pendingCw: { x: number; z: number; otherId: string; axis: 'x' | 'z'; signalId?: string } | null
  /** seconds spent waiting for this crossing (jaywalk escape after 26 s) */
  waitTotal: number
  /** carries an umbrella (revealed when it rains) */
  hasUmbrella: boolean
  /** eased 0..1 umbrella raise */
  umbT: number
  /** fade 0..1 (boards fade out, alighting peds fade in) */
  alpha: number
  /** direct-walk destination (benches, shelters, bus doors, seg re-entry) */
  target: { x: number; z: number } | null
  /** what happens when `target` is reached */
  arrive: Arrive | null
  /** seconds spent walking toward `target` (give-up timeout) */
  travelT: number
  /** occupied bench index (benchSpots) or -1 */
  benchIdx: number
  /** bus stop this ped waits at / boarded at */
  stopId: string | null
  /** facing direction of the stop / bench spot */
  spotRy: number
}

export class PedestrianSystem {
  group = new THREE.Group()
  carQuery: (() => { count: number; data: Float32Array }) | null = null
  /** green axis of a signal ('x'|'z') or null (all-red / unknown) */
  signalQuery: ((signalId: string) => 'x' | 'z' | null) | null = null
  /** buses currently dwelling with doors open (set by the engine) */
  boardQuery: (() => BoardingBus[]) | null = null
  private peds: PedState[] = []
  private bodyIM: THREE.InstancedMesh | null = null
  private headIM: THREE.InstancedMesh | null = null
  private legIM: THREE.InstancedMesh | null = null
  private umbCanopyIM: THREE.InstancedMesh | null = null
  private umbPoleIM: THREE.InstancedMesh | null = null
  private plan: CityPlan
  private network: RoadNetworkData
  private benchSpots: { x: number; z: number; ry: number }[]
  private stopSpots: { stopId: string; x: number; z: number; ry: number }[]
  private benchUsed = new Set<number>()
  private stopUsed = new Map<string, number>()
  private frame = 0
  private lastNight = 0
  private rng = (() => {
    let s = 5150
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
  })()

  constructor(
    plan: CityPlan,
    network: RoadNetworkData,
    mats: CityMaterials,
    benchSpots: { x: number; z: number; ry: number }[] = [],
    stopSpots: { stopId: string; x: number; z: number; ry: number }[] = [],
  ) {
    this.plan = plan
    this.network = network
    this.benchSpots = benchSpots
    this.stopSpots = stopSpots
    const bodyGeo = new THREE.CapsuleGeometry(0.21, 0.62, 3, 8)
    bodyGeo.translate(0, 1.02, 0)
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 })
    this.bodyIM = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_PEDESTRIANS)
    const headGeo = new THREE.SphereGeometry(0.14, 8, 6)
    headGeo.translate(0, 1.6, 0)
    const headMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 })
    this.headIM = new THREE.InstancedMesh(headGeo, headMat, MAX_PEDESTRIANS)
    const legGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.72, 5)
    legGeo.translate(0, -0.36, 0)
    this.legIM = new THREE.InstancedMesh(legGeo, new THREE.MeshStandardMaterial({ color: '#3a3a3c', roughness: 0.95 }), MAX_PEDESTRIANS * 2)
    // umbrellas — opened over ~70% of the peds while it rains
    const canopyGeo = new THREE.ConeGeometry(0.52, 0.22, 8, 1, true)
    canopyGeo.translate(0, 2.02, 0)
    const canopyMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, side: THREE.DoubleSide })
    this.umbCanopyIM = new THREE.InstancedMesh(canopyGeo, canopyMat, MAX_PEDESTRIANS)
    const poleGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.9, 5)
    poleGeo.translate(0, 1.42, 0)
    this.umbPoleIM = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: '#2a2a2c', roughness: 0.7 }), MAX_PEDESTRIANS)
    for (const im of [this.bodyIM, this.headIM, this.legIM, this.umbCanopyIM, this.umbPoleIM]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
    }
    this.group.add(this.bodyIM!, this.headIM!, this.legIM!, this.umbCanopyIM!, this.umbPoleIM!)

    // spawn
    const segIds = [...network.sidewalks.keys()]
    for (let i = 0; i < MAX_PEDESTRIANS; i++) {
      if (segIds.length === 0) break
      // weight: downtown-ish segs
      let segId = segIds[Math.floor(this.rng() * segIds.length)]
      const seg = network.sidewalks.get(segId)!
      const r = this.rng()
      let role: PedRole = 'walker'
      if (r < 0.16) role = 'park'
      else if (r < 0.3) role = 'shopper'
      else if (r < 0.4) role = 'stopper'
      this.peds.push({
        segId,
        dist: this.rng() * 40,
        speed: 1.05 + this.rng() * 0.5,
        state: 'walk',
        timer: 0,
        x: seg.x1,
        z: seg.z1,
        heading: 0,
        phase: this.rng() * Math.PI * 2,
        role,
        parkTarget: null,
        crossFrom: null,
        crossTo: null,
        crossT: 0,
        crossLen: 1,
        visible: true,
        pendingCw: null,
        waitTotal: 0,
        hasUmbrella: this.rng() < 0.72,
        umbT: 0,
        alpha: 1,
        target: null,
        arrive: null,
        travelT: 0,
        benchIdx: -1,
        stopId: null,
        spotRy: 0,
      })
    }
  }

  /** flat x/z positions of every ped (consumed by the cyclists' yield check) */
  getPedPositions(): { count: number; data: Float32Array } {
    const data = new Float32Array(this.peds.length * 2)
    this.peds.forEach((p, i) => {
      data[i * 2] = p.x
      data[i * 2 + 1] = p.z
    })
    return { count: this.peds.length, data }
  }

  /** is it safe to cross this crosswalk right now? (signal + car gap) */
  private crossingSafe(cw: { x: number; z: number; axis: 'x' | 'z'; signalId?: string }, ignoreSignal: boolean): boolean {
    // signal check: the road being crossed runs PERPENDICULAR to cw.axis —
    // the ped may cross when that road's traffic does NOT have green
    if (!ignoreSignal && cw.signalId && this.signalQuery) {
      const green = this.signalQuery(cw.signalId)
      const crossedRoadAxis = cw.axis === 'x' ? 'z' : 'x'
      if (green === crossedRoadAxis) return false // traffic on the crossed road is flowing — wait
    }
    // car gap check (turning vehicles run their red too)
    if (this.carQuery) {
      const { count, data } = this.carQuery()
      for (let i = 0; i < count; i++) {
        const dx = data[i * 2] - cw.x
        const dz = data[i * 2 + 1] - cw.z
        if (dx * dx + dz * dz < 13 * 13) return false
      }
    }
    return true
  }

  private pickNext(ped: PedState, seg: SidewalkSeg) {
    const nexts = seg.next
    if (nexts.length === 0) {
      // teleport to a random seg
      const ids = [...this.network.sidewalks.keys()]
      ped.segId = ids[Math.floor(this.rng() * ids.length)]
      ped.dist = 0
      return
    }
    const runsX = Math.abs(seg.z1 - seg.z2) < 0.5
    const farX = seg.x2
    const farZ = seg.z2

    /* ---- 1. flank crosswalk: cross the road running ALONG this sidewalk ---- */
    const cw = this.network.crosswalks.find(
      (c) => (c.a === seg.id || c.b === seg.id) && Math.hypot(c.x - farX, c.z - farZ) < 20,
    )
    if (cw && this.rng() < 0.78) {
      const otherId = cw.a === seg.id ? cw.b : cw.a
      const other = this.network.sidewalks.get(otherId)
      if (other) {
        if (!this.crossingSafe(cw, false)) {
          // wait at the curb, facing the crossing, re-checking periodically
          if (!ped.pendingCw || ped.pendingCw.x !== cw.x || ped.pendingCw.z !== cw.z) ped.waitTotal = 0
          ped.state = 'wait'
          ped.timer = 0.5 + this.rng() * 0.5
          ped.pendingCw = { x: cw.x, z: cw.z, otherId, axis: cw.axis, signalId: cw.signalId }
          ped.heading = Math.atan2(cw.x - ped.x, cw.z - ped.z)
          return
        }
        // cross — land DIRECTLY across from the ped's position on the other
        // flank piece (never walk a diagonal to the piece start)
        const otherLat = cw.axis === 'x' ? other.x1 : other.z1
        ped.state = 'cross'
        ped.crossFrom = { x: ped.x, z: ped.z }
        ped.crossTo = cw.axis === 'x' ? { x: otherLat, z: ped.z } : { x: ped.x, z: otherLat }
        ped.crossLen = Math.hypot(ped.crossTo.x - ped.x, ped.crossTo.z - ped.z) || 1
        ped.crossT = 0
        ped.segId = otherId
        ped.dist = cw.axis === 'x' ? Math.abs(ped.z - other.z1) : Math.abs(ped.x - other.x1)
        ped.waitTotal = 0
        return
      }
    }

    /* ---- 2. junction crosswalk: the ped is about to walk ACROSS the
     * crossing roadway to the abutting piece (straight through the junction,
     * on the zebra). Gate it on the pedestrian signal too. ---- */
    const jcw = this.network.crosswalks.find((c) => {
      const cwRunsX = c.axis === 'x' // ped walks along x on this crossing
      if (cwRunsX !== runsX) return false
      return Math.hypot(c.x - farX, c.z - farZ) < 9
    })
    if (jcw && !this.crossingSafe(jcw, false)) {
      if (!ped.pendingCw || ped.pendingCw.x !== jcw.x || ped.pendingCw.z !== jcw.z) ped.waitTotal = 0
      ped.state = 'wait'
      ped.timer = 0.5 + this.rng() * 0.5
      ped.pendingCw = { x: jcw.x, z: jcw.z, otherId: '', axis: jcw.axis, signalId: jcw.signalId }
      return
    }

    // straight bias
    let nid: string
    if (this.rng() < 0.7) {
      const straight = nexts.find((n) => {
        const ns = this.network.sidewalks.get(n)
        if (!ns) return false
        const dot = (ns.x2 - ns.x1) * (seg.x2 - seg.x1) + (ns.z2 - ns.z1) * (seg.z2 - seg.z1)
        return dot > 0
      })
      nid = straight ?? nexts[Math.floor(this.rng() * nexts.length)]
    } else {
      nid = nexts[Math.floor(this.rng() * nexts.length)]
    }
    ped.segId = nid
    ped.dist = 0
    ped.waitTotal = 0
  }

  private parkPoint(): { x: number; z: number } {
    const parks = this.plan.parks.filter((p) => p.kind === 'central-park' || p.kind === 'pocket-park' || p.kind === 'plaza')
    const p = parks[Math.floor(this.rng() * parks.length)] ?? this.plan.parks[0]
    return { x: p.x0 + 10 + this.rng() * (p.x1 - p.x0 - 20), z: p.z0 + 10 + this.rng() * (p.z1 - p.z0 - 20) }
  }

  /* ---------------- micro-life helpers ---------------- */

  /** nearest free bench within `maxD`, or -1 */
  private findBench(x: number, z: number, maxD: number): number {
    let best = -1
    let bestD = maxD
    for (let i = 0; i < this.benchSpots.length; i++) {
      if (this.benchUsed.has(i)) continue
      const b = this.benchSpots[i]
      const d = Math.hypot(b.x - x, b.z - z)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /** nearest stop spot with free capacity within `maxD` */
  private findStop(x: number, z: number, maxD: number): { stopId: string; x: number; z: number; ry: number } | null {
    let best: { stopId: string; x: number; z: number; ry: number } | null = null
    let bestD = maxD
    for (const s of this.stopSpots) {
      const used = this.stopUsed.get(s.stopId) ?? 0
      if (used >= 3) continue
      const d = Math.hypot(s.x - x, s.z - z)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    return best
  }

  /** begin a direct walk toward a point (off-graph, like park wandering) */
  private goTo(ped: PedState, x: number, z: number, arrive: Arrive) {
    ped.state = 'toPoint'
    ped.target = { x, z }
    ped.arrive = arrive
    ped.travelT = 0
  }

  /** project a point onto the nearest sidewalk seg and re-attach the ped */
  private attachNearest(ped: PedState, x: number, z: number) {
    let bestId = ''
    let bestD = Infinity
    let bx = x
    let bz = z
    for (const [id, seg] of this.network.sidewalks) {
      const len2 = (seg.x2 - seg.x1) ** 2 + (seg.z2 - seg.z1) ** 2
      const t = Math.max(0, Math.min(1, ((x - seg.x1) * (seg.x2 - seg.x1) + (z - seg.z1) * (seg.z2 - seg.z1)) / (len2 || 1)))
      const px = seg.x1 + (seg.x2 - seg.x1) * t
      const pz = seg.z1 + (seg.z2 - seg.z1) * t
      const d = Math.hypot(px - x, pz - z)
      if (d < bestD) {
        bestD = d
        bestId = id
        bx = px
        bz = pz
      }
    }
    if (bestId) {
      const seg = this.network.sidewalks.get(bestId)!
      const len = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1) || 1
      ped.segId = bestId
      ped.dist = Math.hypot(bx - seg.x1, bz - seg.z1) > len - 0.4 ? Math.max(0, len - 0.4) : Math.hypot(bx - seg.x1, bz - seg.z1)
      ped.x = bx
      ped.z = bz
      ped.state = 'walk'
    } else {
      // graph gone — let the streamer relocate us
      const ids = [...this.network.sidewalks.keys()]
      ped.segId = ids[Math.floor(this.rng() * ids.length)] ?? ped.segId
      ped.dist = 0
      ped.state = 'walk'
    }
  }

  /** respawn a ped as a walker on a seg 60–170 m from the camera (off-screen) */
  private respawnFar(ped: PedState, cameraPos: THREE.Vector3) {
    const ids = [...this.network.sidewalks.keys()]
    for (let tries = 0; tries < 16; tries++) {
      const seg = this.network.sidewalks.get(ids[Math.floor(this.rng() * ids.length)])
      if (!seg) continue
      const mx = (seg.x1 + seg.x2) / 2
      const mz = (seg.z1 + seg.z2) / 2
      const d2 = (mx - cameraPos.x) ** 2 + (mz - cameraPos.z) ** 2
      if (d2 > 60 * 60 && d2 < 170 * 170) {
        ped.segId = seg.id
        ped.dist = this.rng() * 20
        break
      }
    }
    ped.alpha = 1
    ped.visible = true
    ped.target = null
    ped.arrive = null
    ped.benchIdx = -1
    ped.stopId = null
    ped.state = 'walk'
    ped.dist = Math.min(ped.dist, 20)
  }

  update(dt: number, cameraPos: THREE.Vector3, nightFactor: number, rain = 0) {
    this.frame++
    this.lastNight = nightFactor
    const dummy = new THREE.Object3D()
    // YXZ order: yaw (Y) applied first, then swing (X) in the pedestrian's
    // local frame → legs swing FORWARD/BACK, never side-to-side
    dummy.rotation.order = 'YXZ'
    const lodSkip = this.frame % 30 // far peds update every 30 frames
    const nightOff = nightFactor > 0.6
    const buses = this.boardQuery ? this.boardQuery() : []

    this.streamTimer -= dt
    if (this.streamTimer <= 0) {
      this.streamTimer = 2.0
      this.stream(cameraPos)
    }

    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i]
      const far = (ped.x - cameraPos.x) ** 2 + (ped.z - cameraPos.z) ** 2 > 130 * 130
      if (far && this.frame % 30 !== i % 30) {
        // skip matrix write this frame for far peds (staggered)
        if (lodSkip !== i % 30) continue
      }

      // night fade
      if (nightOff && ped.visible && this.rng() < 0.002) ped.visible = false
      if (!nightOff && !ped.visible && this.rng() < 0.004) ped.visible = true

      if (ped.state === 'cross') {
        ped.crossT += (ped.speed * dt) / ped.crossLen
        if (ped.crossT >= 1) {
          ped.state = 'walk'
          ped.dist = 0
        } else {
          ped.x = ped.crossFrom!.x + (ped.crossTo!.x - ped.crossFrom!.x) * ped.crossT
          ped.z = ped.crossFrom!.z + (ped.crossTo!.z - ped.crossFrom!.z) * ped.crossT
          ped.heading = Math.atan2(ped.crossTo!.x - ped.crossFrom!.x, ped.crossTo!.z - ped.crossFrom!.z)
        }
      } else if (ped.state === 'wait') {
        // wait at the curb until the signal AND the road are safe
        ped.timer -= dt
        ped.waitTotal += dt
        if (ped.timer <= 0 && ped.pendingCw) {
          const jay = ped.waitTotal > 26 // bored of waiting — cross against the light if gap
          if (this.crossingSafe(ped.pendingCw, jay)) {
            if (!ped.pendingCw.otherId) {
              // junction crossing: safe → walk straight through on the zebra
              ped.state = 'walk'
              ped.pendingCw = null
              ped.waitTotal = 0
            } else {
              const other = this.network.sidewalks.get(ped.pendingCw.otherId)
              if (other) {
                const pAxis = ped.pendingCw.axis
                const otherLat = pAxis === 'x' ? other.x1 : other.z1
                ped.state = 'cross'
                ped.crossFrom = { x: ped.x, z: ped.z }
                ped.crossTo = pAxis === 'x' ? { x: otherLat, z: ped.z } : { x: ped.x, z: otherLat }
                ped.crossLen = Math.hypot(ped.crossTo.x - ped.x, ped.crossTo.z - ped.z) || 1
                ped.crossT = 0
                ped.segId = ped.pendingCw.otherId
                ped.dist = pAxis === 'x' ? Math.abs(ped.z - other.z1) : Math.abs(ped.x - other.x1)
                ped.pendingCw = null
                ped.waitTotal = 0
              } else {
                ped.state = 'walk'
                ped.pendingCw = null
              }
            }
          } else {
            ped.timer = 0.45 + this.rng() * 0.6
          }
        } else if (ped.timer <= 0) {
          ped.state = 'walk'
        }
      } else if (ped.state === 'idle') {
        ped.timer -= dt
        if (ped.timer <= 0) {
          if (ped.role === 'park') ped.parkTarget = this.parkPoint()
          ped.state = 'walk'
          ped.dist = 0
        }
      } else if (ped.state === 'toPoint') {
        // direct walk toward benches / shelters / bus doors / seg re-entry
        ped.travelT += dt
        // live-update the target while chasing a boarding bus
        if (ped.arrive === 'board') {
          const bus = buses.find((b) => b.stopId === ped.stopId)
          if (bus) {
            ped.target!.x = bus.doorX
            ped.target!.z = bus.doorZ
          } else if (ped.travelT > 1.2) {
            // bus left — walk back to the shelter and wait again
            const spot = this.stopSpots.find((s) => s.stopId === ped.stopId)
            if (spot && (this.stopUsed.get(ped.stopId!) ?? 0) > 0) {
              this.goTo(ped, spot.x, spot.z, 'shelter')
            } else {
              this.attachNearest(ped, ped.x, ped.z)
            }
            continue
          }
        }
        const dx = ped.target!.x - ped.x
        const dz = ped.target!.z - ped.z
        const d = Math.hypot(dx, dz)
        const arrived = d < (ped.arrive === 'board' ? 1.0 : 0.55)
        if (arrived) {
          if (ped.arrive === 'sit') {
            ped.state = 'sit'
            const b = this.benchSpots[ped.benchIdx]
            if (b) {
              ped.x = b.x
              ped.z = b.z
              ped.heading = b.ry
            }
            ped.timer = 14 + this.rng() * 30
          } else if (ped.arrive === 'shelter') {
            ped.state = 'waitBus'
            ped.heading = ped.spotRy
            ped.waitTotal = 0
            ped.timer = 0.4
          } else if (ped.arrive === 'board') {
            ped.state = 'board'
          } else {
            this.attachNearest(ped, ped.x, ped.z)
          }
        } else if (ped.travelT > 26) {
          // give up on the trip — walk back to the graph
          if (ped.arrive === 'sit' && ped.benchIdx >= 0) this.benchUsed.delete(ped.benchIdx)
          if (ped.arrive === 'shelter' && ped.stopId) this.releaseStop(ped.stopId)
          ped.benchIdx = -1
          this.attachNearest(ped, ped.x, ped.z)
        } else {
          const step = ped.speed * dt
          ped.x += (dx / d) * step
          ped.z += (dz / d) * step
          ped.heading = Math.atan2(dx, dz)
        }
      } else if (ped.state === 'sit') {
        ped.timer -= dt
        if (ped.timer <= 0) {
          const b = this.benchSpots[ped.benchIdx]
          this.benchUsed.delete(ped.benchIdx)
          ped.benchIdx = -1
          // step off the bench forward, then re-join the graph
          if (b) this.goTo(ped, b.x + Math.sin(b.ry) * 1.4, b.z + Math.cos(b.ry) * 1.4, 'attach')
          else this.attachNearest(ped, ped.x, ped.z)
        }
      } else if (ped.state === 'waitBus') {
        ped.waitTotal += dt
        ped.timer -= dt
        ped.heading = ped.spotRy
        if (ped.timer <= 0) {
          ped.timer = 0.5
          const bus = buses.find((b) => b.stopId === ped.stopId)
          if (bus && ped.waitTotal > 3 && this.rng() < 0.75) {
            this.goTo(ped, bus.doorX, bus.doorZ, 'board')
          } else if (ped.waitTotal > 55) {
            // gave up on the bus
            if (ped.stopId) this.releaseStop(ped.stopId)
            ped.stopId = null
            this.attachNearest(ped, ped.x, ped.z)
          }
        }
      } else if (ped.state === 'board') {
        // stepping through the doors — fade out, then either ride (hidden
        // until the next dwell at this stop) or respawn off-screen
        ped.alpha -= dt * 2.6
        if (ped.alpha <= 0) {
          ped.alpha = 0
          const stopId = ped.stopId
          if (stopId && this.rng() < 0.6) {
            ped.state = 'hidden'
            ped.timer = 6 + this.rng() * 10
          } else {
            if (stopId) this.releaseStop(stopId)
            ped.stopId = null
            this.respawnFar(ped, cameraPos)
          }
        }
      } else if (ped.state === 'hidden') {
        // riding the bus — reappear through the doors at the next dwell
        ped.timer -= dt
        if (ped.timer <= 0) {
          const bus = buses.find((b) => b.stopId === ped.stopId)
          if (bus) {
            ped.state = 'alight'
            ped.x = bus.doorX + (bus.doorX - bus.x) * 0.25
            ped.z = bus.doorZ + (bus.doorZ - bus.z) * 0.25
            ped.alpha = 0
            const spot = this.stopSpots.find((s) => s.stopId === ped.stopId)
            if (spot) this.goTo(ped, spot.x - Math.sin(spot.ry) * 1.0, spot.z - Math.cos(spot.ry) * 1.0, 'attach')
            else this.attachNearest(ped, ped.x, ped.z)
          } else if (ped.timer < -30) {
            // bus never came back — respawn quietly off-screen
            if (ped.stopId) this.releaseStop(ped.stopId)
            ped.stopId = null
            this.respawnFar(ped, cameraPos)
          }
        }
      } else if (ped.state === 'alight') {
        ped.alpha += dt * 2.2
        if (ped.alpha > 1) ped.alpha = 1
        const t = ped.target
        if (t) {
          const dx = t.x - ped.x
          const dz = t.z - ped.z
          const d = Math.hypot(dx, dz)
          if (d < 0.55) {
            ped.target = null
            ped.arrive = null
            this.attachNearest(ped, ped.x, ped.z)
          } else {
            ped.x += (dx / d) * ped.speed * dt
            ped.z += (dz / d) * ped.speed * dt
            ped.heading = Math.atan2(dx, dz)
          }
        } else {
          this.attachNearest(ped, ped.x, ped.z)
        }
      } else {
        // walking along sidewalk
        const seg = this.network.sidewalks.get(ped.segId)
        if (!seg) {
          const ids = [...this.network.sidewalks.keys()]
          if (ids.length === 0) continue
          ped.segId = ids[0]
          continue
        }
        const len = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1)
        ped.dist += ped.speed * dt
        if (ped.dist >= len) {
          // role behaviors at segment end
          if (ped.role === 'park' && this.rng() < 0.25) {
            ped.parkTarget = this.parkPoint()
          }
          const day = this.lastNight < 0.6
          let went = false
          if (day) {
            // — catch a bus: stoppers head for shelters, others join sometimes
            const busChance = ped.role === 'stopper' ? 0.42 : 0.045
            if (this.stopSpots.length > 0 && this.rng() < busChance) {
              const spot = this.findStop(ped.x, ped.z, 95)
              if (spot) {
                this.stopUsed.set(spot.stopId, (this.stopUsed.get(spot.stopId) ?? 0) + 1)
                ped.stopId = spot.stopId
                ped.spotRy = spot.ry
                // stand beside the shelter bench, facing the road
                this.goTo(ped, spot.x + Math.sin(spot.ry) * 0.5, spot.z + Math.cos(spot.ry) * 0.5, 'shelter')
                went = true
              }
            }
            // — take a seat: a bench nearby
            if (!went) {
              const benchChance = ped.role === 'park' ? 0.3 : ped.role === 'shopper' ? 0.1 : 0.06
              if (this.benchSpots.length > 0 && this.rng() < benchChance) {
                const bi = this.findBench(ped.x, ped.z, ped.role === 'park' ? 55 : 34)
                if (bi >= 0) {
                  const b = this.benchSpots[bi]
                  this.benchUsed.add(bi)
                  ped.benchIdx = bi
                  this.goTo(ped, b.x, b.z, 'sit')
                  went = true
                }
              }
            }
          }
          if (went) continue
          if (ped.role === 'stopper' && this.rng() < 0.3) {
            ped.state = 'idle'
            ped.timer = 8 + this.rng() * 20
          } else if (ped.role === 'shopper' && Math.abs(ped.x - 100) < 8 && Math.abs(ped.z) < 200 && this.rng() < 0.2) {
            ped.state = 'idle'
            ped.timer = 4 + this.rng() * 8
          } else {
            this.pickNext(ped, seg)
          }
        }
        const t = Math.min(ped.dist / len, 1)
        ped.x = seg.x1 + (seg.x2 - seg.x1) * t
        ped.z = seg.z1 + (seg.z2 - seg.z1) * t
        ped.heading = Math.atan2(seg.x2 - seg.x1, seg.z2 - seg.z1)
        // park wander: drift toward target when close to a park
        if (ped.parkTarget && ped.state === 'walk') {
          const dx = ped.parkTarget.x - ped.x
          const dz = ped.parkTarget.z - ped.z
          const d = Math.hypot(dx, dz)
          if (d < 2) {
            ped.parkTarget = null
            ped.state = 'idle'
            ped.timer = 5 + this.rng() * 12
          } else if (d < 30) {
            // leave the graph and walk directly (parks are open ground)
            ped.x += (dx / d) * ped.speed * dt
            ped.z += (dz / d) * ped.speed * dt
            ped.heading = Math.atan2(dx, dz)
          }
        }
      }

      // write instance matrices
      const walking = ped.state === 'walk' || ped.state === 'cross' || ped.state === 'toPoint' || ped.state === 'alight'
      const sitting = ped.state === 'sit'
      const bob = walking ? Math.abs(Math.sin(performance.now() * 0.006 * ped.speed * 2 + ped.phase)) * 0.05 : 0
      const sc = ped.visible ? ped.alpha : 0.0001
      const bodyY = sitting ? -0.06 : bob
      dummy.position.set(ped.x, bodyY, ped.z)
      dummy.rotation.set(0, ped.heading, 0)
      dummy.scale.setScalar(sc)
      dummy.updateMatrix()
      this.bodyIM?.setMatrixAt(i, dummy.matrix)
      this.headIM?.setMatrixAt(i, dummy.matrix)
      // legs swing (rotation order YXZ → X-rotation is local: front/back swing)
      const swing = walking ? Math.sin(performance.now() * 0.008 * ped.speed * 2 + ped.phase) * 0.55 : 0
      for (let l = 0; l < 2; l++) {
        const side = l === 0 ? -0.09 : 0.09
        const lx = Math.cos(ped.heading) * side
        const lz = -Math.sin(ped.heading) * side
        if (sitting) {
          // seated pose: thighs pitched forward off the bench seat
          dummy.position.set(ped.x + lx, 0.52, ped.z + lz)
          dummy.rotation.set(-1.3, ped.heading, 0)
        } else {
          dummy.position.set(ped.x + lx, 0.72, ped.z + lz)
          dummy.rotation.set(l === 0 ? swing : -swing, ped.heading, 0)
        }
        dummy.scale.setScalar(sc)
        dummy.updateMatrix()
        this.legIM?.setMatrixAt(i * 2 + l, dummy.matrix)
      }
      // umbrella raises when it rains, folds away when it dries
      const umbTarget = ped.hasUmbrella && rain > 0.22 ? 1 : 0
      ped.umbT += (umbTarget - ped.umbT) * Math.min(1, dt * 2.4)
      if (ped.umbT > 0.02) {
        const tilt = walking ? Math.sin(performance.now() * 0.004 + ped.phase) * 0.05 : 0
        dummy.position.set(ped.x, bodyY, ped.z)
        dummy.rotation.set(0, ped.heading, tilt * 2)
        dummy.scale.setScalar(sc * ped.umbT)
        dummy.updateMatrix()
        this.umbCanopyIM?.setMatrixAt(i, dummy.matrix)
        this.umbPoleIM?.setMatrixAt(i, dummy.matrix)
      } else {
        dummy.position.set(0, -100, 0)
        dummy.scale.setScalar(0.0001)
        dummy.updateMatrix()
        this.umbCanopyIM?.setMatrixAt(i, dummy.matrix)
        this.umbPoleIM?.setMatrixAt(i, dummy.matrix)
      }
    }

    if (this.bodyIM) {
      this.bodyIM.instanceMatrix.needsUpdate = true
      // one-time color init
      if (!this.colorInit) {
        const UMBRELLA_COLS = ['#c94f3d', '#3a6a4e', '#c8a03a', '#6a7a6a', '#8a5a8a', '#d8d4c8']
        for (let i = 0; i < this.peds.length; i++) {
          this.bodyIM.setColorAt(i, new THREE.Color(CLOTHES[i % CLOTHES.length]))
          this.headIM?.setColorAt(i, new THREE.Color(SKINS[i % SKINS.length]))
          this.umbCanopyIM?.setColorAt(i, new THREE.Color(UMBRELLA_COLS[i % UMBRELLA_COLS.length]))
        }
        if (this.bodyIM.instanceColor) this.bodyIM.instanceColor.needsUpdate = true
        if (this.headIM?.instanceColor) this.headIM.instanceColor.needsUpdate = true
        if (this.umbCanopyIM?.instanceColor) this.umbCanopyIM.instanceColor.needsUpdate = true
        this.colorInit = true
      }
    }
    if (this.headIM) this.headIM.instanceMatrix.needsUpdate = true
    if (this.legIM) this.legIM.instanceMatrix.needsUpdate = true
    if (this.umbCanopyIM) this.umbCanopyIM.instanceMatrix.needsUpdate = true
    if (this.umbPoleIM) this.umbPoleIM.instanceMatrix.needsUpdate = true
  }

  private colorInit = false

  private releaseStop(stopId: string) {
    const n = (this.stopUsed.get(stopId) ?? 1) - 1
    if (n <= 0) this.stopUsed.delete(stopId)
    else this.stopUsed.set(stopId, n)
  }

  /* ---------------- streaming: keep peds near the player ---------------- */
  private streamTimer = 0

  private stream(cameraPos: THREE.Vector3) {
    const px = cameraPos.x
    const pz = cameraPos.z
    const ids = [...this.network.sidewalks.keys()]
    if (ids.length === 0) return
    for (const ped of this.peds) {
      if (ped.state !== 'walk') continue // moving trips keep their state
      const d2 = (ped.x - px) ** 2 + (ped.z - pz) ** 2
      if (d2 < 200 * 200) continue
      for (let tries = 0; tries < 14; tries++) {
        const seg = this.network.sidewalks.get(ids[Math.floor(this.rng() * ids.length)])
        if (!seg) continue
        const mx = (seg.x1 + seg.x2) / 2
        const mz = (seg.z1 + seg.z2) / 2
        const d2s = (mx - px) ** 2 + (mz - pz) ** 2
        if (d2s > 60 * 60 && d2s < 170 * 170) {
          ped.segId = seg.id
          ped.dist = this.rng() * 30
          ped.parkTarget = null
          break
        }
      }
    }
  }
}
