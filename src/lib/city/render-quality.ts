export type QualityLevel = 'performance' | 'balanced' | 'high'
export type QualityMode = 'auto' | QualityLevel

export const QUALITY_LEVELS: QualityLevel[] = ['performance', 'balanced', 'high']
export const QUALITY_SETTINGS = {
  performance: { pixelRatio: .85, pixelBudget: 900_000, shadows: false, shadowSize: 512, shadowHz: 0, distance: 420, streetLights: 2, headlightPairs: 0 },
  balanced: { pixelRatio: 1.25, pixelBudget: 1_800_000, shadows: true, shadowSize: 1024, shadowHz: 15, distance: 750, streetLights: 4, headlightPairs: 1 },
  high: { pixelRatio: 1.75, pixelBudget: 3_600_000, shadows: true, shadowSize: 2048, shadowHz: 30, distance: 1600, streetLights: 6, headlightPairs: 2 },
} as const

export function initialQuality(device: { cores?: number; memory?: number; touch: boolean }): QualityLevel {
  return device.touch || (device.cores !== undefined && device.cores <= 4) || (device.memory !== undefined && device.memory <= 4)
    ? 'performance' : 'balanced'
}

/** Bound actual framebuffer pixels, including large high-DPI displays. */
export function renderPixelRatio(level: QualityLevel, width: number, height: number, dpr: number): number {
  const settings = QUALITY_SETTINGS[level]
  return Math.min(dpr || 1, settings.pixelRatio, Math.sqrt(settings.pixelBudget / Math.max(1, width * height)))
}

export function isQualityMode(value: string | null): value is QualityMode {
  return value === 'auto' || QUALITY_LEVELS.includes(value as QualityLevel)
}

/** Ignore loading/background stalls; require sustained pressure and a long
 * recovery window so resolution does not oscillate while walking. */
export class AdaptiveQuality {
  private elapsed = 0
  private frames = 0
  private slow = 0
  private fast = 0
  private warmup = 3
  constructor(public level: QualityLevel, private ceiling: QualityLevel) {}

  reset(level: QualityLevel) {
    this.level = level
    this.elapsed = this.frames = this.slow = this.fast = 0
    this.warmup = 3
  }

  sample(frameSeconds: number): QualityLevel | null {
    if (frameSeconds <= 0 || frameSeconds > 1) return null
    if (this.warmup > 0) { this.warmup -= frameSeconds; return null }
    this.elapsed += frameSeconds
    this.frames++
    if (this.elapsed < 1) return null
    const fps = this.frames / this.elapsed
    this.slow = fps < 42 ? this.slow + this.elapsed : 0
    this.fast = fps > 57 ? this.fast + this.elapsed : 0
    this.elapsed = this.frames = 0
    const index = QUALITY_LEVELS.indexOf(this.level)
    const next = this.slow >= 3 && index > 0 ? QUALITY_LEVELS[index - 1]
      : this.fast >= 20 && index < QUALITY_LEVELS.indexOf(this.ceiling) ? QUALITY_LEVELS[index + 1] : null
    if (next) this.reset(next)
    return next
  }
}
