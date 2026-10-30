'use client'

import { getEngine } from '@/lib/city/engine'
import { useCityStore } from '@/lib/city/store'

/** City statistics modal — owned by Task 2-e for polish. */
export default function StatsPanel() {
  const show = useCityStore((s) => s.showStats)
  if (!show) return null
  const engine = getEngine()
  const st = engine?.plan?.stats
  if (!st) return null

  const fmt = (n: number) => n.toLocaleString('en-US')

  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: 'Building-based estimates',
      rows: [
        ['Residents (assumed occupancy)', fmt(st.population)],
        ['Residents + jobs', fmt(st.population + st.jobs)],
        ['Area', `${st.areaKm2} km²`],
        ['Density', `${fmt(st.densityPerKm2)} / km²`],
        ['Buildings', fmt(st.buildings)],
        ['Residential units', fmt(st.residentialUnits)],
        ['Jobs (assumed capacity)', fmt(st.jobs)],
      ],
    },
    {
      title: 'Green city',
      rows: [
        ['Public green space', `${fmt(st.greenAreaM2)} m²`],
        ['Share of city area', `${st.greenPercent} %`],
        ['Avg. straight-line distance to a park', `${st.avgDistanceToParkM} m`],
        ['Model residents < 300 m from green', `${Math.round(st.residentsWithin300mPark * 100)} %`],
      ],
    },
    {
      title: 'Distance proxies, not walking routes',
      rows: [
        ['Avg. straight-line distance to a stop', `${st.avgDistanceToTransitM} m`],
        ['Model residents < 400 m from a stop', `${Math.round(st.residentsWithin400mTransit * 100)} %`],
        ['Model residents < 500 m from a school', `${Math.round(st.residentsWithin500mSchool * 100)} %`],
        ['Transit stops', `${st.transitStops} (${st.tramStops} tram)`],
        ['Travel behaviour', 'Not predicted by this model'],
      ],
    },
    {
      title: 'Streets',
      rows: [
        ['Arterial roads', `${st.roadLengthKm.arterial} km`],
        ['Collector roads', `${st.roadLengthKm.collector} km`],
        ['Local (calmed) streets', `${st.roadLengthKm.local} km`],
        ['Bike lanes', `${st.bikeLaneKm} km`],
        ['Sidewalks', `${st.sidewalkKm} km`],
      ],
    },
  ]

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-2xl border border-emerald-500/25 bg-[#0d1712]/95 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-2xl font-bold text-emerald-50">Pilot district: model estimates</h2>
            <p className="text-xs text-emerald-300/60 mt-1">Geometry and capacity estimates for this 1.44 km² district. These are not survey results or forecasts for the wider city.</p>
          </div>
          <button
            onClick={() => getEngine()?.interact()}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
          >
            Close (Tab)
          </button>
        </div>
        <p className="mb-5 rounded-lg border border-amber-400/20 bg-amber-900/15 p-3 text-xs leading-relaxed text-amber-100/75">Distances use straight lines from building centres, weighted by residential units. They do not include crossings, entrances, hills or accessibility barriers. Occupancy and jobs use design assumptions. Service frequency, travel costs and emissions are not simulated.</p>
        <div className="grid md:grid-cols-2 gap-4">
          {sections.map((sec) => (
            <div key={sec.title} className="rounded-xl border border-emerald-800/50 bg-emerald-900/20 overflow-hidden">
              <div className="px-4 py-2 text-xs font-bold tracking-wider uppercase text-emerald-400 border-b border-emerald-800/50">
                {sec.title}
              </div>
              <div className="divide-y divide-emerald-800/30">
                {sec.rows.map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3 px-4 py-2">
                    <span className="text-xs text-emerald-200/60">{k}</span>
                    <span className="text-sm font-medium text-emerald-50 text-right">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
