import * as THREE from 'three'

/* ============================================================
 * BirdSystem — small gull flocks circling over the parks by day.
 * Pure instanced geometry (cone body + two flapping wing planes).
 * Hidden at night and while it rains.
 * ============================================================ */

interface Flock {
  cx: number
  cz: number
  r: number
  h: number
  speed: number
}

interface Bird {
  flock: number
  phase: number // angle around the flock circle
  jitterR: number
  jitterH: number
  flapPhase: number
  flapSpeed: number
}

const FLOCKS: Flock[] = [
  { cx: 0, cz: -300, r: 34, h: 26, speed: 0.16 }, // Central Park
  { cx: 50, cz: -50, r: 26, h: 20, speed: 0.2 }, // Civic Plaza
  { cx: -50, cz: 350, r: 40, h: 30, speed: 0.13 }, // Sports Park
]
const BIRDS_PER_FLOCK = 5

export class BirdSystem {
  group = new THREE.Group()
  private bodyIM: THREE.InstancedMesh
  private wingLIM: THREE.InstancedMesh
  private wingRIM: THREE.InstancedMesh
  private birds: Bird[] = []

  constructor() {
    const count = FLOCKS.length * BIRDS_PER_FLOCK
    const bodyGeo = new THREE.ConeGeometry(0.09, 0.55, 5)
    bodyGeo.rotateX(Math.PI / 2) // point along +z (travel dir)
    // MeshBasicMaterial: birds are tiny — lit shading turns their undersides
    // into pure-black slabs against the sky ("random floating black blocks"
    // reports). A fixed pale tone reads as a gull from every angle.
    const mat = new THREE.MeshBasicMaterial({ color: '#cfcfc4' })
    this.bodyIM = new THREE.InstancedMesh(bodyGeo, mat, count)
    const wingGeo = new THREE.PlaneGeometry(0.62, 0.24)
    wingGeo.translate(0.31, 0, 0) // hinge at the body edge
    const wingMat = new THREE.MeshBasicMaterial({ color: '#e4e4da', side: THREE.DoubleSide })
    this.wingLIM = new THREE.InstancedMesh(wingGeo, wingMat, count)
    const wingRGeo = wingGeo.clone()
    wingRGeo.scale(-1, 1, 1)
    this.wingRIM = new THREE.InstancedMesh(wingRGeo, wingMat, count)
    for (const im of [this.bodyIM, this.wingLIM, this.wingRIM]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      this.group.add(im)
    }
    let i = 0
    for (let f = 0; f < FLOCKS.length; f++) {
      for (let b = 0; b < BIRDS_PER_FLOCK; b++) {
        this.birds.push({
          flock: f,
          phase: (b / BIRDS_PER_FLOCK) * Math.PI * 2 + f * 1.7,
          jitterR: (b % 2 === 0 ? 1 : -1) * (2 + (b % 3) * 2.2),
          jitterH: (b % 3) * 1.4,
          flapPhase: Math.random() * Math.PI * 2,
          flapSpeed: 7 + (b % 4),
        })
        i++
      }
    }
    void i
  }

  update(t: number, cameraPos: THREE.Vector3, night: number, rain: number) {
    const show = night < 0.45 && rain < 0.3
    const dummy = new THREE.Object3D()
    dummy.rotation.order = 'YXZ'
    const hide = () => {
      dummy.position.set(0, -100, 0)
      dummy.scale.setScalar(0.0001)
      dummy.updateMatrix()
      for (let i = 0; i < this.birds.length; i++) {
        this.bodyIM.setMatrixAt(i, dummy.matrix)
        this.wingLIM.setMatrixAt(i, dummy.matrix)
        this.wingRIM.setMatrixAt(i, dummy.matrix)
      }
    }
    if (!show) {
      hide()
    } else {
      for (let i = 0; i < this.birds.length; i++) {
        const b = this.birds[i]
        const f = FLOCKS[b.flock]
        // skip far flocks (still cheap, but avoids matrix churn)
        const d2 = (f.cx - cameraPos.x) ** 2 + (f.cz - cameraPos.z) ** 2
        if (d2 > 420 * 420) {
          dummy.position.set(0, -100, 0)
          dummy.scale.setScalar(0.0001)
          dummy.updateMatrix()
          this.bodyIM.setMatrixAt(i, dummy.matrix)
          this.wingLIM.setMatrixAt(i, dummy.matrix)
          this.wingRIM.setMatrixAt(i, dummy.matrix)
          continue
        }
        const ang = b.phase + t * f.speed
        const rr = f.r + Math.sin(t * 0.23 + b.flapPhase) * b.jitterR
        const x = f.cx + Math.cos(ang) * rr
        const z = f.cz + Math.sin(ang) * rr
        const y = f.h + b.jitterH + Math.sin(t * 0.5 + b.flapPhase) * 1.2
        // heading = tangent of the circle
        const heading = Math.atan2(-Math.sin(ang), Math.cos(ang))
        dummy.position.set(x, y, z)
        dummy.rotation.set(0, heading, Math.sin(t * 0.8 + b.flapPhase) * 0.18)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        this.bodyIM.setMatrixAt(i, dummy.matrix)
        // wings flap around the body's local x axis
        const flap = Math.sin(t * b.flapSpeed + b.flapPhase) * 0.55
        dummy.position.set(x, y, z)
        dummy.rotation.set(flap, heading, Math.sin(t * 0.8 + b.flapPhase) * 0.18)
        dummy.updateMatrix()
        this.wingLIM.setMatrixAt(i, dummy.matrix)
        dummy.rotation.set(-flap, heading, Math.sin(t * 0.8 + b.flapPhase) * 0.18)
        dummy.updateMatrix()
        this.wingRIM.setMatrixAt(i, dummy.matrix)
      }
    }
    this.bodyIM.instanceMatrix.needsUpdate = true
    this.wingLIM.instanceMatrix.needsUpdate = true
    this.wingRIM.instanceMatrix.needsUpdate = true
  }
}
