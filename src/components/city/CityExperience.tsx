'use client'

import { useEffect, useRef, useState } from 'react'
import { createEngine, getEngine, type CityEngine } from '@/lib/city/engine'
import { useCityStore } from '@/lib/city/store'
import HUD from './HUD'
import IntroOverlay from './IntroOverlay'
import InfoPanel from './InfoPanel'
import StatsPanel from './StatsPanel'
import Minimap from './Minimap'
import TrafficLab from './TrafficLab'

/** coarse-pointer devices get on-screen controls */
const isTouchDevice = () =>
  typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0)

export default function CityExperience() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState(false)
  const ready = useCityStore((s) => s.ready)
  const started = useCityStore((s) => s.started)
  const paused = useCityStore((s) => s.paused)
  const trafficLab = useCityStore((s) => s.showTrafficLab)
  const fade = useCityStore((s) => s.fade)
  const toast = useCityStore((s) => s.toast)
  const loadingProgress = useCityStore((s) => s.loadingProgress)
  const [touch] = useState(isTouchDevice)
  const [sprintOn, setSprintOn] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    const engine: CityEngine = createEngine(containerRef.current)
    engine.init().catch((error) => {
      console.error("Unable to initialise the city", error)
      setLoadError(true)
    })
    return () => {
      engine.dispose()
    }
  }, [])

  const startGame = (guided = false) => {
    getEngine()?.requestStart(guided)
  }

  if (loadError) return (
    <div role="alert" className="fixed inset-0 flex items-center justify-center bg-[#0b1511] p-8 text-emerald-50">
      <div className="max-w-lg"><h1 className="text-2xl font-bold">The 3D model could not start</h1><p className="my-4 text-emerald-100/70">Open this page in a browser with WebGL enabled, then reload. The separate presentation works without the model.</p><button onClick={() => window.location.reload()} className="rounded-lg bg-emerald-400 px-5 py-3 font-semibold text-emerald-950">Try again</button></div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black overflow-hidden select-none" role="application" aria-label="Solheim 2050 proposed pilot district for City D">
      <div ref={containerRef} className="absolute inset-0" />

      {/* vignette */}
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_180px_rgba(0,0,0,0.55)]" />

      {ready && <HUD />}
      {ready && !trafficLab && <Minimap />}

      {!started && ready && <IntroOverlay onStart={startGame} onTrafficLab={() => getEngine()?.startTrafficLab()} loading={false} progress={loadingProgress} />}
      {!ready && <IntroOverlay onStart={startGame} onTrafficLab={() => getEngine()?.startTrafficLab()} loading progress={loadingProgress} />}

      {paused && started && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-emerald-100 mb-2">Paused</h2>
            <p className="text-emerald-200/70 mb-6">Solheim 2050 · proposed pilot district</p>
            <button
              onClick={() => getEngine()?.resume()}
              className="rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold px-8 py-3 transition-colors cursor-pointer"
            >
              Resume walking
            </button>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button onClick={() => getEngine()?.toggleTrafficLab()} className="rounded-lg border border-amber-300/40 px-4 py-2 text-sm text-amber-100">Traffic lab (P)</button>
              <button onClick={() => { getEngine()?.previousTourStop(); getEngine()?.resume() }} className="rounded-lg border border-emerald-300/25 px-4 py-2 text-sm text-emerald-100">Previous location</button>
              <button onClick={() => { getEngine()?.toggleTour(); getEngine()?.resume() }} className="rounded-lg border border-emerald-300/25 px-4 py-2 text-sm text-emerald-100">Next / start visit</button>
              <button onClick={() => { getEngine()?.endTour(); getEngine()?.resume() }} className="rounded-lg border border-emerald-300/25 px-4 py-2 text-sm text-emerald-100">Explore freely</button>
            </div>
            <p className="mt-4 text-xs text-emerald-200/50">Click the world or the button to recapture the mouse</p>
          </div>
        </div>
      )}

      {/* touch controls: left thumb = joystick (drawn on the canvas area),
          right thumb buttons = jump / sprint / interact */}
      {touch && started && !paused && !trafficLab && (
        <>
          <div className="pointer-events-none absolute bottom-8 left-8 z-30 h-28 w-28 rounded-full border-2 border-emerald-200/25 bg-emerald-950/30">
            <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-emerald-200/50">move</div>
          </div>
          <div className="absolute bottom-8 right-6 z-30 flex flex-col items-end gap-3">
            <button
              aria-label="Jump"
              onTouchStart={(e) => {
                e.preventDefault()
                getEngine()?.mobileJump()
              }}
              className="h-14 w-14 rounded-full border border-emerald-300/40 bg-emerald-900/60 text-emerald-100 text-xs font-semibold active:bg-emerald-700/70"
            >
              Jump
            </button>
            <button
              aria-label="Sprint"
              onTouchStart={(e) => {
                e.preventDefault()
                setSprintOn((v) => {
                  getEngine()?.mobileSprint(!v)
                  return !v
                })
              }}
              className={`h-14 w-14 rounded-full border text-xs font-semibold active:bg-emerald-700/70 ${sprintOn ? 'border-emerald-200 bg-emerald-600/80 text-white' : 'border-emerald-300/40 bg-emerald-900/60 text-emerald-100'}`}
            >
              Run
            </button>
            <button
              aria-label="Interact"
              onTouchStart={(e) => {
                e.preventDefault()
                getEngine()?.mobileInteract()
              }}
              className="h-16 w-16 rounded-full border border-amber-300/50 bg-amber-900/60 text-amber-100 text-sm font-bold active:bg-amber-700/70"
            >
              E
            </button>
          </div>
        </>
      )}

      <InfoPanel />
      <StatsPanel />
      <TrafficLab />

      {toast && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 rounded-full bg-emerald-950/85 border border-emerald-400/30 px-5 py-2 text-emerald-100 text-sm shadow-lg animate-in fade-in">
          {toast}
        </div>
      )}

      {/* fade layer for interior transitions */}
      <div
        className={`pointer-events-none absolute inset-0 z-50 bg-black transition-opacity duration-500 ${fade ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  )
}
