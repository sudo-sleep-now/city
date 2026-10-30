'use client'

import { getEngine } from '@/lib/city/engine'
import { useCityStore } from '@/lib/city/store'
import GraphicsSettings from './GraphicsSettings'

/** In-world HUD — owned by Task 2-e for polish. */
export default function HUD() {
  const clock = useCityStore((s) => s.clock)
  const fps = useCityStore((s) => s.fps)
  const nearby = useCityStore((s) => s.nearby)
  const insideName = useCityStore((s) => s.insideName)
  const started = useCityStore((s) => s.started)
  const paused = useCityStore((s) => s.paused)
  const showStats = useCityStore((s) => s.showStats)
  const activePoi = useCityStore((s) => s.activePoi)
  const tour = useCityStore((s) => s.tour)
  const muted = useCityStore((s) => s.muted)
  const trafficLab = useCityStore((s) => s.showTrafficLab)

  const hh = Math.floor(clock)
  const mm = Math.floor((clock - hh) * 60)
  const isNight = clock < 6.5 || clock > 19
  const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`

  const showPrompt = started && !paused && !showStats && !trafficLab && !activePoi && nearby

  return (
    <>
      {/* crosshair */}
      {started && !paused && !showStats && !trafficLab && !activePoi && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
          <div className="h-1.5 w-1.5 rounded-full bg-white/80 shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
        </div>
      )}

      {/* top-left title chip */}
      {started && (
        <div className="absolute left-4 top-4 z-20 rounded-lg bg-black/45 backdrop-blur px-3 py-2 border border-white/10">
          <div className="text-emerald-300 font-bold text-sm leading-none">SOLHEIM</div>
          <div className="text-white/50 text-[10px] mt-0.5">2050 pilot district · City D</div>
        </div>
      )}

      {started && !trafficLab && !showStats && !activePoi && (
        <button onClick={() => getEngine()?.toggleTrafficLab()} className="absolute left-4 top-[4.7rem] z-30 rounded-lg border border-amber-300/35 bg-black/65 px-3 py-2 text-xs font-semibold text-amber-100 backdrop-blur hover:bg-amber-950/80">Traffic lab <kbd className="ml-2 text-amber-300/70">P</kbd></button>
      )}

      {/* bottom-left clock + sound toggle */}
      {started && !showStats && !activePoi && <div className="absolute left-4 top-[7.4rem] z-30"><GraphicsSettings compact /></div>}
      {started && (
        <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2">
          <button type="button" aria-label={isNight ? 'Switch to daylight' : 'Switch to night lighting'} title="Switch day / night" onClick={() => getEngine()?.toggleDayNight()} className="rounded-lg bg-black/45 backdrop-blur px-3 py-2 border border-white/10 flex items-center gap-2 hover:bg-black/60">
            <span aria-hidden>{isNight ? '🌙' : '☀️'}</span>
            <span className="text-white/90 text-sm font-semibold tabular-nums">{timeStr}</span>
            <span className="text-white/40 text-[10px]">{fps} fps</span>
          </button>
          <button
            type="button"
            aria-label={muted ? 'Unmute ambient sound' : 'Mute ambient sound'}
            title="Ambient sound (M)"
            onClick={() => getEngine()?.toggleMute()}
            className="rounded-lg bg-black/45 backdrop-blur px-2.5 py-2 border border-white/10 text-sm leading-none hover:bg-black/60 active:bg-black/70 transition-colors"
          >
            <span aria-hidden>{muted ? '🔇' : '🔊'}</span>
          </button>
        </div>
      )}

      {/* bottom-right hints */}
      {started && !paused && (
        <div className="absolute bottom-4 right-4 z-20 rounded-lg bg-black/45 backdrop-blur px-3 py-2 border border-white/10 text-[11px] text-white/60">
          <span><b className="text-white/90">T</b> site visit</span>
          <span className="mx-2 text-white/25">·</span>
          <span><b className="text-white/90">E</b> interact</span>
          <span className="mx-2 text-white/25">·</span>
          <span><b className="text-white/90">Tab</b> stats</span>
          <span className="mx-2 text-white/25">·</span>
          <span><b className="text-white/90">Shift</b> sprint</span>
          <span className="mx-2 text-white/25">·</span>
          <span><b className="text-white/90">M</b> sound</span>
        </div>
      )}

      {/* inside indicator */}
      {insideName && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 rounded-full bg-black/55 backdrop-blur px-4 py-1.5 border border-white/10 text-white/80 text-xs">
          Interior — {insideName} · find the exit door
        </div>
      )}

      {/* interaction prompt (hidden during tour narration) */}
      {showPrompt && nearby && !tour && (
        <div className="pointer-events-none absolute bottom-[16%] left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-lg bg-black/60 backdrop-blur px-4 py-2 border border-emerald-400/30">
          <kbd className="rounded bg-emerald-500 px-1.5 py-0.5 text-[11px] font-bold text-emerald-950">E</kbd>
          <span className="text-sm text-white/90">
            {nearby.action} <b>{nearby.title}</b>
          </span>
        </div>
      )}

      {/* guided tour narration card */}
      {tour && started && !paused && !trafficLab && (
        <div className="pointer-events-none absolute bottom-[9%] left-1/2 z-20 w-[min(660px,92vw)] -translate-x-1/2">
          <div className="rounded-xl border border-emerald-400/30 bg-black/70 backdrop-blur-md px-5 py-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-emerald-300 font-bold text-sm">{tour.title}</h3>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-white/45 tabular-nums">{tour.idx + 1} / {tour.total}</span>
                <div className="h-1 w-24 overflow-hidden rounded-full bg-white/15">
                  <div
                    className="h-full rounded-full bg-emerald-400 transition-all duration-700"
                    style={{ width: `${((tour.idx + 1) / tour.total) * 100}%` }}
                  />
                </div>
              </div>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-white/85">{tour.body}</p>
            {tour.facts.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
                {tour.facts.map(([k, v]) => (
                  <div key={k} className="text-[11px]">
                    <span className="text-emerald-300/80 font-semibold">{k}: </span>
                    <span className="text-white/70">{v}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="pointer-events-auto mt-3 flex gap-2">
              <button onClick={() => getEngine()?.previousTourStop()} disabled={tour.idx === 0} className="rounded border border-white/20 px-3 py-1 text-xs text-white/80 disabled:opacity-30">Previous</button>
              <button onClick={() => getEngine()?.toggleTour()} className="rounded bg-emerald-400 px-3 py-1 text-xs font-semibold text-emerald-950">{tour.idx === tour.total - 1 ? "Finish visit" : "Next location"}</button>
            </div>
            <div className="mt-2.5 text-[10px] text-white/40">
              <b className="text-white/70">T</b> next · <b className="text-white/70">Shift + T</b> previous · <b className="text-white/70">Q</b> finish · locations stay until you advance
            </div>
          </div>
        </div>
      )}
    </>
  )
}
