'use client'

import { getEngine } from '@/lib/city/engine'
import { useCityStore } from '@/lib/city/store'

/** POI information panel — owned by Task 2-e for polish. */
export default function InfoPanel() {
  const poi = useCityStore((s) => s.activePoi)
  if (!poi) return null
  return (
    <div className="absolute right-0 top-0 z-40 h-full w-full max-w-md bg-[#0d1712]/95 backdrop-blur-md border-l border-emerald-500/25 shadow-2xl overflow-y-auto">
      <div className="p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="text-[10px] font-bold tracking-[0.25em] uppercase text-emerald-400 mb-1">{poi.category}</div>
            <h2 className="text-2xl font-bold text-emerald-50 leading-tight">{poi.title}</h2>
          </div>
          <button
            onClick={() => getEngine()?.interact()}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
          >
            Esc ✕
          </button>
        </div>

        <p className="text-emerald-100/85 text-[15px] leading-relaxed mb-6">{poi.description}</p>

        <div className="rounded-xl border border-emerald-800/50 bg-emerald-900/25 divide-y divide-emerald-800/40">
          {poi.facts.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
              <span className="text-xs text-emerald-300/70">{k}</span>
              <span className="text-sm text-emerald-50 text-right">{v}</span>
            </div>
          ))}
        </div>

        <div className="mt-6 text-[11px] text-emerald-200/40 leading-relaxed">
          Every placement in Solheim answers a “why”. Walk on — or press <b className="text-emerald-300">E</b> to keep exploring.
        </div>
      </div>
    </div>
  )
}
