import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { CityMaterials, CityPlan } from './types'

/* ============================================================
 * WeatherSystem — slow clear → overcast → rain cycles.
 *
 * Rain: instanced streaks falling in a box that follows the
 * camera. The world reacts: asphalt & sidewalks get glossy
 * (roughness ↓, envMap ↑), puddle decals fade in, the sun is
 * dimmed by cloud cover and fog closes in.
 * ============================================================ */

type Phase = 'clear' | 'overcast' | 'rain'

const PHASE_SECONDS = { clear: 150, overcast: 70, rain: 110 }

export class WeatherSystem {
  group = new THREE.Group()
  phase: Phase = 'clear'
  /** 0..1 cloud dimming */
  cloud = 0
  /** 0..1 rain strength (smoothed) */
  rain = 0
  private phaseT = PHASE_SECONDS.clear * 0.6
  private streaks: THREE.InstancedMesh | null = null
  private drops: { x: number; y: number; z: number; v: number }[] = []
  private puddles: THREE.Mesh[] = []
  private plan: CityPlan
  private mats: CityMaterials
  private scene: THREE.Scene
  private baseAsphalt: { color: THREE.Color; rough: number }
  private baseAsphaltRough: { color: THREE.Color; rough: number }
  private baseSidewalk: { color: THREE.Color; rough: number }
  private baseConcrete: { color: THREE.Color; rough: number }
  private baseFogNear = 220
  private baseFogFar = 700
  private rng = (() => {
    let s = 24601
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
  })()

