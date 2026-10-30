'use client'

import { useCityStore } from '@/lib/city/store'
import GraphicsSettings from './GraphicsSettings'

export default function IntroOverlay({ onStart, onTrafficLab, loading, progress }: { onStart: (guided?: boolean) => void; onTrafficLab: () => void; loading: boolean; progress: number }) {
  const classroomMode = useCityStore((s) => s.classroomMode)
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-[#0b1511] p-5 sm:p-10">
      <div className="my-auto w-full max-w-5xl py-6">
        <div className="mb-8 flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300">
          <span className="rounded-full border border-emerald-400/30 px-3 py-1.5">Future Cities Summit 2050</span>
          <span className="text-emerald-100/45">City D / The car-dependent city</span>
        </div>
        <div className="grid gap-8 md:grid-cols-[1.15fr_1fr] md:gap-16">
          <div>
            <h1 className="text-5xl font-extrabold tracking-tight text-emerald-50 sm:text-7xl">SOLHEIM<span className="block font-light text-emerald-300">2050</span></h1>
            <p className="mt-6 max-w-lg text-xl leading-relaxed text-emerald-50/90">Everyday journeys with more choice.</p>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-emerald-100/60">A proposal for a city with spread-out suburbs, long commutes and unreliable public transport outside the centre.</p>
            <div className="mt-7 border-l-2 border-amber-400/70 pl-4 text-sm leading-relaxed text-amber-100/85">How can we reduce car dependency while keeping daily life practical for people who rely on cars?</div>
          </div>
          <div className="space-y-4">
            {[
              ['01', 'Reliable buses first', 'Connect outer neighbourhoods to the main routes. Give buses priority where delays are worst.'],
              ['02', 'Safer short journeys', 'Link protected cycle routes with safe crossings and calmer school streets.'],
              ['03', 'Daily needs closer to home', 'Add local services and homes around transport stops, with safeguards for existing residents.'],
            ].map(([number, title, body]) => (
              <div key={number} className="flex gap-4 border-b border-white/10 pb-4">
                <span className="pt-0.5 text-xs font-mono text-emerald-400/70">{number}</span>
                <div><h2 className="font-semibold text-emerald-50">{title}</h2><p className="mt-1 text-sm leading-relaxed text-emerald-100/55">{body}</p></div>
              </div>
            ))}
            <p className="text-xs leading-relaxed text-emerald-100/45">This 1.44 km² model illustrates a proposed pilot district. The wider suburbs are outside the model. Trams represent a possible later phase, subject to demand and funding.</p>
          </div>
        </div>
        {loading ? (
          <div role="status" className="mt-9 max-w-md">
            <div className="h-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-emerald-400 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <p className="mt-3 text-xs text-emerald-200/60">Building the pilot district… {Math.round(progress * 100)}%</p>
          </div>
        ) : (
          <div className="mt-9">
            <div className="flex flex-wrap gap-3">
              <button onClick={() => onStart(true)} className="cursor-pointer rounded-lg bg-emerald-400 px-7 py-3 font-bold text-emerald-950 transition-colors hover:bg-emerald-300">Start the site visit</button>
              <button onClick={() => onStart(false)} className="cursor-pointer rounded-lg border border-emerald-300/25 px-7 py-3 font-semibold text-emerald-100 transition-colors hover:bg-white/5">Explore freely</button>
              <button onClick={onTrafficLab} className="cursor-pointer rounded-lg border border-amber-300/40 bg-amber-900/15 px-7 py-3 font-semibold text-amber-100 transition-colors hover:bg-amber-900/30">Traffic lab</button>
            </div>
            <label className="mt-5 flex w-fit cursor-pointer items-center gap-2.5 text-xs text-emerald-100/65"><input type="checkbox" checked={classroomMode} onChange={(e) => useCityStore.getState().patch({ classroomMode: e.target.checked })} className="accent-emerald-400" />Classroom mode: steady daylight, sound off, no random incidents</label>
            <GraphicsSettings />
            <p className="mt-5 text-xs leading-relaxed text-emerald-100/40">WASD move · Mouse look · T next location · Shift + T previous · Q end visit · E inspect · P traffic lab · Tab model estimates · Esc pause</p>
          </div>
        )}
      </div>
    </div>
  )
}
