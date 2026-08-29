import type { CityStats } from './types'

/* ============================================================
 * Guided City Tour — 10 curated stops that walk through every
 * major planning decision of Solheim. Used by the school demo:
 * press T in-game. Each stop teleports the visitor, may set the
 * time of day for drama, and shows a narration card.
 * ============================================================ */

export interface TourStop {
  x: number
  z: number
  yaw: number
  /** set the clock when arriving (hours) */
  time?: number
  title: string
  body: string
  facts: [string, string][]
  /** seconds before auto-advancing */
  holdSec: number
}

export function tourIntro(stats: CityStats): string {
  return `Solheim houses ≈${stats.population.toLocaleString()} residents on 1.44 km² with ${stats.greenPercent}% green space. This 10-stop tour explains WHY the city is laid out the way it is.`
}

export function buildTourStops(stats: CityStats): TourStop[] {
  return [
    {
      x: 50,
      z: -34,
      yaw: 0,
      time: 9.5,
      title: '1 · Civic Plaza — the heart of Solheim',
      body: 'Everything starts here. The main tram lines (T1 north–south, T2 east–west) and the inner bus loop cross within 200 m of this square. Highest densities in the city sit within a 300 m walk — homes and jobs next to transit is what keeps car use low.',
      facts: [
        ['Transit', 'Tram T1 + T2 · Bus B1'],
        ['Walk catchment', '≈13,000 residents'],
        ['Design', 'Car-free, trees, seating, market adjacent'],
      ],
      holdSec: 14,
    },
    {
      x: 44,
      z: -90,
      yaw: 0.1,
      title: '2 · Central Station — transit before parking',
      body: 'The station anchors the plaza, not a highway. Notice what is missing: a giant parking garage. 78% of daily trips here are walk, bike or tram — so the most valuable land next to the station is public space and housing, not car storage.',
      facts: [
        ['Tram lines', 'T1 Green · T2 Sun, every few minutes'],
        ['Bus loops', '3 routes serve every district'],
        ['Result', 'Car share reduced to ~1 in 5 trips'],
      ],
      holdSec: 14,
    },
    {
      x: -52,
      z: -22,
      yaw: 0,
      title: '3 · Market Hall — daily needs on foot',
      body: 'Fresh food sits between housing, offices and the plaza. Grocery access is treated like a utility: every neighborhood cluster has one within ~400 m, so nobody needs a car for a bag of shopping. Walk in (E) — the hall is furnished.',
      facts: [
        ['Catchment', 'Downtown + 2 districts on foot'],
        ['Jobs', '≈60 in the hall alone'],
        ['Principle', 'Daily needs ≤ 5-minute walk'],
      ],
      holdSec: 14,
    },
    {
      x: 20,
      z: 100,
      yaw: -Math.PI / 2,
      time: 11,
      title: '4 · The Car-free Shopping Street',
      body: 'This 400 m street is closed to cars: bollards at both gates, trees in planters, benches and string lights. Retail thrives on foot traffic, and removing cars is the cheapest traffic-calming there is. Deliveries happen before 9 am.',
      facts: [
        ['Length', '400 m pedestrian-only'],
        ['Shops', '≈24 ground-floor units'],
        ['Effect', 'People linger → shops earn more'],
      ],
      holdSec: 14,
    },
    {
      x: 96,
      z: 14,
      yaw: 2.55,
      title: '5 · Downtown — a real density gradient',
      body: 'Look north-west: towers rise where the two tram lines cross, and heights step down toward the ring. Density follows transit — 26 floors at the core, low-rise at the edge. No towers stranded far from a stop, no single-family sprawl near the center.',
      facts: [
        ['Core density', 'Highest in the city, on the tram square'],
        ['Heights', 'Step down with distance to transit'],
        ['Mix', 'Ground floors retail, above offices + homes'],
      ],
      holdSec: 14,
    },
    {
      x: 0,
      z: -208,
      yaw: 0,
      time: 15,
      title: '6 · Central Park — green within 300 m of everyone',
      body: 'A 200×200 m park directly north of downtown. Instead of one giant park at the city edge, Solheim distributes green: this park, 8 pocket parks, a sports park and community gardens mean the average resident is ~120 m from green space.',
      facts: [
        ['Features', 'Pond, playground, pavilion, lawns'],
        ['Access', 'Tram stops on two edges, paths step-free'],
        ['Citywide', `Green covers ${stats.greenPercent}% of land`],
      ],
      holdSec: 14,
    },
    {
      x: -252,
      z: -192,
      yaw: 0,
      title: '7 · Maple Elementary — the 5-minute walkshed',
      body: 'Every residential quadrant has its own school inside the neighborhood. Children walk or cycle, so the school run generates no car traffic, and the sports pitch doubles as a public park after hours. Look left: a pocket park one block away.',
      facts: [
        ['Walkshed', '≈500 m from every home in the quadrant'],
        ['Streets', '20 km/h traffic-calmed locals'],
        ['Shared', 'Pitch open to clubs evenings + weekends'],
      ],
      holdSec: 14,
    },
    {
      x: 210,
      z: 22,
      yaw: -1.25,
      title: '8 · City Hospital — seconds from the arterial',
      body: 'The hospital sits beside tram T2 and arterial z=0: ambulances reach the whole grid in under five minutes, while staff and visitors arrive by tram instead of driving. Deliberately NOT downtown — cheaper land, no congestion, still 10 minutes from most homes.',
      facts: [
        ['Access', 'Tram T2 "Hospital" stop'],
        ['Emergency', 'Direct arterial + ring access'],
        ['Roof', 'Working helipad'],
      ],
      holdSec: 14,
    },
    {
      x: 420,
      z: 425,
      yaw: -0.9,
      time: 17.5,
      title: '9 · Ironworks — industry on the city’s terms',
      body: 'Industry sits in the south-east corner: separated from homes by a double conifer belt, downwind of prevailing winds, rail-served so freight never crosses residential streets. Look east past the wall — wind turbines top up the city grid.',
      facts: [
        ['Jobs', '≈350 in the district'],
        ['Freight', 'Rail siding + direct truck route'],
        ['Energy', 'Wind turbines + rooftop solar'],
      ],
      holdSec: 14,
    },
    {
      x: 50,
      z: -44,
      yaw: 0,
      time: 21.5,
      title: '10 · Night falls — the city that works after dark',
      body: 'Back where we started, now at night. Streets stay lit and walked because homes, shops and transit share every block — mixed use is why the city never empties. That is Solheim’s one big idea: short distances make the sustainable choice the easy choice.',
      facts: [
        ['Modal share', `Walk ${stats.dailyTripsByMode.walk}% · Bike ${stats.dailyTripsByMode.bike}% · Transit ${stats.dailyTripsByMode.transit}% · Car ${stats.dailyTripsByMode.car}%`],
        ['Avg walk to transit', `${stats.avgDistanceToTransitM} m`],
        ['Avg walk to green', `${stats.avgDistanceToParkM} m`],
      ],
      holdSec: 18,
    },
  ]
}
