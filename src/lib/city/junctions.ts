import type { CityPlan, ConnPath, LaneSeg } from './types'

/** Two 3m lanes outside the tram bed. The central avenue gains 1m on each
 * side; bike lanes and sidewalks retain their full width and move outwards. */
export const TURN_POCKET_LENGTH = 28
export const TURN_TAPER_LENGTH = 12
export const JUNCTION_SETBACK = 5
export const THROUGH_STOP_STAGGER = 3

export function connector(from: LaneSeg, to: LaneSeg, internal = false): ConnPath {
  const al = Math.hypot(from.x2 - from.x1, from.z2 - from.z1)
  const bl = Math.hypot(to.x2 - to.x1, to.z2 - to.z1)
  const ax = (from.x2 - from.x1) / al, az = (from.z2 - from.z1) / al
  const bx = (to.x2 - to.x1) / bl, bz = (to.z2 - to.z1) / bl
  const straight = ax * bx + az * bz > 0.9
  const span = Math.hypot(to.x1 - from.x2, to.z1 - from.z2)
  const left = ax * bz - az * bx < -0.5
  // Near-side left-turn guides pass opposing left turns on separate arcs.
  // The old long handles pulled both movements through the same centre point.
  const k = internal ? span / 3 : left ? Math.min(6, Math.max(4, span * 0.24)) : Math.min(13, Math.max(4, span * 0.45))
  const pts: { x: number; z: number }[] = []
  const steps = 20
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t
    pts.push({
      x: u ** 3 * from.x2 + 3 * u * u * t * (from.x2 + ax * k) + 3 * u * t * t * (to.x1 - bx * k) + t ** 3 * to.x1,
      z: u ** 3 * from.z2 + 3 * u * u * t * (from.z2 + az * k) + 3 * u * t * t * (to.z1 - bz * k) + t ** 3 * to.z1,
    })
  }
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
  return { pts, cum, len: cum.at(-1)!, straight, internal }
}

/** Give left-turning cars their own storage rather than holding a shared
 * through lane. Departure lanes and the street footprint stay unchanged. */
export function redesignCrossroads(plan: CityPlan, lanes: Map<string, LaneSeg>, paths: Map<string, ConnPath>, turnPockets: boolean) {
  const original = [...lanes.values()]
  for (const lane of original) {
    const signal = plan.trafficLights.find(s => Math.hypot(s.x - lane.x2, s.z - lane.z2) < 14)
    if (!signal) continue
    lane.signalId = signal.id
    const length = Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1)
    const fx = (lane.x2 - lane.x1) / length, fz = (lane.z2 - lane.z1) / length
    // Put the stop bar behind the entire zebra, not inside its stripes.
    lane.x2 -= fx * (JUNCTION_SETBACK - 1.2)
    lane.z2 -= fz * (JUNCTION_SETBACK - 1.2)
    lane.laneWidth = 3
    // Concentrate extra turn storage at the five central crossroads where
    // destination demand accumulates; quiet outer streets stay simpler.
    if (!turnPockets || Math.abs(signal.x) > 200 || Math.abs(signal.z) > 200 || lane.cls !== 'arterial' || length < 65) continue
    const exits = [...lane.next]
    const left = exits.filter(id => {
      const exit = lanes.get(id)!
      return fx * (exit.z2 - exit.z1) - fz * (exit.x2 - exit.x1) < -1
    })
    const through = exits.filter(id => !left.includes(id))
    if (!left.length || !through.length) continue
    const endX = lane.x2, endZ = lane.z2
    const runsX = Math.abs(fx) > 0.5
    const tramStreet = Math.abs(runsX ? signal.z : signal.x) < 0.1
    const baseOffset = tramStreet ? 5 : 2.4
    const offsets = tramStreet ? [4.4, 7.4] : [1.7, 4.7]
    const width = 3
    lane.routeChoices = exits
    lane.signalId = undefined // This is a lane split, not the stop line.
    lane.x2 = endX - fx * (TURN_POCKET_LENGTH + TURN_TAPER_LENGTH)
    lane.z2 = endZ - fz * (TURN_POCKET_LENGTH + TURN_TAPER_LENGTH)
    lane.next = []
    for (let i = 0; i < 2; i++) {
      const role = i === 0 ? 'left' : 'through-right'
      const shift = offsets[i] - baseOffset
      const stagger = i === 1 ? THROUGH_STOP_STAGGER : 0
      const pocket: LaneSeg = {
        ...lane, id: `${lane.id}:${role}`, routeChoices: undefined,
        x1: endX - fx * TURN_POCKET_LENGTH - fz * shift,
        z1: endZ - fz * TURN_POCKET_LENGTH + fx * shift,
        // Leave room for a long left-turning vehicle's tail to swing past a
        // stationary truck in the neighbouring through lane.
        x2: endX - fz * shift - fx * stagger, z2: endZ + fx * shift - fz * stagger,
        next: i === 0 ? left : through, pocket: role,
        approachLane: lane.id, signalId: signal.id, laneWidth: width,
      }
      lanes.set(pocket.id, pocket)
      lane.next.push(pocket.id)
    }
  }
  // Every connection comes from the final geometry, including split tapers.
  paths.clear()
  for (const lane of lanes.values()) for (const next of lane.next) {
    paths.set(`${lane.id}>${next}`, connector(lane, lanes.get(next)!, !!lane.routeChoices))
  }
}
