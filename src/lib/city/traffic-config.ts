export type TrafficScenario = 'normal' | 'rush-hour' | 'gridlock'
export type SignalPolicy = 'fixed' | 'adaptive'

export interface TrafficConfig {
  scenario: TrafficScenario
  vehicleCount: number
  signalPolicy: SignalPolicy
}

export interface TrafficMetrics {
  /** Simulation-clock seconds since the last configure/reset. */
  simulationSeconds: number
  avgSpeedKmh: number
  currentSpeedKmh: number
  rollingSpeedKmh: number
  minCurrentSpeedKmh: number | null
  minRunSpeedKmh: number | null
  minRollingSpeedKmh: number | null
  queued: number
  queuePercent: number
  meanWaitSec: number
  /** Accumulated stopped time divided by the persistent vehicle population. */
  stoppedSecondsPerVehicle: number
  /** Completed junction crossings in the trailing 60s; internal lane splits excluded. */
  throughputPerMinute: number
  completedSegments: number
  activeVehicles: number
  recoveryRespawns: number
}

export const TRAFFIC_PRESETS: Record<TrafficScenario, TrafficConfig> = {
  normal: { scenario: 'normal', vehicleCount: 48, signalPolicy: 'adaptive' },
  'rush-hour': { scenario: 'rush-hour', vehicleCount: 144, signalPolicy: 'adaptive' },
  gridlock: { scenario: 'gridlock', vehicleCount: 240, signalPolicy: 'adaptive' },
}

export const MIN_TRAFFIC_VEHICLES = 24
export const MAX_TRAFFIC_VEHICLES = 240
