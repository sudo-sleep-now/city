'use client'

import { useEffect, useRef, useState } from 'react'
import { getEngine } from '@/lib/city/engine'
import { useCityStore } from '@/lib/city/store'
import { TRAFFIC_PRESETS, MIN_TRAFFIC_VEHICLES, MAX_TRAFFIC_VEHICLES, type TrafficMetrics, type TrafficScenario } from '@/lib/city/traffic-config'

const scenarios: { id: TrafficScenario; title: string; detail: string }[] = [
  { id: 'normal', title: 'Normal', detail: '48 cars, spread across the district' },
  { id: 'rush-hour', title: 'Rush hour', detail: '144 cars, more demand near the centre' },
  { id: 'gridlock', title: 'High congestion', detail: '240 cars concentrated on central roads' },
]
interface Reading { label: string; cars: number; policy: string; metrics: TrafficMetrics }

export default function TrafficLab() {
  const open = useCityStore(s => s.showTrafficLab)
  const config = useCityStore(s => s.trafficConfig)
  const metrics = useCityStore(s => s.trafficMetrics)
  const paused = useCityStore(s => s.trafficPaused)
  const speed = useCityStore(s => s.trafficSpeed)
  const view = useCityStore(s => s.trafficView)
  const [demandDraft, setDemandDraft] = useState<number | null>(null)
  const demand = demandDraft ?? config.vehicleCount
  const [readings, setReadings] = useState<Reading[]>([])
  const canvas = useRef<HTMLCanvasElement>(null)
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => { if (open) close.current?.focus() }, [open])
  useEffect(() => {
    if (!open || !canvas.current) return
    const engine = getEngine()
    const context = canvas.current.getContext('2d')
    if (!engine || !context) return
    const width = canvas.current.width, height = canvas.current.height
    const scale = width / 1260
    const x = (n: number) => (n + 630) * scale
    const z = (n: number) => (n + 630) * height / 1260
    context.fillStyle = '#101e1a'; context.fillRect(0, 0, width, height)
    for (const r of engine.plan.roads) {
      context.strokeStyle = r.cls === 'arterial' ? '#506259' : '#2b3c33'
      context.lineWidth = r.cls === 'arterial' ? 2 : 1
      context.beginPath()
      if (r.axis === 'x') { context.moveTo(x(r.from), z(r.coord)); context.lineTo(x(r.to), z(r.coord)) }
      else { context.moveTo(x(r.coord), z(r.from)); context.lineTo(x(r.coord), z(r.to)) }
      context.stroke()
    }
    for (const car of engine.traffic.getJamStats()) {
      context.fillStyle = car.speed < 1.2 ? '#f3a65c' : '#74d4ae'
      context.beginPath(); context.arc(x(car.x), z(car.z), 2.1, 0, Math.PI * 2); context.fill()
    }
    // Mark the junction under the observation camera.
    context.strokeStyle = '#f8e4bc'; context.lineWidth = 1
    context.strokeRect(x(-32), z(-32), 64 * scale, 64 * height / 1260)
  }, [open, metrics])

  if (!open) return null
  const name = scenarios.find(s => s.id === config.scenario)?.title ?? 'Custom'
  const applyConfig = (next: typeof config) => { setDemandDraft(null); getEngine()?.configureTraffic(next) }
  const applyPreset = (scenario: TrafficScenario) => applyConfig({ ...TRAFFIC_PRESETS[scenario] })
  const elapsed = Math.floor(metrics.simulationSeconds)
  const speedTargetHeld = metrics.minCurrentSpeedKmh !== null && metrics.minCurrentSpeedKmh >= 15
    && metrics.minRunSpeedKmh !== null && metrics.minRunSpeedKmh >= 15
    && metrics.minRollingSpeedKmh !== null && metrics.minRollingSpeedKmh >= 15
  const button = 'rounded-md border border-white/15 px-3 py-2 text-xs text-emerald-50/80 transition-colors hover:border-emerald-300/50 hover:bg-emerald-900/40'

  return (
    <aside role="dialog" aria-modal="false" aria-label="Traffic lab" className="absolute inset-y-3 right-3 z-45 flex w-[370px] max-w-[calc(100vw-24px)] flex-col rounded-2xl border border-emerald-300/25 bg-[#0c1915]/97 text-emerald-50 shadow-2xl backdrop-blur-xl">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-300">Live experiment</p><h2 className="mt-1 text-xl font-semibold">Traffic lab</h2><p className="mt-1 text-[11px] text-emerald-100/55">{paused ? 'Paused' : 'Running'} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} simulated · {speed}×</p></div>
        <button ref={close} aria-label="Close traffic lab" onClick={() => getEngine()?.toggleTrafficLab()} className={`${button} shrink-0`}>Close <span className="text-white/35">P</span></button>
      </header>
      <div className="space-y-5 overflow-y-auto px-5 py-4">
        <section aria-label="Traffic scenarios">
          <h3 className="mb-2 text-xs font-semibold text-emerald-100/75">Traffic demand</h3>
          <div className="grid grid-cols-3 gap-1.5">
            {scenarios.map(s => <button key={s.id} onClick={() => applyPreset(s.id)} aria-pressed={config.scenario === s.id} title={s.detail} className={`${button} px-1.5 ${config.scenario === s.id ? 'border-amber-300/60 bg-amber-800/20 text-amber-100' : ''}`}>{s.title}</button>)}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-emerald-100/50">{config.vehicleCount} cars · {config.scenario === 'normal' ? 'spread across the district' : config.scenario === 'rush-hour' ? 'more trips towards the centre' : 'sustained demand at the central junction'}</p>
          <label htmlFor="traffic-demand" className="mt-3 flex justify-between text-xs"><span>Private and service vehicles</span><span className="font-mono text-amber-200">{demand}</span></label>
          <input id="traffic-demand" type="range" min={MIN_TRAFFIC_VEHICLES} max={MAX_TRAFFIC_VEHICLES} step={12} value={demand} onChange={e => setDemandDraft(Number(e.target.value))} className="mt-2 w-full accent-amber-300" />
          <button disabled={demand === config.vehicleCount} onClick={() => applyConfig({ ...config, vehicleCount: demand })} className={`${button} mt-1 w-full disabled:cursor-default disabled:opacity-35`}>Apply {demand} vehicles</button>
        </section>

        <section aria-label="Signal controls">
          <h3 className="mb-2 text-xs font-semibold text-emerald-100/75">Junction signals</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {(['fixed', 'adaptive'] as const).map(policy => <button key={policy} aria-pressed={config.signalPolicy === policy} onClick={() => applyConfig({ ...config, signalPolicy: policy })} className={`${button} ${config.signalPolicy === policy ? 'border-emerald-300/50 bg-emerald-800/25' : ''}`}>{policy === 'fixed' ? 'Fixed timing' : 'Adapt to queues'}</button>)}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-emerald-100/45">Adaptive lights release empty approaches early. Green arrows protect left turns; cars wait for approaching trams before crossing the tracks.</p>
        </section>

        <section aria-label="Simulation controls" className="space-y-2">
          <div className="flex gap-1.5">
            <button onClick={() => getEngine()?.setTrafficPaused(!paused)} aria-pressed={paused} className={`${button} flex-1`}>{paused ? 'Resume traffic' : 'Pause traffic'}</button>
            <button onClick={() => applyConfig({ ...config })} className={`${button} flex-1`}>Restart same run</button>
          </div>
          <div className="flex items-center justify-between"><span className="text-[11px] text-emerald-100/50">Simulation speed</span><div className="flex gap-1">{([1, 2, 4] as const).map(n => <button key={n} aria-pressed={speed === n} onClick={() => getEngine()?.setTrafficSpeed(n)} className={`${button} py-1 ${speed === n ? 'bg-emerald-800/40' : ''}`}>{n}×</button>)}</div></div>
        </section>

        <section aria-label="Live traffic measurements">
          <div className="mb-2 flex items-baseline justify-between"><h3 className="text-xs font-semibold text-emerald-100/75">Live readings</h3><span className="text-[10px] text-amber-200/65">{elapsed < 60 ? 'First minute: estimate' : '60-second flow window'}</span></div>
          <dl className="grid grid-cols-2 gap-2">
            {[
              ['Run average speed', metrics.simulationSeconds > 0 ? `${metrics.avgSpeedKmh.toFixed(1)} km/h` : 'Measuring…'],
              ['Current fleet average', metrics.simulationSeconds > 0 ? `${metrics.currentSpeedKmh.toFixed(1)} km/h` : 'Measuring…'],
              ['Last 60s average', elapsed >= 60 ? `${metrics.rollingSpeedKmh.toFixed(1)} km/h` : 'Measuring…'],
              ['Vehicles queued', `${metrics.queued} / ${metrics.activeVehicles}`],
              ['Mean current wait', `${metrics.meanWaitSec.toFixed(1)} s`],
              ['Junction exits / min', String(Math.round(metrics.throughputPerMinute))],
              ['Stopped time / car', `${metrics.stoppedSecondsPerVehicle.toFixed(1)} s`],
              ['Junction exits this run', String(metrics.completedSegments)],
            ].map(([label, value]) => <div key={label} className="rounded-lg border border-white/10 bg-white/3 px-3 py-2"><dt className="text-[10px] text-emerald-100/50">{label}</dt><dd className="mt-1 font-mono text-base text-emerald-100">{value}</dd></div>)}
          </dl>
          <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${elapsed < 60 ? 'border-white/10 text-emerald-100/55' : speedTargetHeld ? 'border-emerald-400/30 text-emerald-200' : 'border-amber-400/35 text-amber-200'}`}>
            <p className="font-semibold">15 km/h target · {elapsed < 60 ? 'Measuring first minute' : speedTargetHeld ? 'Held throughout this run' : 'Below target during this run'}</p>
            <p className="mt-1 leading-relaxed">Lowest fleet average: {metrics.minCurrentSpeedKmh?.toFixed(1) ?? '—'} · Lowest 60s average: {metrics.minRollingSpeedKmh?.toFixed(1) ?? '—'} km/h</p>
          </div>
          <div className="mt-3 flex justify-between text-[10px] text-emerald-100/50"><span>Share queued</span><span>{metrics.queuePercent.toFixed(0)}%</span></div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-amber-400 transition-[width]" style={{ width: `${Math.min(100, metrics.queuePercent)}%` }} /></div>
          {metrics.recoveryRespawns > 0 && <p className="mt-2 text-[10px] text-amber-200">{metrics.recoveryRespawns} vehicle re-entries at network edges</p>}
          <p className="mt-2 text-[10px] leading-relaxed text-emerald-100/40">Stopped time adds up all time below 0.5 m/s per car since restart. Compare at the same run age. Flow counts completed junction crossings; entering a turn pocket does not add a crossing.</p>
        </section>

        <section aria-label="Traffic map">
          <div className="mb-2 flex justify-between text-[10px] text-emerald-100/50"><span>District traffic</span><span><span className="text-emerald-300">Moving</span> · <span className="text-amber-300">Slow / stopped</span></span></div>
          <canvas ref={canvas} width={320} height={190} className="w-full rounded-lg border border-white/10" aria-label="Map of moving and slow vehicles" />
          <p className="mt-2 text-[11px] leading-relaxed text-emerald-100/50">Five central crossroads have separate left-turn pockets and straight/right lanes. Arrows show where each lane leads. Stop bars sit behind the zebra crossings, with space for turning trucks.</p>
          <div className="mt-2 grid grid-cols-3 gap-1.5">{(['street', 'junction', 'district'] as const).map(v => <button key={v} aria-pressed={view === v} onClick={() => getEngine()?.setTrafficView(v)} className={`${button} px-1 ${view === v ? 'bg-emerald-800/40' : ''}`}>{v === 'street' ? 'Street view' : v === 'junction' ? 'Junction view' : 'Whole district'}</button>)}</div>
        </section>

        <section aria-label="Saved traffic readings">
          <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-emerald-100/75">Compare readings</h3><button onClick={() => setReadings(prev => [{ label: name, cars: config.vehicleCount, policy: config.signalPolicy, metrics: { ...metrics } }, ...prev].slice(0, 4))} className={button}>Save reading</button></div>
          {readings.length > 0 ? <table className="mt-3 w-full text-left text-[10px]"><caption className="sr-only">Saved readings from traffic experiments</caption><thead className="text-emerald-100/40"><tr><th className="pb-2 font-normal">Run / age</th><th className="pb-2 font-normal">Stop / car</th><th className="pb-2 font-normal">Queue</th><th className="pb-2 font-normal">Flow</th></tr></thead><tbody>{readings.map((r, i) => <tr key={i} className="border-t border-white/10"><td className="py-2"><span className="block text-emerald-100/80">{r.cars} cars · {r.policy}</span><span className="text-emerald-100/40">{Math.round(r.metrics.simulationSeconds)}s</span></td><td className="font-mono">{r.metrics.stoppedSecondsPerVehicle.toFixed(1)}s</td><td className="font-mono">{r.metrics.queuePercent.toFixed(0)}%</td><td className="font-mono">{Math.round(r.metrics.throughputPerMinute)}</td></tr>)}</tbody></table> : <p className="mt-2 text-[11px] leading-relaxed text-emerald-100/45">Let a run reach 60 simulated seconds, save a reading, then change demand or signals. Compare runs at the same age and speed.</p>}
        </section>
        <p className="border-t border-white/10 pt-3 text-[10px] leading-relaxed text-emerald-100/40">Changing demand or signals restarts vehicles and readings with a fixed seed. Saved readings stay here until you reload. Press P or Escape to return to walking.</p>
      </div>
    </aside>
  )
}
