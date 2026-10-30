import * as THREE from 'three'
import { PLAYER } from './constants'
import type { AABB } from './types'

/* ============================================================
 * First-person controller: WASD + mouse look, gravity, jump,
 * sprint, crouch, AABB collision, city bounds clamp.
 * ============================================================ */

export interface InputState {
  f: boolean
  b: boolean
  l: boolean
  r: boolean
  jump: boolean
  sprint: boolean
  crouch: boolean
}

export class FirstPersonController {
  camera: THREE.PerspectiveCamera
  yaw = 0
  pitch = 0
  pos = new THREE.Vector3(0, 0, 0)
  velY = 0
  grounded = true
  crouching = false
  /** current ground height — 0 outdoors, deck/interior height when teleported
   *  onto elevated surfaces (sky deck). Gravity lands on THIS, not on 0. */
  floorY = 0
  /** touch devices: pointer lock is unavailable — input comes from the HUD */
  readonly isTouch = typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0)
  /** when inside an interior, collide against these instead of the city AABBs */
  collidersOverride: { minX: number; maxX: number; minZ: number; maxZ: number }[] | null = null
  private bounds: number
  private colliders: AABB[]
  private domElement: HTMLElement
  private keys = new Set<string>()
  input: InputState = { f: false, b: false, l: false, r: false, jump: false, sprint: false, crouch: false }
  /** analog joystick axes (−1..1) — take precedence over the digital flags */
  touchAxes = { x: 0, z: 0 }
  onLockError?: () => void
  onInteract?: () => void
  onToggleStats?: () => void
  onToggleTour?: (reverse: boolean) => void
  enabled = false

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement, colliders: AABB[], bounds: number, spawn: { x: number; z: number }) {
    this.camera = camera
    this.domElement = domElement
    this.colliders = colliders
    this.bounds = bounds
    this.pos.set(spawn.x, 0, spawn.z)
    this.yaw = 0 // face north (-Z) toward Central Station
    this.camera.rotation.order = 'YXZ'

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('mousemove', this.onMouseMove)
    domElement.addEventListener('click', this.requestLock)
    if (this.isTouch) domElement.addEventListener('touchstart', this.onTouchStart, { passive: false })
    if (this.isTouch) domElement.addEventListener('touchmove', this.onTouchMove, { passive: false })
    if (this.isTouch) domElement.addEventListener('touchend', this.onTouchEnd)
    if (this.isTouch) domElement.addEventListener('touchcancel', this.onTouchEnd)
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('mousemove', this.onMouseMove)
    this.domElement.removeEventListener('click', this.requestLock)
    this.domElement.removeEventListener('touchstart', this.onTouchStart)
    this.domElement.removeEventListener('touchmove', this.onTouchMove)
    this.domElement.removeEventListener('touchend', this.onTouchEnd)
    this.domElement.removeEventListener('touchcancel', this.onTouchEnd)
  }

  requestLock = () => {
    if (!this.enabled || this.isTouch) return
    if (document.pointerLockElement !== this.domElement) {
      this.domElement.requestPointerLock()?.catch(() => this.onLockError?.())
    }
  }

  get locked() {
    return this.isTouch || document.pointerLockElement === this.domElement
  }

  /* ---------------- touch: look + virtual joystick ---------------- */
  private lookTouchId: number | null = null
  private moveTouchId: number | null = null
  private moveOrigin = { x: 0, z: 0 }
  private lastLook = { x: 0, y: 0 }

  private onTouchStart = (e: TouchEvent) => {
    if (!this.enabled) return
    e.preventDefault()
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < window.innerWidth * 0.42 && this.moveTouchId === null) {
        // left side → joystick
        this.moveTouchId = t.identifier
        this.moveOrigin = { x: t.clientX, z: t.clientY }
      } else if (this.lookTouchId === null) {
        // right side → camera look
        this.lookTouchId = t.identifier
        this.lastLook = { x: t.clientX, y: t.clientY }
      }
    }
  }

  private onTouchMove = (e: TouchEvent) => {
    if (!this.enabled) return
    e.preventDefault()
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveTouchId) {
        const dx = t.clientX - this.moveOrigin.x
        const dy = t.clientY - this.moveOrigin.z
        const max = 52
        this.touchAxes.x = Math.max(-1, Math.min(1, dx / max))
        this.touchAxes.z = Math.max(-1, Math.min(1, dy / max))
      } else if (t.identifier === this.lookTouchId) {
        const dx = t.clientX - this.lastLook.x
        const dy = t.clientY - this.lastLook.y
        this.lastLook = { x: t.clientX, y: t.clientY }
        this.yaw -= dx * 0.0042
        this.pitch -= dy * 0.0042
        const lim = Math.PI / 2 - 0.02
        this.pitch = Math.max(-lim, Math.min(lim, this.pitch))
      }
    }
  }

  private onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveTouchId) {
        this.moveTouchId = null
        this.touchAxes.x = 0
        this.touchAxes.z = 0
      }
      if (t.identifier === this.lookTouchId) this.lookTouchId = null
    }
  }

  /** HUD buttons for touch devices */
  fireJump() {
    if (this.grounded) {
      this.input.jump = true
      setTimeout(() => (this.input.jump = false), 120)
    }
  }

  fireInteract() {
    this.onInteract?.()
  }

  setSprint(on: boolean) {
    this.input.sprint = on
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Tab') {
      e.preventDefault()
      this.onToggleStats?.()
      return
    }
    if (e.code === 'KeyE') {
      this.onInteract?.()
      return
    }
    if (e.code === 'KeyT') {
      if (!e.repeat) this.onToggleTour?.(e.shiftKey)
      return
    }
    this.keys.add(e.code)
    this.syncInput()
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
    this.syncInput()
  }

  private syncInput() {
    this.input.f = this.keys.has('KeyW') || this.keys.has('ArrowUp')
    this.input.b = this.keys.has('KeyS') || this.keys.has('ArrowDown')
    this.input.l = this.keys.has('KeyA') || this.keys.has('ArrowLeft')
    this.input.r = this.keys.has('KeyD') || this.keys.has('ArrowRight')
    this.input.jump = this.keys.has('Space')
    this.input.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    this.input.crouch = this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC')
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    const s = 0.0022
    this.yaw -= e.movementX * s
    this.pitch -= e.movementY * s
    const lim = Math.PI / 2 - 0.02
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch))
  }

  /** Try to move pos by (dx,dz), resolving against AABBs with a simple slide. */
  private collideMove(dx: number, dz: number, radius: number) {
    // X axis
    let nx = this.pos.x + dx
    if (!this.hitsAny(nx, this.pos.z, radius)) {
      this.pos.x = nx
    } else {
      // try stepped slide
      nx = this.pos.x + dx * 0.25
      if (!this.hitsAny(nx, this.pos.z, radius)) this.pos.x = nx
    }
    // Z axis
    let nz = this.pos.z + dz
    if (!this.hitsAny(this.pos.x, nz, radius)) {
      this.pos.z = nz
    } else {
      nz = this.pos.z + dz * 0.25
      if (!this.hitsAny(this.pos.x, nz, radius)) this.pos.z = nz
    }
    // bounds (only outdoors) — allow walking right up to the visible
    // barrier wall at ±612 so the edge never feels like an invisible wall
    if (!this.collidersOverride) {
      const lim = this.bounds + 11.2
      this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x))
      this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z))
    }
  }

  private hitsAny(x: number, z: number, radius: number): boolean {
    if (this.collidersOverride) {
      for (const c of this.collidersOverride) {
        if (x + radius > c.minX && x - radius < c.maxX && z + radius > c.minZ && z - radius < c.maxZ) return true
      }
      return false
    }
    for (const c of this.colliders) {
      if (x + radius > c.minX && x - radius < c.maxX && z + radius > c.minZ && z - radius < c.maxZ) {
        return true
      }
    }
    return false
  }

  update(dt: number) {
    const input = this.input
    this.crouching = input.crouch && this.grounded

    // direction in world space — analog joystick first, then keys
    let mx = 0
    let mz = 0
    if (Math.abs(this.touchAxes.x) > 0.08 || Math.abs(this.touchAxes.z) > 0.08) {
      mx = this.touchAxes.x
      mz = this.touchAxes.z
    } else {
      if (input.f) mz -= 1
      if (input.b) mz += 1
      if (input.l) mx -= 1
      if (input.r) mx += 1
    }
    const len = Math.hypot(mx, mz)
    let moving = false
    if (len > 0.001 && this.enabled) {
      moving = true
      const clamped = Math.min(1, len)
      mx = (mx / len) * clamped
      mz = (mz / len) * clamped
      const sin = Math.sin(this.yaw)
      const cos = Math.cos(this.yaw)
      // rotate movement by yaw (camera looks down -Z when yaw=0)
      const wx = mx * cos + mz * sin
      const wz = -mx * sin + mz * cos
      const speed = (this.crouching ? PLAYER.crouchSpeed : input.sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * (0.45 + 0.55 * clamped)
      this.collideMove(wx * speed * dt, wz * speed * dt, PLAYER.radius)
    }

    // gravity & jump
    if (this.grounded && input.jump && !this.crouching) {
      this.velY = PLAYER.jumpVel
      this.grounded = false
    }
    if (!this.grounded) {
      this.velY -= PLAYER.gravity * dt
      this.pos.y += this.velY * dt
      if (this.pos.y <= this.floorY) {
        this.pos.y = this.floorY
        this.velY = 0
        this.grounded = true
      }
    }

    // camera
    const targetH = this.crouching ? PLAYER.crouchHeight : PLAYER.height
    this.pos.y = Math.max(this.pos.y, this.floorY)
    const eyeY = this.pos.y + targetH - PLAYER.eyeOffset
    this.camera.position.set(this.pos.x, eyeY, this.pos.z)
    this.camera.rotation.y = this.yaw
    this.camera.rotation.x = this.pitch
    // subtle head bob while walking
    if (moving && this.grounded) {
      const t = performance.now() * 0.011
      this.camera.position.y += Math.sin(t) * 0.035
      this.camera.rotation.z = Math.sin(t * 0.5) * 0.003
    } else {
      this.camera.rotation.z = 0
    }
  }

  teleport(x: number, z: number, y = 0, yaw?: number) {
    this.pos.set(x, y, z)
    if (yaw !== undefined) this.yaw = yaw
    this.velY = 0
    this.grounded = true
    this.floorY = y
    this.camera.position.set(x, y + PLAYER.height - PLAYER.eyeOffset, z)
  }
}
