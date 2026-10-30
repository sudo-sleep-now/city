import { create } from 'zustand'
import { TRAFFIC_PRESETS } from './traffic-config'
import type { EngineState, POI } from './types'

interface CityStore extends EngineState {
  patch: (p: Partial<EngineState>) => void
  openPoi: (poi: POI) => void
  closePoi: () => void
  toggleStats: () => void
  showToast: (msg: string) => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useCityStore = create<CityStore>((set, get) => ({
  ready: false,
  started: false,
  paused: false,
  clock: 9.5,
  fps: 60,
  graphicsMode: 'auto',
  graphicsLevel: 'balanced',
  renderStats: { calls: 0, triangles: 0, pixelRatio: 1 },
  px: 50,
  pz: -30,
  heading: Math.PI,
  insideId: null,
  insideName: null,
  nearby: null,
  activePoi: null,
  showStats: false,
  showTrafficLab: false,
  trafficConfig: { ...TRAFFIC_PRESETS.normal },
  trafficMetrics: { avgSpeedKmh: 0, currentSpeedKmh: 0, rollingSpeedKmh: 0, minCurrentSpeedKmh: null, minRunSpeedKmh: null, minRollingSpeedKmh: null, queued: 0, queuePercent: 0, meanWaitSec: 0, stoppedSecondsPerVehicle: 0, throughputPerMinute: 0, completedSegments: 0, activeVehicles: 48, recoveryRespawns: 0, simulationSeconds: 0 },
  trafficPaused: false,
  trafficSpeed: 1,
  trafficView: 'junction',
  toast: null,
  fade: false,
  loadingProgress: 0,
  tour: null,
  muted: false,
  classroomMode: true,
  patch: (p) => set(p),
  openPoi: (poi) => set({ activePoi: poi }),
  closePoi: () => set({ activePoi: null }),
  toggleStats: () => set({ showStats: !get().showStats }),
  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: msg })
    toastTimer = setTimeout(() => set({ toast: null }), 3800)
  },
}))
