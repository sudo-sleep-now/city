import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { CITY, DAY_LENGTH_SEC, START_HOUR } from './constants'
import { planCity } from './planner'
import { loadCityModels } from './models'
import { createMaterials, getSpecialFacadeMaterials } from './materials'
import { buildRoadNetwork, createRoadMeshes } from './roads'
import { createBuildings, skyDeck, type BuildingsResult } from './buildings'
import { createEnvironment, type EnvironmentResult } from './environment'
import { TrafficSystem } from './traffic'
import { VehicleLightRig } from './vehicle-lights'
import type { TrafficConfig } from './traffic-config'
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
import { AdaptiveQuality, initialQuality, isQualityMode, QUALITY_SETTINGS, renderPixelRatio, type QualityLevel, type QualityMode } from './render-quality'
import { SpatialBatches } from './spatial-batches'
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
  private vehicleLights!: VehicleLightRig
  private lightingHour: number | null = null
  private nightLightTimer = 0
  private ready = false
  private disposed = false
  private quality: QualityLevel = 'balanced'
  private automaticQuality!: AdaptiveQuality
  private deviceQuality: QualityLevel = 'balanced'
  private staticBatches = new SpatialBatches()
  private visibilityTimer = 0
  private shadowTimer = 0
  private wasHidden = false

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
    this.deviceQuality = initialQuality({ cores: navigator.hardwareConcurrency, memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory, touch: isTouch })
    let mode: QualityMode = 'auto'
    try { const saved = localStorage.getItem('solheim-graphics'); if (isQualityMode(saved)) mode = saved } catch { /* Storage can be disabled. */ }
    this.quality = mode === 'auto' ? this.deviceQuality : mode
    this.automaticQuality = new AdaptiveQuality(this.deviceQuality, this.deviceQuality)
    store.patch({ graphicsMode: mode, graphicsLevel: this.quality })
    // logarithmicDepthBuffer: uniform z-precision from 0.1 m to 1600 m.
    // Without it the 24-bit depth buffer starves beyond ~250 m and every
    // facade decal (windows, bands, trim at +2..9 cm) z-fights — the
    // "flashing overlapping parts / floating blocks on buildings" reports.
    this.renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance', logarithmicDepthBuffer: true })
    this.renderer.setPixelRatio(renderPixelRatio(this.quality, this.container.clientWidth, this.container.clientHeight, window.devicePixelRatio))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.shadowMap.enabled = QUALITY_SETTINGS[this.quality].shadows
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.type = THREE.PCFShadowMap
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
    this.applyGraphicsQuality()
    this.lighting.setTime(START_HOUR)

    await step(0.15)
    const mats = createMaterials()
    this.mats = mats
    const models = await loadCityModels()
    if (this.disposed) return

    await step(0.3)
    const network = buildRoadNetwork(this.plan)
    const roadGroup = createRoadMeshes(this.plan, mats, network)
    this.scene.add(roadGroup)

    await step(0.45)
    this.buildings = createBuildings(this.plan, mats, models)
    this.scene.add(this.buildings.group)

    await step(0.65)
    this.env = createEnvironment(this.plan, mats, models)
    this.scene.add(this.env.group)
    this.staticBatches.add(roadGroup)
    this.staticBatches.add(this.buildings.group)
    this.staticBatches.add(this.env.group)

    await step(0.72)
    this.weather = new WeatherSystem(this.scene, this.plan, mats, this.env.puddleSpots)

    await step(0.8)
    this.traffic = new TrafficSystem(this.plan, network, mats, models)
    this.vehicleLights = new VehicleLightRig()
    this.scene.add(this.vehicleLights.group)
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
    this.player.enabled = true
    this.player.onInteract = () => this.interact()
    this.player.onLockError = () => useCityStore.getState().showToast('Mouse capture is unavailable here. Use T or the site-visit buttons to explore.')
    this.player.onToggleTour = (reverse) => {
      const s = useCityStore.getState()
      if (!s.started || s.showStats || s.showTrafficLab || s.activePoi || s.insideId || this.onDeck) return
      if (reverse && this.tourIdx >= 0) this.previousTourStop()
      else this.toggleTour()
    }
    this.player.onToggleStats = () => {
      const s = useCityStore.getState()
      if (s.started && !s.activePoi && !s.showTrafficLab) {
        s.toggleStats()
        if (useCityStore.getState().showStats) this.player.enabled = false
        else this.player.enabled = true
      }
    }

    window.addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
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
    this.renderer.setPixelRatio(renderPixelRatio(this.quality, w, h, window.devicePixelRatio))
    this.automaticQuality?.reset(this.quality)
  }

  private onVisibilityChange = () => {
    // Resume from the present rather than simulating minutes of missed frames.
    this.lastT = performance.now()
    this.trafficAccumulator = 0
    this.fpsAcc = this.fpsFrames = 0
    this.automaticQuality?.reset(this.quality)
  }

  setGraphicsMode(mode: QualityMode) {
    if (!isQualityMode(mode)) return
    this.quality = mode === 'auto' ? this.deviceQuality : mode
    this.automaticQuality.reset(this.quality)
    try { localStorage.setItem('solheim-graphics', mode) } catch { /* Optional preference. */ }
    useCityStore.getState().patch({ graphicsMode: mode, graphicsLevel: this.quality })
    this.applyGraphicsQuality()
  }

  private applyGraphicsQuality() {
    const settings = QUALITY_SETTINGS[this.quality]
    this.renderer.setPixelRatio(renderPixelRatio(this.quality, this.container.clientWidth, this.container.clientHeight, window.devicePixelRatio))
    if (this.renderer.shadowMap.enabled !== settings.shadows) {
      this.renderer.shadowMap.enabled = settings.shadows
      // Shadow defines are compiled per material; refresh after changing mode.
      this.scene?.traverse(node => {
        const mesh = node as THREE.Mesh
        if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.needsUpdate = true
      })
    }
    if (this.lighting) {
      const shadow = this.lighting.sun.shadow
      if (shadow.mapSize.x !== settings.shadowSize) {
        shadow.map?.dispose()
        shadow.map = null
        shadow.mapSize.set(settings.shadowSize, settings.shadowSize)
      }
      this.lighting.viewDistance = settings.distance
    }
    this.shadowTimer = this.visibilityTimer = this.nightLightTimer = 0
    this.renderer.shadowMap.needsUpdate = true
  }

  private onPointerLockChange = () => {
    const s = useCityStore.getState()
    if (!s.started || s.insideId || s.showStats || s.showTrafficLab || s.activePoi) return
    if (!document.pointerLockElement) {
      s.patch({ paused: true })
    } else {
      s.patch({ paused: false })
    }
  }

  requestStart(guided = false, captureMouse = true) {
    const s = useCityStore.getState()
    s.patch({ started: true, paused: false })
    this.audio.start() // inside the user gesture — browsers allow audio now
    if (s.classroomMode && !s.muted) this.toggleMute()
    if (guided) this.startTour()
    else if (captureMouse) {
      this.player.requestLock()
      s.showToast(this.player.isTouch ? 'Welcome to Solheim — left thumb walks, right thumb looks' : 'Solheim 2050 pilot district — T starts the site visit')
    }
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape' && useCityStore.getState().showTrafficLab) { this.toggleTrafficLab(); return }
    const target = e.target as HTMLElement | null
    if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
    if (e.code === 'KeyP' && !e.repeat && useCityStore.getState().started) {
      e.preventDefault()
      this.toggleTrafficLab()
      return
    }
    if (e.code === 'Escape' && useCityStore.getState().showTrafficLab) {
      this.toggleTrafficLab()
      return
    }
    if (e.code === 'KeyQ' && useCityStore.getState().started && this.tourIdx >= 0) this.endTour()
    if (e.key === 'm' || e.key === 'M') {
      const s = useCityStore.getState()
      if (!s.started) return
      this.toggleMute()
    }
  }

  toggleDayNight() {
    this.lightingHour = this.lighting.nightFactor() > .5 ? 10 : 22
    this.lighting.setTime(this.lightingHour)
    useCityStore.getState().patch({ clock: this.lightingHour })
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
    if (useCityStore.getState().showTrafficLab) this.toggleTrafficLab()
    useCityStore.getState().patch({ paused: false, showStats: false, activePoi: null })
    this.player.enabled = true
    this.player.requestLock()
  }

  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    const frameSeconds = (now - this.lastT) / 1000
    let dt = frameSeconds
    this.lastT = now
    if (document.hidden) { this.wasHidden = true; return }
    if (this.wasHidden) { this.wasHidden = false; this.onVisibilityChange(); return }
    if (dt > 0.15) dt = 0.15

    const s = useCityStore.getState()
    if (s.graphicsMode === 'auto' && s.started && !s.fade) {
      const next = this.automaticQuality.sample(frameSeconds)
      if (next) {
        this.quality = next
        s.patch({ graphicsLevel: next })
        this.applyGraphicsQuality()
      }
    }
    const quality = QUALITY_SETTINGS[this.quality]
    const active = s.started && !s.paused && !s.showStats && !s.showTrafficLab && !s.activePoi

    // time of day always advances (also while paused → alive background)
    if (this.lightingHour !== null) this.lighting.setTime(this.lightingHour)
    else if (s.classroomMode) this.lighting.setTime(10)
    else this.lighting.advance(dt, DAY_LENGTH_SEC)

    if (active && this.player) {
      this.player.update(dt)
    }

    const night = this.lighting.nightFactor()
    this.playerPosV.set(this.player.pos.x, 0, this.player.pos.z)
    this.lighting.update(this.playerPosV)
    // weather dims the rig after lighting.update re-applies base intensities
    this.weather.group.visible = !s.classroomMode
    const wx = s.classroomMode ? { cloud: 0, rain: 0 } : this.weather.update(dt, this.playerPosV)
    this.lighting.sun.intensity *= 1 - 0.78 * wx.cloud
    this.lighting.hemi.intensity *= 1 - 0.45 * wx.cloud
    this.lighting.ambient.intensity *= 1 - 0.25 * wx.cloud
    this.lighting.applyWeather(wx.cloud, wx.rain)
    // District views and the rooftop deck need the full skyline in every mode.
    const overview = s.showTrafficLab && s.trafficView !== 'street' || this.onDeck
    this.lighting.viewDistance = overview ? 1600 : quality.distance
    this.lighting.limitFogDistance()
    this.visibilityTimer -= dt
    if (this.visibilityTimer <= 0) {
      this.staticBatches.update(this.camera.position, overview ? Infinity : quality.distance)
      this.visibilityTimer = .15
    }
    this.shadowTimer -= dt
    // No invisible sun shadow pass at night; smaller cached maps on laptops.
    this.renderer.shadowMap.needsUpdate = quality.shadows && night < .95 && this.shadowTimer <= 0
    if (this.renderer.shadowMap.needsUpdate) this.shadowTimer = 1 / quality.shadowHz
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
      // Fixed simulation steps keep comparisons and car-following stable at
      // different frame rates. The experiment can be paused independently.
      if (s.started && !s.trafficPaused) {
        this.trafficAccumulator += dt * s.trafficSpeed
        while (this.trafficAccumulator >= 1 / 60) {
          this.traffic.update(1 / 60, this.playerPosV, night, this.trafficAccumulator < 2 / 60)
          this.peds.update(1 / 60, this.playerPosV, night, wx.rain)
          this.cyclists.update(1 / 60, this.playerPosV, night)
          this.trafficAccumulator -= 1 / 60
        }
      }
      this.trafficReadTimer += dt
      if (this.trafficReadTimer > 0.5) {
        this.trafficReadTimer = 0
        s.patch({ trafficMetrics: this.traffic.getMetrics() })
      }
      this.birds.update(performance.now() / 1000, this.playerPosV, night, wx.rain)
      this.emergency.group.visible = !s.classroomMode
      const sirenLevel = s.classroomMode ? 0 : this.emergency.update(dt, this.playerPosV)
      this.audio.update(dt, { rain: wx.rain, night, inside: !!this.currentInterior, siren: sirenLevel })
      this.updateNightLights(dt, night)
      this.traffic.updateLightAppearance(night)
      this.vehicleLights.update(night > .05 && quality.headlightPairs > 0 ? this.traffic.getHeadlampEmitters() : [], this.camera.position, night, quality.headlightPairs)
      this.env.animated?.(performance.now() / 1000)
      // Site visits advance manually so a speaker never loses their place.
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
    this.fpsAcc += frameSeconds
    this.fpsFrames++
    if (this.fpsAcc > 1) {
      s.patch({ fps: Math.round(this.fpsFrames / this.fpsAcc), renderStats: {
        calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, pixelRatio: this.renderer.getPixelRatio(),
      } })
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

  private trafficAccumulator = 0
  private trafficReadTimer = 0
  private savedTrafficCamera: { position: THREE.Vector3; quaternion: THREE.Quaternion; up: THREE.Vector3; far: number } | null = null

  startTrafficLab() {
    this.requestStart(false, false)
    this.toggleTrafficLab()
  }

  toggleTrafficLab() {
    const s = useCityStore.getState()
    if (s.showTrafficLab) {
      if (this.savedTrafficCamera) {
        this.camera.position.copy(this.savedTrafficCamera.position)
        this.camera.quaternion.copy(this.savedTrafficCamera.quaternion)
        this.camera.up.copy(this.savedTrafficCamera.up)
        this.camera.far = this.savedTrafficCamera.far
        this.camera.updateProjectionMatrix()
      }
      this.savedTrafficCamera = null
      s.patch({ showTrafficLab: false, paused: false })
      this.player.enabled = true
      return
    }
    if (!s.started || s.insideId || this.onDeck || this.tourTransition) return
    this.savedTrafficCamera = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), up: this.camera.up.clone(), far: this.camera.far }
    s.patch({ showTrafficLab: true, showStats: false, activePoi: null, paused: false })
    this.player.enabled = false
    if (document.pointerLockElement) document.exitPointerLock()
    this.setTrafficView(s.trafficView)
  }

  configureTraffic(config: TrafficConfig) {
    this.traffic.configure(config)
    this.trafficAccumulator = 0
    useCityStore.getState().patch({ trafficConfig: this.traffic.getConfig(), trafficMetrics: this.traffic.getMetrics() })
  }

  setTrafficPaused(paused: boolean) {
    useCityStore.getState().patch({ trafficPaused: paused })
  }

  setTrafficSpeed(speed: 1 | 2 | 4) {
    useCityStore.getState().patch({ trafficSpeed: speed })
  }

  setTrafficView(view: 'street' | 'junction' | 'district') {
    useCityStore.getState().patch({ trafficView: view })
    if (!this.savedTrafficCamera) return
    this.camera.far = 2400
    this.camera.up.set(0, 1, 0)
    if (view === 'street') {
      this.camera.position.copy(this.savedTrafficCamera.position)
      this.camera.quaternion.copy(this.savedTrafficCamera.quaternion)
    } else if (view === 'junction') {
      this.camera.position.set(30, 140, 0)
      this.camera.up.set(0, 0, -1)
      this.camera.lookAt(30, 0, 0)
    } else {
      this.camera.position.set(0, 760, 640)
      this.camera.lookAt(0, 0, 0)
    }
    this.camera.updateProjectionMatrix()
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
    const limit = QUALITY_SETTINGS[this.quality].streetLights
    for (const v of this.env.streetLights) {
      const d2 = (v.x - p.x) ** 2 + (v.z - p.z) ** 2
      if (d2 < 140 * 140) cands.push({ d2, v })
    }
    cands.sort((a, b) => a.d2 - b.d2)
    for (let i = 0; i < this.nightLights.length; i++) {
      const l = this.nightLights[i]
      if (i < Math.min(limit, cands.length)) {
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
    if (!s.started || s.showTrafficLab) return
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
  private tourTransition = false

  toggleTour() {
    if (this.tourTransition) return
    if (this.tourIdx >= 0) {
      this.advanceTour()
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

  endTour() {
    this.tourIdx = -1
    this.tourTimer = 0
    useCityStore.getState().patch({ tour: null, fade: false })
    useCityStore.getState().showToast('Tour ended — free exploration (Tab for city statistics)')
  }

  previousTourStop() {
    if (this.tourTransition) return
    if (this.tourIdx <= 0) return
    this.tourIdx--
    this.applyTourStop(true)
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
      this.player.pitch = stop.pitch ?? 0
      if (stop.time !== undefined) this.lighting.setTime(stop.time)
      useCityStore.getState().patch({
        tour: { idx: this.tourIdx, total: this.tourStops.length, title: stop.title, body: stop.body, facts: stop.facts },
      })
    }
    if (withFade) {
      this.tourTransition = true
      useCityStore.getState().patch({ fade: true })
      setTimeout(() => {
        if (this.disposed || this.tourIdx < 0) {
          this.tourTransition = false
          useCityStore.getState().patch({ fade: false })
          return
        }
        go()
        this.tourTransition = false
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
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
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
