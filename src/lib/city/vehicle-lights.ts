import * as THREE from 'three'

export interface HeadlampEmitter {
  id: number
  x: number
  z: number
  heading: number
  lamps: readonly THREE.Vector3[]
}

const anchors = new WeakMap<THREE.BufferGeometry, THREE.Vector3[]>()

/** Read the actual left/right lens centres, including authored vehicle shapes. */
export function headlampAnchors(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const cached = anchors.get(geometry)
  if (cached) return cached
  const boxes = [new THREE.Box3(), new THREE.Box3()]
  const point = new THREE.Vector3()
  const positions = geometry.getAttribute('position')
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i)
    boxes[point.x < 0 ? 0 : 1].expandByPoint(point)
  }
  const result = boxes.filter(b => !b.isEmpty()).map(b => b.getCenter(new THREE.Vector3()))
  anchors.set(geometry, result)
  return result
}

/** A bounded pool illuminates the road near two nearby cars. Lens geometry is
 * always rendered for the full fleet; no shadow maps or per-car light objects. */
export class VehicleLightRig {
  readonly group = new THREE.Group()
  private pairs = Array.from({ length: 2 }, () => ({
    id: -1,
    lamps: Array.from({ length: 2 }, () => {
      const light = new THREE.SpotLight('#fff0d2', 0, 32, .37, .65, 2)
      light.castShadow = false
      return light
    }),
  }))

  constructor() {
    this.group.name = 'Pooled vehicle headlight beams'
    for (const pair of this.pairs) for (const light of pair.lamps) this.group.add(light, light.target)
  }

  update(emitters: HeadlampEmitter[], viewer: THREE.Vector3, night: number, maxPairs = 2) {
    const brightness = THREE.MathUtils.smoothstep(night, .05, .4)
    this.group.visible = brightness > 0 && maxPairs > 0
    const previous = new Set(this.pairs.map(p => p.id))
    const nearby = brightness > 0 ? emitters
      .map(e => ({ emitter: e, distance: Math.hypot(e.x - viewer.x, e.z - viewer.z) }))
      .filter(e => e.distance < 55)
      .sort((a, b) => (a.distance - (previous.has(a.emitter.id) ? 8 : 0)) - (b.distance - (previous.has(b.emitter.id) ? 8 : 0)))
      .slice(0, Math.min(maxPairs, this.pairs.length)) : []
    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i]
      const selected = nearby[i]
      pair.id = selected?.emitter.id ?? -1
      for (let side = 0; side < pair.lamps.length; side++) {
        const light = pair.lamps[side]
        const emitter = selected?.emitter
        const lamp = emitter?.lamps[side]
        light.visible = !!emitter && !!lamp
        if (!emitter || !lamp) { light.intensity = 0; continue }
        const sin = Math.sin(emitter.heading), cos = Math.cos(emitter.heading)
        light.position.set(emitter.x + cos * lamp.x + sin * (lamp.z + .04), lamp.y,
          emitter.z - sin * lamp.x + cos * (lamp.z + .04))
        light.target.position.set(light.position.x + sin * 12, .06, light.position.z + cos * 12)
        // Fade at the pool boundary rather than popping a full-bright beam.
        light.intensity = 180 * brightness * (1 - THREE.MathUtils.smoothstep(selected.distance, 38, 55))
      }
    }
    this.group.updateMatrixWorld(true)
  }
}
