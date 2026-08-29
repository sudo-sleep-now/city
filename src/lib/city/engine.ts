import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { CITY, DAY_LENGTH_SEC, START_HOUR } from './constants'
import { planCity } from './planner'
import { createMaterials, getSpecialFacadeMaterials } from './materials'
import { buildRoadNetwork, createRoadMeshes } from './roads'
import { createBuildings, skyDeck, type BuildingsResult } from './buildings'
import { createEnvironment, type EnvironmentResult } from './environment'
import { TrafficSystem } from './traffic'
import { PedestrianSystem } from './pedestrians'
import { CyclistSystem } from './cyclists'
import { WeatherSystem } from './weather'
import { BirdSystem } from './birds'
import { AmbientAudio } from './audio'
import { EmergencySystem } from './emergency'
import { InteriorManager, type InteriorHandle } from './interiors'
import { buildTourStops, tourIntro, type TourStop } from './tour'
import { FirstPersonController } from './player'
import { LightingRig } from './lighting'
import { useCityStore } from './store'
import type { AABB, CityPlan, NearbyInteraction, POI } from './types'

/* ============================================================
 * CityEngine — builds the world in stages and runs the loop.
 * ============================================================ */

export class CityEngine {
  plan!: CityPlan
  scene!: THREE.Scene
  camera!: THREE.PerspectiveCamera
  renderer!: THREE.WebGLRenderer
  player!: FirstPersonController
  lighting!: LightingRig
  traffic!: TrafficSystem
  peds!: PedestrianSystem
  cyclists!: CyclistSystem
  emergency!: EmergencySystem
  weather!: WeatherSystem
  birds!: BirdSystem
  audio = new AmbientAudio()
  interiors!: InteriorManager
  private container: HTMLElement
  private buildings!: BuildingsResult
  private env!: EnvironmentResult
  private outsideColliders: AABB[] = []
  private insideColliders: { minX: number; maxX: number; minZ: number; maxZ: number }[] = []
  private raf = 0
  private lastT = 0
  private clockAcc = 0
  private fpsAcc = 0
  private fpsFrames = 0
  private nightLights: THREE.PointLight[] = []
  private nightLightTimer = 0
  private ready = false
  private disposed = false

  constructor(container: HTMLElement) {
    this.container = container
  }

  async init() {
    const store = useCityStore.getState()
    const step = async (p: number) => {
      store.patch({ loadingProgress: p })
      await new Promise((r) => setTimeout(r, 0))
    }

    // renderer
    const isTouch = typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0)
    // logarithmicDepthBuffer: uniform z-precision from 0.1 m to 1600 m.
    // Without it the 24-bit depth buffer starves beyond ~250 m and every
    // facade decal (windows, bands, trim at +2..9 cm) z-fights — the
    // "flashing overlapping parts / floating blocks on buildings" reports.
    this.renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance', logarithmicDepthBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.25 : 1.75))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()

    // procedural image-based lighting (no external assets): subtle sky/room
    // reflections make glass & metal readable instead of pitch black
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.5
    pmrem.dispose()

    this.camera = new THREE.PerspectiveCamera(72, this.container.clientWidth / this.container.clientHeight, 0.1, 1600)
    this.scene.add(this.camera)

    await step(0.05)
    this.plan = planCity()
    this.lighting = new LightingRig(this.scene)
    this.lighting.setTime(START_HOUR)

    await step(0.15)
    const mats = createMaterials()
    this.mats = mats

    await step(0.3)
    const roadGroup = createRoadMeshes(this.plan, mats)
    this.scene.add(roadGroup)

    await step(0.45)
    this.buildings = createBuildings(this.plan, mats)
    this.scene.add(this.buildings.group)

    await step(0.65)
    this.env = createEnvironment(this.plan, mats)
    this.scene.add(this.env.group)

    await step(0.72)
    this.weather = new WeatherSystem(this.scene, this.plan, mats, this.env.puddleSpots)

    await step(0.8)
    const network = buildRoadNetwork(this.plan)
    this.traffic = new TrafficSystem(this.plan, network, mats)
    this.peds = new PedestrianSystem(this.plan, network, mats, this.env.benchSpots, this.env.stopSpots)
    this.peds.carQuery = () => this.traffic.getCarPositions()
    this.peds.signalQuery = (id) => this.traffic.signalGreenAxis(id)
    this.peds.boardQuery = () => this.traffic.getBoardingBuses()
    this.cyclists = new CyclistSystem(this.plan, mats)
    this.cyclists.pedQuery = () => this.peds.getPedPositions()
    this.birds = new BirdSystem()
    this.scene.add(this.traffic.group, this.peds.group, this.cyclists.group, this.birds.group)
    this.emergency = new EmergencySystem(this.plan, mats)
    this.scene.add(this.emergency.group)

