'use client'

import { useEffect, useRef } from 'react'
import { getEngine } from '@/lib/city/engine'
import { useCityStore } from '@/lib/city/store'

/** Live minimap rendered from CityPlan — owned by Task 2-e for polish. */
export default function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ready = useCityStore((s) => s.ready)
  const started = useCityStore((s) => s.started)
  const px = useCityStore((s) => s.px)
  const pz = useCityStore((s) => s.pz)
  const heading = useCityStore((s) => s.heading)

  useEffect(() => {
    if (!ready || !started || !canvasRef.current) return
    const engine = getEngine()
    if (!engine) return
    const plan = engine.plan
    if (!plan) return
    const cv = canvasRef.current
    const ctx = cv.getContext('2d')!
    const S = cv.width // square
    const w2m = S / (plan.bounds * 2 + 60) // meters→px
    const tx = (x: number) => (x + plan.bounds + 30) * w2m
    const tz = (z: number) => (z + plan.bounds + 30) * w2m

    let raf = 0
    const draw = () => {
      ctx.clearRect(0, 0, S, S)
      ctx.fillStyle = '#141a16'
      ctx.fillRect(0, 0, S, S)
      // parks
      for (const p of plan.parks) {
        ctx.fillStyle = p.kind === 'plaza' ? '#8a8352' : '#3f6b3c'
        ctx.fillRect(tx(p.x0), tz(p.z0), (p.x1 - p.x0) * w2m, (p.z1 - p.z0) * w2m)
      }
      // blocks (subtle) + roads
      for (const r of plan.roads) {
        ctx.strokeStyle = r.cls === 'arterial' ? '#6b6b72' : r.cls === 'collector' ? '#55555c' : '#45454b'
        ctx.lineWidth = r.cls === 'arterial' ? 3 : r.cls === 'collector' ? 2 : 1
        ctx.beginPath()
        if (r.axis === 'x') {
          ctx.moveTo(tx(r.from), tz(r.coord))
          ctx.lineTo(tx(r.to), tz(r.coord))
        } else {
          ctx.moveTo(tx(r.coord), tz(r.from))
          ctx.lineTo(tx(r.coord), tz(r.to))
        }
        ctx.stroke()
      }
      // Bus routes connect the pilot to edge transfer points.
      for (const rt of plan.routes) {
        if (rt.mode !== 'bus') continue
        ctx.strokeStyle = '#eab44f'
        ctx.lineWidth = 1.4
        ctx.beginPath()
        rt.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(tx(p.x), tz(p.z))
          else ctx.lineTo(tx(p.x), tz(p.z))
        })
        ctx.stroke()
      }
      // tram lines (possible later phase)
      ctx.strokeStyle = '#c2410c'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 2])
      for (const rt of plan.routes) {
        if (rt.mode !== 'tram') continue
        ctx.beginPath()
        ctx.moveTo(tx(rt.points[0].x), tz(rt.points[0].z))
        ctx.lineTo(tx(rt.points[1].x), tz(rt.points[1].z))
        ctx.stroke()
      }
      ctx.setLineDash([])
      // POIs
      for (const p of plan.pois) {
        ctx.fillStyle = '#f59e0b'
        ctx.beginPath()
        ctx.arc(tx(p.x), tz(p.z), 2, 0, Math.PI * 2)
        ctx.fill()
      }
      // player arrow
      const x = tx(px)
      const z = tz(pz)
      ctx.save()
      ctx.translate(x, z)
      ctx.rotate(-heading)
      ctx.fillStyle = '#34d399'
      ctx.beginPath()
      ctx.moveTo(0, -6)
      ctx.lineTo(4, 5)
      ctx.lineTo(-4, 5)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [ready, started, px, pz, heading])

  if (!started) return null
  return (
    <div className="absolute right-4 top-4 z-20 rounded-lg overflow-hidden border border-white/15 shadow-lg">
      <canvas ref={canvasRef} width={176} height={176} className="block" />
      <div className="absolute left-1.5 top-1 text-[9px] text-amber-200/90">Bus routes / dashed: future tram</div>
      <div className="absolute bottom-1 right-1.5 text-[9px] text-white/50">Pilot · 1.2 × 1.2 km</div>
    </div>
  )
}