  constructor(scene: THREE.Scene, plan: CityPlan, mats: CityMaterials, puddleSpots: { x: number; z: number; s: number }[]) {
    this.scene = scene
    this.plan = plan
    this.mats = mats
    this.baseAsphalt = { color: mats.asphalt.color.clone(), rough: mats.asphalt.roughness }
    this.baseAsphaltRough = { color: mats.asphaltRough.color.clone(), rough: mats.asphaltRough.roughness }
    this.baseSidewalk = { color: mats.sidewalk.color.clone(), rough: mats.sidewalk.roughness }
    this.baseConcrete = { color: mats.concreteLight.color.clone(), rough: mats.concreteLight.roughness }
    const fog = scene.fog as THREE.Fog | null
    if (fog) {
      this.baseFogNear = fog.near
      this.baseFogFar = fog.far
    }

    /* ---- rain streak instancing ---- */
    const RAIN_COUNT = 850
    const dropGeo = new THREE.BoxGeometry(0.016, 0.55, 0.016)
    const dropMat = new THREE.MeshBasicMaterial({ color: '#aebfc8', transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false })
    this.streaks = new THREE.InstancedMesh(dropGeo, dropMat, RAIN_COUNT)
    this.streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.streaks.frustumCulled = false
    this.streaks.visible = false
    for (let i = 0; i < RAIN_COUNT; i++) {
      this.drops.push({
        x: (this.rng() - 0.5) * 46,
        y: this.rng() * 22,
        z: (this.rng() - 0.5) * 46,
        v: 19 + this.rng() * 7,
      })
    }
    this.group.add(this.streaks)

    /* ---- puddle decals (ONE merged mesh — shiny ellipses, opacity = rain) ---- */
    const puddleMat = new THREE.MeshStandardMaterial({
      color: '#8a949a',
      roughness: 0.06,
      metalness: 0.55,
      transparent: true,
      opacity: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    if (puddleSpots.length > 0) {
      const puddleGeos: THREE.BufferGeometry[] = []
      for (const p of puddleSpots) {
        const g = new THREE.CircleGeometry(1, 12)
        g.rotateX(-Math.PI / 2)
        g.scale(p.s * 1.5, 1, p.s)
        g.translate(p.x, 0.028, p.z)
        puddleGeos.push(g)
      }
      const merged = mergeGeometries(puddleGeos, false)
      if (merged) {
        const m = new THREE.Mesh(merged, puddleMat)
        m.visible = false
        m.renderOrder = 2
        this.group.add(m)
        this.puddles.push(m)
      }
    }
    scene.add(this.group)
  }

  /** advance weather; returns {cloud, rain} so the engine can dim lights */
  update(dt: number, cameraPos: THREE.Vector3): { cloud: number; rain: number } {
    /* ---- phase machine ---- */
    this.phaseT -= dt
    if (this.phaseT <= 0) {
      const order: Record<Phase, Phase[]> = { clear: ['overcast', 'clear'], overcast: ['rain', 'clear'], rain: ['clear', 'overcast'] }
      const opts = order[this.phase]
      this.phase = opts[Math.floor(this.rng() * opts.length)]
      this.phaseT = PHASE_SECONDS[this.phase] * (0.7 + this.rng() * 0.6)
    }
    const targetCloud = this.phase === 'clear' ? 0 : this.phase === 'overcast' ? 0.55 : 0.85
    const targetRain = this.phase === 'rain' ? 1 : 0
    // smooth transitions (≈8 s to bucket-down, ≈4 s to clear)
    const rate = targetRain > this.rain ? 0.28 : 0.6
    this.cloud += (targetCloud - this.cloud) * Math.min(1, dt * 0.7)
    this.rain += (targetRain - this.rain) * Math.min(1, dt * rate)

    /* ---- world response ---- */
    const wet = this.rain
    const darken = (m: THREE.MeshStandardMaterial, base: { color: THREE.Color; rough: number }, roughTarget: number) => {
      m.color.copy(base.color).lerp(new THREE.Color('#1c2124'), wet * 0.45)
      m.roughness = base.rough + (roughTarget - base.rough) * wet
      m.envMapIntensity = 1 + wet * 1.6
    }
    darken(this.mats.asphalt, this.baseAsphalt, 0.32)
    darken(this.mats.asphaltRough, this.baseAsphaltRough, 0.4)
    darken(this.mats.sidewalk, this.baseSidewalk, this.baseSidewalk.rough * 0.8)
    // plaza paving + platforms dampen a little less than asphalt
    const cc = this.mats.concreteLight
    cc.color.copy(this.baseConcrete.color).lerp(new THREE.Color('#5a636a'), wet * 0.35)
    cc.roughness = this.baseConcrete.rough + (0.3 - this.baseConcrete.rough) * wet
    cc.envMapIntensity = 1 + wet * 1.3
    const puddleMat = this.puddles[0]?.material as THREE.MeshStandardMaterial | undefined
    if (puddleMat) {
      puddleMat.opacity = wet * 0.9
      for (const p of this.puddles) p.visible = wet > 0.05
    }
    const fog = this.scene.fog as THREE.Fog | null
    if (fog) {
      fog.near = this.baseFogNear - wet * 90 - this.cloud * 30
      fog.far = this.baseFogFar - wet * 300 - this.cloud * 130
    }

    /* ---- rain streaks follow the camera ---- */
    if (this.streaks) {
      const show = wet > 0.03
      this.streaks.visible = show
      if (show) {
        const dummy = new THREE.Object3D()
        const n = Math.floor(this.drops.length * Math.min(1, wet * 1.15))
        const t = performance.now() * 0.001
        for (let i = 0; i < this.drops.length; i++) {
          const d = this.drops[i]
          if (i < n) {
            d.y -= d.v * dt
            d.x += dt * 2.2 // wind
            if (d.y < 0) {
              d.y = 20 + this.rng() * 4
              d.x = (this.rng() - 0.5) * 46
              d.z = (this.rng() - 0.5) * 46
            }
            dummy.position.set(cameraPos.x + d.x, d.y, cameraPos.z + d.z)
            dummy.rotation.set(0, 0, 0.07) // slight wind slant
            dummy.scale.set(1, 1, 1)
          } else {
            dummy.position.set(0, -100, 0)
            dummy.scale.setScalar(0.0001)
          }
          dummy.updateMatrix()
          this.streaks.setMatrixAt(i, dummy.matrix)
        }
        this.streaks.instanceMatrix.needsUpdate = true
        ;(this.streaks.material as THREE.MeshBasicMaterial).opacity = 0.34 * wet
        void t
      }
    }

    return { cloud: this.cloud, rain: this.rain }
  }

  /** toast text when the phase changes (engine shows it) */
  phaseLabel(): string | null {
    switch (this.phase) {
      case 'rain':
        return 'Rain moving in — the asphalt turns glossy'
      case 'overcast':
        return 'Clouds rolling over Solheim'
      default:
        return 'Clearing up — sun back over the city'
    }
  }
}