    await step(0.9)
    this.interiors = new InteriorManager(this.plan, mats)

    // pooled night streetlights
    for (let i = 0; i < 6; i++) {
      const pl = new THREE.PointLight(0xffd9a0, 0, 34, 1.6)
      pl.visible = false
      this.scene.add(pl)
      this.nightLights.push(pl)
    }

    // player
    this.outsideColliders = [...this.plan.colliders, ...this.buildings.colliders, ...this.env.colliders]
    this.player = new FirstPersonController(this.camera, this.renderer.domElement, this.outsideColliders, CITY.half, this.plan.spawn)
    if (this.player.isTouch) this.renderer.shadowMap.enabled = false // save the battery
    this.player.enabled = true
    this.player.onInteract = () => this.interact()
    this.player.onToggleTour = () => {
      const s = useCityStore.getState()
      if (!s.started || s.showStats || s.activePoi || s.insideId || this.onDeck) return
      this.toggleTour()
    }
    this.player.onToggleStats = () => {
      const s = useCityStore.getState()
      if (s.started && !s.activePoi) {
        s.toggleStats()
        if (useCityStore.getState().showStats) this.player.enabled = false
        else this.player.enabled = true
      }
    }

    window.addEventListener('resize', this.onResize)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    window.addEventListener('keydown', this.onKey)

