import { create } from 'zustand'
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
  px: 50,
  pz: -30,
  heading: Math.PI,
  insideId: null,
  insideName: null,
  nearby: null,
  activePoi: null,
  showStats: false,
  toast: null,
  fade: false,
  loadingProgress: 0,
  tour: null,
  muted: false,
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
