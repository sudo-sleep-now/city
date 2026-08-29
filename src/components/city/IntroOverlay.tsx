'use client'

import { useCityStore } from '@/lib/city/store'

/** Intro / loading overlay — owned by Task 2-e for polish. */
export default function IntroOverlay({ onStart, loading, progress }: { onStart: () => void; loading: boolean; progress: number }) {
  const showStats = useCityStore((s) => s.showStats)
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-gradient-to-b from-[#0c150f] via-[#101d14] to-[#0a120c]">
      <div className="max-w-2xl mx-4 text-center">
        <div className="mb-2 text-emerald-500/80 text-xs font-semibold tracking-[0.35em] uppercase">A school project on optimal urban design</div>
        <h1 className="text-5xl md:text-6xl font-extrabold text-emerald-50 tracking-tight mb-3">
          SOLHEIM
        </h1>
        <p className="text-emerald-200/80 text-lg mb-8 max-w-xl mx-auto">
          A compact, transit-first city of ≈13,000 residents — designed around short distances, mixed neighborhoods,
          green space on every doorstep and streets that put people before cars.
        </p>

        {loading ? (
          <div className="mb-8">
            <div className="h-2 w-72 mx-auto rounded-full bg-emerald-950 overflow-hidden border border-emerald-800">
              <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-3 text-emerald-300/70 text-sm">
              {progress < 0.3 ? 'Planning districts & streets…' : progress < 0.6 ? 'Raising buildings…' : progress < 0.9 ? 'Planting trees, wiring lights…' : 'Waking up traffic & pedestrians…'}
            </p>
          </div>
        ) : (
          <>
            <button
              onClick={onStart}
              className="rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] text-emerald-950 font-bold text-lg px-10 py-4 shadow-[0_0_40px_rgba(16,185,129,0.35)] transition-all cursor-pointer"
            >
              Enter Solheim
            </button>
            <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-emerald-200/70 max-w-lg mx-auto">
              {[
                ['WASD', 'Move'],
                ['Mouse', 'Look'],
                ['Shift', 'Sprint'],
                ['Space', 'Jump'],
                ['Ctrl', 'Crouch'],
                ['E', 'Interact / Enter'],
                ['Tab', 'City statistics'],
                ['Esc', 'Release mouse'],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-emerald-800/60 bg-emerald-900/30 px-2 py-2">
                  <span className="font-bold text-emerald-300">{k}</span>
                  <span className="block text-emerald-200/60">{v}</span>
                </div>
              ))}
            </div>
            <p className="mt-6 text-[11px] text-emerald-200/40">
              Best experienced on desktop. Walk to glowing points of interest and press E to learn why the city is designed this way.
            </p>
          </>
        )}
        {showStats && <div className="hidden">stats</div>}
      </div>
    </div>
  )
}
