'use client'

import { getEngine } from '@/lib/city/engine'
import { useCityStore } from '@/lib/city/store'
import type { QualityMode } from '@/lib/city/render-quality'

export default function GraphicsSettings({ compact = false }: { compact?: boolean }) {
  const mode = useCityStore(s => s.graphicsMode)
  const level = useCityStore(s => s.graphicsLevel)
  const stats = useCityStore(s => s.renderStats)
  const fps = useCityStore(s => s.fps)
  const label = level[0].toUpperCase() + level.slice(1)
  const control = (
    <label className="flex items-center gap-3 text-xs text-emerald-100/80">
      Graphics
      <select aria-label="Graphics quality" value={mode} onChange={e => getEngine()?.setGraphicsMode(e.target.value as QualityMode)} className="rounded border border-emerald-300/30 bg-[#10251b] px-2 py-1.5 text-emerald-50">
        <option value="auto">Auto</option>
        <option value="performance">Performance</option>
        <option value="balanced">Balanced</option>
        <option value="high">High</option>
      </select>
    </label>
  )
  const detail = <>
    <p className="mt-2 max-w-64 text-[11px] leading-relaxed text-emerald-100/60">{mode === 'auto' ? `Using ${label.toLowerCase()} detail. Adjusts automatically when frames slow down.` : level === 'performance' ? 'For slower devices: lighter resolution, no sun shadows and fewer lighting effects.' : level === 'balanced' ? 'Sharper detail with lighter shadows and a shorter draw distance.' : 'Full draw distance, sharper shadows and more lighting effects.'}</p>
    <output aria-label="Rendering performance" className="mt-2 block text-[10px] tabular-nums text-emerald-100/45">{fps} fps · {stats.calls.toLocaleString('en-US')} draws · {Math.round(stats.triangles / 1000).toLocaleString('en-US')}k triangles · {stats.pixelRatio.toFixed(2)}× resolution</output>
  </>
  if (!compact) return <div className="mt-4">{control}{detail}</div>
  return <details className="rounded-lg border border-white/10 bg-black/70 p-2.5 text-xs text-emerald-100 backdrop-blur">
    <summary className="cursor-pointer">Graphics · {mode === 'auto' ? `Auto (${label})` : label}</summary>
    <div className="mt-3">{control}{detail}</div>
  </details>
}
