import * as THREE from 'three'

/* ============================================================
 * LightingRig — sun/moon directional light, sky dome shader,
 * fog, stars, ambient/hemisphere fill, day-night cycle.
 * ============================================================ */

const SKY_VERT = `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const SKY_FRAG = `
uniform vec3 uTopColor;
uniform vec3 uHorizonColor;
uniform float uExponent;
varying vec3 vWorldPos;
void main() {
  float h = normalize(vWorldPos).y;
  float f = pow(max(h, 0.0), uExponent);
  vec3 col = mix(uHorizonColor, uTopColor, f);
  // warm glow band near horizon at sunrise/sunset (handled via uniforms)
  gl_FragColor = vec4(col, 1.0);
}
`

export class LightingRig {
  sun: THREE.DirectionalLight
  moon: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  ambient: THREE.AmbientLight
  sky: THREE.Mesh
  stars: THREE.Points
  scene: THREE.Scene
  private sceneFog: THREE.Fog
  private clock = 9.5 // hours
  private skyMat: THREE.ShaderMaterial
  private sunMesh: THREE.Mesh
  private shadowRight = new THREE.Vector3()
  private shadowUp = new THREE.Vector3()
  private shadowCenter = new THREE.Vector3()
  viewDistance = 1600

  constructor(scene: THREE.Scene) {
    this.scene = scene

    this.sceneFog = new THREE.Fog(0xcfe0e8, 220, 900)
    scene.fog = this.sceneFog

    this.hemi = new THREE.HemisphereLight(0xd8e8f0, 0x8a9070, 0.55)
    scene.add(this.hemi)

    this.ambient = new THREE.AmbientLight(0xffffff, 0.18)
    scene.add(this.ambient)

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.near = 10
    this.sun.shadow.camera.far = 500
    this.sun.shadow.camera.left = -110
    this.sun.shadow.camera.right = 110
    this.sun.shadow.camera.top = 110
    this.sun.shadow.camera.bottom = -110
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.4
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.moon = new THREE.DirectionalLight(0xb8c4d0, 0.0)
    scene.add(this.moon)
    scene.add(this.moon.target)

    // sky dome
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uTopColor: { value: new THREE.Color(0x7ab8d8) },
        uHorizonColor: { value: new THREE.Color(0xe8f0ea) },
        uExponent: { value: 0.8 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 24, 12), this.skyMat)
    this.sky.frustumCulled = false
    scene.add(this.sky)

    // sun disc
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(26, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff3c0, fog: false, toneMapped: false }),
    )
    scene.add(this.sunMesh)

    // stars
    const starGeo = new THREE.BufferGeometry()
    const N = 900
    const pos = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1200)
      v.y = Math.abs(v.y) * 0.9 + 60
      pos.set([v.x, v.y, v.z], i * 3)
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }))
    this.stars.frustumCulled = false
    scene.add(this.stars)
  }

  get time() {
    return this.clock
  }

  setTime(h: number) {
    this.clock = ((h % 24) + 24) % 24
  }

  advance(dt: number, dayLengthSec: number) {
    this.clock = (this.clock + (24 * dt) / dayLengthSec) % 24
  }

  /** Position sun/shadows relative to player each frame. */
  update(playerPos: THREE.Vector3) {
    const t = this.clock
    // sun angle: 6:00 sunrise → 18:00 sunset
    const dayT = (t - 6) / 12 // 0..1 across daytime
    const ang = dayT * Math.PI // 0..π
    const sunDir = new THREE.Vector3(Math.cos(ang) * 0.55, Math.sin(ang), 0.4).normalize()

    const dayness = Math.max(0, Math.min(1, Math.sin(ang) * 1.6)) // 0 night, 1 noon
    const dusk = Math.max(0, 1 - Math.abs(Math.sin(ang)) * 2.2) // sunrise/sunset factor

    // Snap the moving shadow frustum in light space. Following the camera at
    // sub-texel increments makes shadow edges crawl across otherwise stable
    // road and facade surfaces, especially at shallow viewing angles.
    this.shadowRight.set(sunDir.z, 0, -sunDir.x).normalize()
    this.shadowUp.crossVectors(sunDir, this.shadowRight).normalize()
    this.shadowCenter.copy(playerPos)
    const shadowCamera = this.sun.shadow.camera
    const texelX = (shadowCamera.right - shadowCamera.left) / this.sun.shadow.mapSize.x
    const texelY = (shadowCamera.top - shadowCamera.bottom) / this.sun.shadow.mapSize.y
    const x = playerPos.dot(this.shadowRight), y = playerPos.dot(this.shadowUp)
    this.shadowCenter.addScaledVector(this.shadowRight, Math.round(x / texelX) * texelX - x)
    this.shadowCenter.addScaledVector(this.shadowUp, Math.round(y / texelY) * texelY - y)
    this.sun.position.copy(this.shadowCenter).addScaledVector(sunDir, 260)
    this.sun.target.position.copy(this.shadowCenter)
    this.sun.intensity = 2.6 * dayness
    this.sun.color.setHSL(0.09 + 0.04 * dayness, 0.5 - 0.35 * dayness + 0.3 * dusk, 0.55 + 0.1 * dayness)

    // moon roughly opposite
    this.moon.position.copy(playerPos).addScaledVector(sunDir, -260)
    this.moon.target.position.copy(playerPos)
    this.moon.intensity = 0.22 * (1 - dayness)

    this.hemi.intensity = 0.12 + 0.45 * dayness
    this.ambient.intensity = 0.06 + 0.14 * dayness

    // sky colors
    const top = new THREE.Color(0x0a1020).lerp(new THREE.Color(0x69aede), dayness)
    const horizon = new THREE.Color(0x141a26).lerp(new THREE.Color(0xdfeef2), dayness)
    horizon.lerp(new THREE.Color(0xf2a45c), dusk * 0.55)
    top.lerp(new THREE.Color(0x8a5a6a), dusk * 0.3)
    this.skyMat.uniforms.uTopColor.value.copy(top)
    this.skyMat.uniforms.uHorizonColor.value.copy(horizon)

    this.sky.position.copy(playerPos)
    this.sunMesh.position.copy(playerPos).addScaledVector(sunDir, 1100)
    this.sunMesh.visible = dayness > 0.02
    ;(this.stars.material as THREE.PointsMaterial).opacity = (1 - dayness) * 0.85
    this.stars.position.copy(playerPos)

    // fog matches sky
    this.sceneFog.color.copy(horizon).lerp(top, 0.25)
    this.sceneFog.near = 200 + dayness * 100
    this.sceneFog.far = 700 + dayness * 500
    this.limitFogDistance()
  }

  /** Fully fade geometry before distance culling removes its neighbourhood. */
  limitFogDistance() {
    this.sceneFog.far = Math.min(this.sceneFog.far, this.viewDistance)
    this.sceneFog.near = Math.min(this.sceneFog.near, this.sceneFog.far * .45)
  }

  /** 0 at noon → 1 at deep night, for streetlight/window emissive. */
  nightFactor(): number {
    const t = this.clock
    const dayT = (t - 6) / 12
    const dayness = Math.max(0, Math.min(1, Math.sin(dayT * Math.PI) * 1.6))
    return 1 - dayness
  }

  /** tint the sky dome gray for clouds/rain — call AFTER update() each frame
   *  (update() resets the uniform colors from the clock) */
  private _wGray = new THREE.Color(0x8d979b)
  private _wHor = new THREE.Color(0xb9bfc1)
  applyWeather(cloud: number, rain: number) {
    const k = Math.max(cloud, rain * 0.92)
    if (k <= 0.001) return
    const uTop = this.skyMat.uniforms.uTopColor.value as THREE.Color
    const uHor = this.skyMat.uniforms.uHorizonColor.value as THREE.Color
    uTop.lerp(this._wGray, k)
    uHor.lerp(this._wHor, k)
    // clouds hide the stars
    ;(this.stars.material as THREE.PointsMaterial).opacity *= 1 - k
  }
}
