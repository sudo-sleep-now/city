import type { ConnPath, LaneSeg, RoadNetworkData } from './types'

type Vehicle = { segId: string; dist: number; speed: number; stuck: number; typeIdx: number; conn: ConnPath | null; connNext: string; plannedNext: string | null; afterPocket: string | null }
type Edge = { lane: string; from: string; to: string; seconds: number; storage: number }
type Load = { cars: number; stopped: number; slow: number; metres: number; wait: number }
const node = (x: number, z: number) => `${Math.round(x / 100) * 100},${Math.round(z / 100) * 100}`

/** Persistent junction destinations with travel-time and live-queue routing.
 * A destination changes only after a car actually crosses that junction. */
export class TrafficRouter {
  readonly core = '0,0'
  readonly homes: string[]
  readonly destinations: string[]
  readonly central: string[]
  private edges = new Map<string, Edge>()
  private reverse = new Map<string, Edge[]>()
  private nodeOf = new Map<string, string>()
  private cost = new Map<string, number>()
  private distances = new Map<string, Map<string, number>>()
  private actualJunctions = new Set<string>()
  private nextSense = -1

  constructor(private network: RoadNetworkData) {
    const nodes = new Set<string>()
    for (const lane of network.lanes.values()) {
      if (lane.pocket) continue
      const pocket = lane.routeChoices ? network.lanes.get(lane.next[0]) : undefined
      const signal = pocket?.signalId ? network.signals.find(s => s.id === pocket.signalId) : undefined
      const from = node(lane.x1, lane.z1), to = signal ? node(signal.x, signal.z) : node(lane.x2, lane.z2)
      this.nodeOf.set(lane.id, to)
      const [ax, az] = from.split(',').map(Number), [bx, bz] = to.split(',').map(Number)
      let storage = Math.hypot(lane.x2 - lane.x1, lane.z2 - lane.z1)
      if (lane.routeChoices) for (const id of lane.next) {
        const p = network.lanes.get(id)!
        storage += Math.hypot(p.x2 - p.x1, p.z2 - p.z1)
      }
      const edge = { lane: lane.id, from, to, seconds: Math.hypot(bx - ax, bz - az) / Math.min(lane.speed, 11) + 1.5, storage }
      this.edges.set(lane.id, edge)
      if (!this.reverse.has(to)) this.reverse.set(to, [])
      this.reverse.get(to)!.push(edge)
      this.cost.set(lane.id, edge.seconds)
      nodes.add(from); nodes.add(to)
    }
    for (const lane of network.lanes.values()) if (lane.pocket) this.nodeOf.set(lane.id, this.nodeOf.get(lane.approachLane!)!)
    // Road fragments also have graph seam nodes. Keep them for navigation,
    // but a trip must end at an actual car-accessible crossroad, not a seam.
    for (const lane of network.lanes.values()) {
      if (lane.pocket) continue
      const fx = lane.x2 - lane.x1, fz = lane.z2 - lane.z1
      const choices = lane.routeChoices ?? lane.next
      if (choices.some(id => {
        const next = network.lanes.get(id)!
        return Math.abs(fx * (next.z2 - next.z1) - fz * (next.x2 - next.x1)) > 1
      })) this.actualJunctions.add(this.endNode(lane.id))
    }
    this.destinations = [...nodes].filter(id => this.actualJunctions.has(id) && id.split(',').every(v => Math.abs(Number(v)) <= 500))
    this.homes = this.destinations.filter(id => Math.max(...id.split(',').map(v => Math.abs(Number(v)))) >= 400)
    this.central = this.destinations.filter(id => id.split(',').every(v => Math.abs(Number(v)) <= 100))
  }

  endNode(laneId: string) { return this.nodeOf.get(laneId)! }
  isJunction(id: string) { return this.actualJunctions.has(id) }

  sense(cars: readonly Vehicle[], time: number) {
    if (time < this.nextSense) return
    this.nextSense = time + 1
    const loads = new Map<string, Load>()
    const add = (id: string, car: Vehicle, weight: number) => {
      const lane = this.network.lanes.get(id)
      if (!lane) return
      id = lane.approachLane ?? id
      let load = loads.get(id)
      if (!load) loads.set(id, load = { cars: 0, stopped: 0, slow: 0, metres: 0, wait: 0 })
      load.cars += weight
      load.stopped += car.speed < 0.5 ? weight : 0
      load.slow += car.speed < 4 ? weight : 0
      load.metres += (([4.5, 4.65, 5.3, 7.6, 8.2][car.typeIdx] ?? 4.5) + 1.8) * weight
      load.wait = Math.max(load.wait, car.stuck)
    }
    for (const car of cars) {
      add(car.conn ? car.connNext : car.segId, car, 1)
      const committed = car.afterPocket ?? car.plannedNext
      if (!car.conn && committed) add(committed, car, 0.2)
    }
    for (const edge of this.edges.values()) {
      const load = loads.get(edge.lane)
      const delay = load ? load.stopped * 2.2 + load.slow * 0.6
        + Math.pow(Math.min(1.2, load.metres / edge.storage), 4) * 16 + Math.min(25, load.wait * 0.3) : 0
      this.cost.set(edge.lane, edge.seconds + delay)
    }
    this.distances.clear()
  }

  reset() { this.nextSense = -1; this.distances.clear() }

  private toDestination(target: string) {
    let result = this.distances.get(target)
    if (result) return result
    result = new Map([[target, 0]])
    const heap: { id: string; cost: number }[] = [{ id: target, cost: 0 }]
    const push = (value: typeof heap[number]) => {
      let i = heap.length
      heap.push(value)
      while (i > 0) {
        const p = (i - 1) >> 1
        if (heap[p].cost <= value.cost) break
        heap[i] = heap[p]; i = p
      }
      heap[i] = value
    }
    while (heap.length) {
      const current = heap[0], last = heap.pop()!
      if (heap.length) {
        let i = 0
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1
          if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++
          if (heap[child].cost >= last.cost) break
          heap[i] = heap[child]; i = child
        }
        heap[i] = last
      }
      if (current.cost !== result.get(current.id)) continue
      for (const edge of this.reverse.get(current.id) ?? []) {
        const cost = current.cost + this.cost.get(edge.lane)!
        if (cost < (result.get(edge.from) ?? Infinity)) {
          result.set(edge.from, cost); push({ id: edge.from, cost })
        }
      }
    }
    this.distances.set(target, result)
    return result
  }

  score(from: LaneSeg, exitId: string, target: string) {
    const edge = this.edges.get(exitId)
    if (!edge) return Infinity
    const next = this.network.lanes.get(exitId)!
    const al = Math.hypot(from.x2 - from.x1, from.z2 - from.z1), bl = Math.hypot(next.x2 - next.x1, next.z2 - next.z1)
    const cross = ((from.x2 - from.x1) * (next.z2 - next.z1) - (from.z2 - from.z1) * (next.x2 - next.x1)) / al / bl
    const turn = cross < -0.5 ? 3 : cross > 0.5 ? 1.5 : 0
    return this.cost.get(edge.lane)! + (this.toDestination(target).get(edge.to) ?? 10000) + turn
  }

  choose(from: LaneSeg, choices: readonly string[], target: string, current?: string | null) {
    let best = choices[0], bestCost = this.score(from, best, target)
    for (const id of choices.slice(1)) {
      const cost = this.score(from, id, target)
      if (cost < bestCost) { best = id; bestCost = cost }
    }
    // Avoid route flapping for small changes in estimated queue delays.
    if (current && choices.includes(current) && this.score(from, current, target) <= bestCost + 5) return current
    return best
  }
}