    await step(1)
    this.ready = true
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __cityEngine?: CityEngine }).__cityEngine = this
    }
    store.patch({ ready: true, clock: this.lighting.time })
    this.lastT = performance.now()
    this.loop()
  }

  private mats!: ReturnType<typeof createMaterials>

  private onResize = () => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  private onPointerLockChange = () => {
    const s = useCityStore.getState()
    if (!s.started || s.insideId || s.showStats || s.activePoi) return
    if (!document.pointerLockElement) {
      s.patch({ paused: true })
    } else {
      s.patch({ paused: false })
    }
  }

  requestStart() {
    const s = useCityStore.getState()
    s.patch({ started: true, paused: false })
    this.audio.start() // inside the user gesture — browsers allow audio now
    this.player.requestLock()
    s.showToast(this.player.isTouch ? 'Welcome to Solheim — left thumb walks, right thumb looks' : 'Welcome to Solheim — walk toward Central Station')
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'm' || e.key === 'M') {
      const s = useCityStore.getState()
      if (!s.started) return
      this.toggleMute()
    }
  }

  toggleMute() {
    const muted = this.audio.toggleMute()
    useCityStore.getState().patch({ muted })
  }

  /* touch HUD hooks (no-ops on desktop) */
  mobileJump() {
    this.player.fireJump()
  }

  mobileInteract() {
    this.player.fireInteract()
  }

  mobileSprint(on: boolean) {
    this.player.setSprint(on)
  }

  get isTouchDevice() {
    return this.player?.isTouch ?? false
  }

  resume() {
    useCityStore.getState().patch({ paused: false, showStats: false, activePoi: null })
    this.player.enabled = true
    this.player.requestLock()
  }

  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    let dt = (now - this.lastT) / 1000
    this.lastT = now
    if (dt > 0.15) dt = 0.15

    const s = useCityStore.getState()
    const active = s.started && !s.paused && !s.showStats && !s.activePoi

    // time of day always advances (also while paused → alive background)
    this.lighting.advance(dt, DAY_LENGTH_SEC)

    if (active && this.player) {
      this.player.update(dt)
    }

    const night = this.lighting.nightFactor()
    this.playerPosV.set(this.camera.position.x, 0, this.camera.position.z)
    this.lighting.update(this.playerPosV)
    // weather dims the rig after lighting.update re-applies base intensities
    const wx = this.weather.update(dt, this.playerPosV)
    this.lighting.sun.intensity *= 1 - 0.78 * wx.cloud
    this.lighting.hemi.intensity *= 1 - 0.45 * wx.cloud
    this.lighting.ambient.intensity *= 1 - 0.25 * wx.cloud
    this.lighting.applyWeather(wx.cloud, wx.rain)
    // fade IBL with daylight so night stays night; clouds damp reflections
    this.scene.environmentIntensity = Math.max(0.08, 0.12 + 0.42 * (1 - night) - wx.cloud * 0.1)
    // announce phase changes
    if (wx.rain > 0.05 || wx.cloud > 0.05 || this.lastWeatherPhase !== this.weather.phase) {
      if (this.lastWeatherPhase !== this.weather.phase) {
        this.lastWeatherPhase = this.weather.phase
        const label = this.weather.phaseLabel()
        if (label && s.started) s.showToast(label)
      }
    }

    if (this.ready) {
      this.traffic.update(dt, this.playerPosV, night)
      this.peds.update(dt, this.playerPosV, night, wx.rain)
      this.cyclists.update(dt, this.playerPosV, night)
      this.birds.update(performance.now() / 1000, this.playerPosV, night, wx.rain)
      const sirenLevel = this.emergency.update(dt, this.playerPosV)
      this.audio.update(dt, { rain: wx.rain, night, inside: !!this.currentInterior, siren: sirenLevel })
      this.updateNightLights(dt, night)
      this.env.animated?.(performance.now() / 1000)
      if (this.tourIdx >= 0) {
        this.tourTimer += dt
        const stop = this.tourStops[this.tourIdx]
        if (stop && this.tourTimer > stop.holdSec) this.advanceTour()
      }
      this.clockAcc += dt
      if (this.clockAcc > 0.1) {
        this.clockAcc = 0
        if (this.currentInterior) {
          this.checkInteriorInteraction()
        } else if (this.onDeck) {
          this.checkDeckInteraction()
        } else {
          this.checkNearby()
        }
      }
    }

    // material emissive updates
    const winI = night * 1.5
    for (const f of this.mats.facades) f.material.emissiveIntensity = winI
    for (const f of getSpecialFacadeMaterials()) f.emissiveIntensity = winI
    this.mats.glassTower.emissiveIntensity = night * 0.9
    this.mats.streetlightHead.emissiveIntensity = night * 2.2

    // fps + store sync
    this.fpsAcc += dt
    this.fpsFrames++
    if (this.fpsAcc > 1) {
      s.patch({ fps: Math.round(this.fpsFrames / this.fpsAcc) })
      this.fpsAcc = 0
      this.fpsFrames = 0
    }
    if (this.ready && !this.storeAccum) this.storeAccum = 0
    this.storeAccum += dt
    if (this.storeAccum > 0.15) {
      this.storeAccum = 0
      s.patch({
        clock: this.lighting.time,
        px: this.camera.position.x,
        pz: this.camera.position.z,
        heading: this.player ? this.player.yaw : 0,
      })
    }

    this.renderer.render(this.scene, this.camera)
  }

  private storeAccum = 0
  private playerPosV = new THREE.Vector3()
  private lastWeatherPhase: 'clear' | 'overcast' | 'rain' = 'clear'

  private updateNightLights(dt: number, night: number) {
    this.nightLightTimer -= dt
    const on = night > 0.35
    if (this.nightLightTimer > 0) {
      if (on) {
        const intensity = 26 * night
        for (const l of this.nightLights) l.intensity = intensity
      }
      return
    }
    this.nightLightTimer = 0.6
    if (!on || this.env.streetLights.length === 0) {
      for (const l of this.nightLights) l.visible = false
      return
    }
    // pick 6 nearest streetlights to player
    const p = this.camera.position
    const cands: { d2: number; v: THREE.Vector3 }[] = []
    for (const v of this.env.streetLights) {
      const d2 = (v.x - p.x) ** 2 + (v.z - p.z) ** 2
      if (d2 < 140 * 140) cands.push({ d2, v })
    }
    cands.sort((a, b) => a.d2 - b.d2)
    for (let i = 0; i < this.nightLights.length; i++) {
      const l = this.nightLights[i]
      if (i < cands.length) {
        l.position.set(cands[i].v.x, cands[i].v.y, cands[i].v.z)
        l.visible = true
        l.intensity = 26 * night
      } else {
        l.visible = false
      }
    }
  }

  /* ---------------- interactions ---------------- */

  private nearby: NearbyInteraction | null = null

  private checkNearby() {
    const p = this.camera.position
    let best: NearbyInteraction | null = null
    let bestD = Infinity
    for (const poi of this.plan.pois) {
      const d = Math.hypot(poi.x - p.x, poi.z - p.z)
      if (d < poi.radius && d < bestD) {
        bestD = d
        best = { kind: 'poi', id: poi.id, title: poi.title, action: 'Inspect' }
      }
    }
    for (const e of this.plan.enterables) {
      const d = Math.hypot(e.doorX - p.x, e.doorZ - p.z)
      if (d < 4.5 && d < bestD) {
        bestD = d
        best = { kind: 'door', id: e.id, title: e.name, action: 'Enter' }
      }
    }
    const s = useCityStore.getState()
    const changed = (best?.id ?? null) !== (this.nearby?.id ?? null)
    this.nearby = best
    if (changed) s.patch({ nearby: best })
  }

  interact() {
    const s = useCityStore.getState()
    if (!s.started) return
    if (s.activePoi) {
      s.closePoi()
      this.player.enabled = true
      this.player.requestLock()
      return
    }
    if (s.showStats) {
      s.patch({ showStats: false })
      this.player.enabled = true
      this.player.requestLock()
      return
    }
    if (this.currentInterior) {
      // inside a building — the Skylink lobby's elevator bank overrides exit
      if (this.nearby?.id === 'skydeck-up') this.rideToDeck()
      else this.exitInterior()
      return
    }
    if (this.onDeck) {
      if (this.nearby?.id === 'skydeck-down') this.rideToLobby()
      return
    }
    if (!this.nearby) return
    if (this.nearby.kind === 'door') {
      this.enterInterior(this.nearby.id)
    } else {
      const poi = this.plan.pois.find((p) => p.id === this.nearby!.id) as POI
      if (poi) {
        s.openPoi(poi)
        s.patch({ paused: false })
        document.exitPointerLock()
        this.player.enabled = false
      }
    }
  }

  private currentInterior: { handle: InteriorHandle; specId: string } | null = null
  private onDeck = false
  private lobbyRef: { handle: InteriorHandle; specId: string } | null = null

  private enterInterior(id: string) {
    const h = this.interiors.enter(id)
    if (!h) return
    const spec = this.interiors.specOf(id)!
    if (spec.interiorKind === 'skylink') this.lobbyRef = { handle: h, specId: id }
    useCityStore.getState().patch({ fade: true })
    setTimeout(() => {
      this.scene.add(h.group)
      this.currentInterior = { handle: h, specId: id }
      this.insideColliders = h.colliders
      this.player.collidersOverride = h.colliders
      this.player.teleport(h.spawn.x, h.spawn.z, 0, h.spawn.yaw)
      useCityStore.getState().patch({ fade: false, insideId: id, insideName: spec.name })
      setTimeout(() => this.player.requestLock(), 60)
      useCityStore.getState().showToast(spec.name)
    }, 420)
  }

  private exitInterior() {
    if (!this.currentInterior) return
    const { handle, specId } = this.currentInterior
    const spec = this.interiors.specOf(specId)!
    useCityStore.getState().patch({ fade: true })
    setTimeout(() => {
      this.scene.remove(handle.group)
      this.currentInterior = null
      this.interiors.leave()
      this.nearby = null
      useCityStore.getState().patch({ nearby: null })
      this.player.collidersOverride = null
      // step out of the doorway
      const off = 1.6
      const dx = spec.facing === 90 ? off : spec.facing === 270 ? -off : 0
      const dz = spec.facing === 0 ? off : spec.facing === 180 ? -off : 0
      this.player.teleport(spec.doorX + dx, spec.doorZ + dz, 0)
      useCityStore.getState().patch({ fade: false, insideId: null, insideName: null })
      setTimeout(() => this.player.requestLock(), 60)
    }, 380)
  }

  private interiorCheckTimer = 0

  /** Ride the Skylink panoramic elevator: lobby → the REAL sky deck at 79 m.
   *  The lobby group stays in the scene so riding back down is instant. */
  private rideToDeck() {
    if (!skyDeck) return
    this.nearby = null
    useCityStore.getState().patch({ nearby: null, fade: true })
    setTimeout(() => {
      this.interiors.leave()
      this.currentInterior = null
      this.onDeck = true
      this.player.collidersOverride = skyDeck!.colliders
      this.player.teleport(skyDeck!.arrive.x, skyDeck!.arrive.z, skyDeck!.floorY, skyDeck!.arrive.yaw)
      useCityStore.getState().patch({ fade: false, insideId: null, insideName: null })
      setTimeout(() => this.player.requestLock(), 60)
      useCityStore.getState().showToast('Sky Deck — 79 m above Solheim')
    }, 520)
  }

  private rideToLobby() {
    if (!this.lobbyRef) return
    this.nearby = null
    useCityStore.getState().patch({ nearby: null, fade: true })
    setTimeout(() => {
      const { handle, specId } = this.lobbyRef!
      this.interiors.enter(specId)
      this.currentInterior = { handle, specId }
      this.onDeck = false
      this.player.collidersOverride = handle.colliders
      this.player.teleport(handle.spawn.x, handle.spawn.z - 4, 0, Math.PI)
      useCityStore.getState().patch({ fade: false, insideId: specId, insideName: 'Skylink Towers — Lobby' })
      setTimeout(() => this.player.requestLock(), 60)
    }, 520)
  }

  private checkDeckInteraction() {
    if (!this.onDeck || !skyDeck) return
    const p = this.camera.position
    const lz = skyDeck.liftZone
    const d = Math.hypot(lz.x - p.x, lz.z - p.z)
    const near: NearbyInteraction | null = d < lz.r ? { kind: 'door', id: 'skydeck-down', title: 'Panoramic Elevator', action: 'Ride Down' } : null
    const s = useCityStore.getState()
    const changed = (near?.id ?? null) !== (this.nearby?.id ?? null)
    this.nearby = near
    if (changed) s.patch({ nearby: near })
  }

  private checkInteriorInteraction() {
    if (!this.currentInterior) return
    const p = this.camera.position
    const e = this.currentInterior.handle.exit
    const d = Math.hypot(e.x - p.x, e.z - p.z)
    let near: NearbyInteraction | null = d < 2.6 ? { kind: 'door', id: 'exit', title: 'Leave', action: 'Exit' } : null
    // in-interior interaction spots (Skylink elevator bank)
    if (!near && this.currentInterior.handle.interactZones) {
      for (const z of this.currentInterior.handle.interactZones) {
        const zd = Math.hypot(z.x - p.x, z.z - p.z)
        if (zd < z.r) {
          near = { kind: 'door', id: z.id, title: z.title, action: z.action }
          break
        }
      }
    }
    const s = useCityStore.getState()
    const changed = (near?.id ?? null) !== (this.nearby?.id ?? null)
    this.nearby = near
    if (changed) s.patch({ nearby: near })
  }

  /* ---------------- guided tour ---------------- */

  private tourStops: TourStop[] = []
  private tourIdx = -1
  private tourTimer = 0

  toggleTour() {
    if (this.tourIdx >= 0) {
      this.endTour()
    } else {
      this.startTour()
    }
  }

  private startTour() {
    if (this.tourStops.length === 0) {
      this.tourStops = buildTourStops(this.plan.stats)
    }
    this.tourIdx = 0
    this.tourTimer = 0
    useCityStore.getState().showToast(tourIntro(this.plan.stats))
    this.applyTourStop(true)
  }

  private endTour() {
    this.tourIdx = -1
    this.tourTimer = 0
    useCityStore.getState().patch({ tour: null })
    useCityStore.getState().showToast('Tour ended — free exploration (Tab for city statistics)')
  }

  private advanceTour() {
    if (this.tourIdx < 0) return
    if (this.tourIdx >= this.tourStops.length - 1) {
      this.endTour()
      return
    }
    this.tourIdx++
    this.applyTourStop(true)
  }

  private applyTourStop(withFade: boolean) {
    const stop = this.tourStops[this.tourIdx]
    if (!stop) return
    this.tourTimer = 0
    const go = () => {
      this.player.teleport(stop.x, stop.z, 0, stop.yaw)
      if (stop.time !== undefined) this.lighting.setTime(stop.time)
      useCityStore.getState().patch({
        tour: { idx: this.tourIdx, total: this.tourStops.length, title: stop.title, body: stop.body, facts: stop.facts },
      })
    }
    if (withFade) {
      useCityStore.getState().patch({ fade: true })
      setTimeout(() => {
        go()
        useCityStore.getState().patch({ fade: false })
      }, 420)
    } else {
      go()
    }
  }

  get minimapCanvas(): HTMLCanvasElement | null {
    return null
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    window.removeEventListener('keydown', this.onKey)
    this.audio?.dispose()
    this.player?.dispose()
    this.renderer?.dispose()
    if (this.renderer?.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
    engineInstance = null
  }
}

let engineInstance: CityEngine | null = null

export function createEngine(container: HTMLElement): CityEngine {
  if (engineInstance) engineInstance.dispose()
  engineInstance = new CityEngine(container)
  return engineInstance
}

export function getEngine(): CityEngine | null {
  return engineInstance
}
