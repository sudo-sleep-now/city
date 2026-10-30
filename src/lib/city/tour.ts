import type { CityStats } from './types'

/** A manual site visit, independent of the separate classroom slide deck. */
export interface TourStop {
  x: number
  z: number
  yaw: number
  pitch?: number
  time?: number
  title: string
  body: string
  facts: [string, string][]
}

export function tourIntro(_stats: CityStats): string {
  return 'Pilot district site visit: T next, Shift + T previous, Q finish. Each location stays until you move on.'
}

export function buildTourStops(stats: CityStats): TourStop[] {
  return [
    {
      x: 50, z: -26, yaw: -.15, pitch: -.08, time: 10,
      title: 'The proposal: a pilot district for City D',
      body: 'The wider city has spread-out homes, long commutes and weak public transport outside its centre. This compact model shows what a redeveloped district could look like. The challenge is to improve access while keeping essential car journeys possible.',
      facts: [['Model area', `${stats.areaKm2} km², not the whole city`], ['Priority', 'Useful alternatives before restrictions']],
    },
    {
      x: 61, z: -63, yaw: -2.45, pitch: -.05, time: 10,
      title: 'Everyday life in Solheim Square',
      body: 'A useful centre should give people reasons to stay. The fountain, flower kiosk, café terrace and shaded seating create smaller places to meet within the larger square. Clear walking routes connect them to the surrounding streets and transport stops. The idea is to make everyday trips more pleasant, alongside improving transport services.',
      facts: [['Public space', 'A fountain, garden seating and market kiosks'], ['Access', 'Open routes around the fountain and into the café']],
    },
    {
      x: 570, z: 25, yaw: -1.3, time: 10,
      title: 'Outer connections: reliable buses first',
      body: 'Start on existing main roads. Connect outer neighbourhoods to frequent buses through sheltered transfer stops, with priority at congested junctions. Keep fares affordable and cover early and late shifts. The routes beyond this district still need a demand survey and operating funding.',
      facts: [['First phase', 'Bus corridors and feeder connections'], ['Car access', 'Plan for accessible drop-off and essential journeys']],
    },
    {
      x: 70, z: -96, yaw: 0, time: 10,
      title: 'The interchange: buses arrive, board and depart',
      body: 'B1 buses turn in from the eastern street, stop at Bay A beside the hall and leave through the signed exit. Walk through the glazed hall or follow the marked path to the T1 tram stop on the avenue. The tram network remains a later-phase proposal; the bus interchange has a clear role from the start.',
      facts: [['Near term', 'Fund reliable buses and measure delays'], ['Later option', 'Tram conversion where justified']],
    },
    {
      x: -252, z: -192, yaw: 0, time: 10,
      title: 'Safer short trips: the school route',
      body: 'Connect cycle lanes with safer crossings and calmer local streets. A child should be able to reach school without a dangerous gap in the route. This can replace some short car journeys, but people who cannot walk or cycle still need accessible transport and drop-off space.',
      facts: [['Local street design', '20 km/h in this model'], ['Test before expansion', 'Safety audits and resident feedback']],
    },
    {
      x: -52, z: -22, yaw: 0, time: 10,
      title: 'Local services: fewer trips across town',
      body: 'The market illustrates daily needs closer to home. Gradually add services and housing near stops, using existing sites rather than expanding into open land. New density needs school and utility capacity. Affordable housing and tenant safeguards should help existing residents stay.',
      facts: [['Longer term', 'Mixed-use infill around stops'], ['Limitation', 'A city-wide retrofit takes decades']],
    },
    {
      x: 20, z: 100, yaw: -Math.PI / 2, time: 10,
      title: 'The trade-off: road space and fair access',
      body: 'Bus priority and safer cycle routes compete with parking and traffic lanes. Begin with a limited pilot, keep emergency and disabled access, and agree delivery arrangements with shops. Measure bus delays, household travel costs and access to jobs. Expand only when alternatives work for the people who need them.',
      facts: [['Decision rule', 'Fair access before restrictions'], ['Evidence', 'Model estimates are not measured outcomes']],
    },
  ]
}
