import * as THREE from 'three'
import type { CityMaterials, FacadeMaterial } from './types'

/* ============================================================
 * Procedural materials & canvas textures.
 * ALL textures are generated with 2D canvas — no external assets.
 * ============================================================ */

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** create a 2D canvas + ctx (shared helper for procedural textures) */
export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!] as [HTMLCanvasElement, CanvasRenderingContext2D]
}

/** wrap a canvas into a THREE texture (shared helper) */
export function tex(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** fill with base color + speckle noise */
function noisy(size: number, base: string, dots: { color: string; n: number; rMin: number; rMax: number; alpha?: number }[], rng: () => number): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  for (const d of dots) {
    for (let i = 0; i < d.n; i++) {
      ctx.globalAlpha = (d.alpha ?? 0.3) * (0.5 + rng() * 0.5)
      ctx.fillStyle = d.color
      const r = d.rMin + rng() * (d.rMax - d.rMin)
      ctx.beginPath()
      ctx.arc(rng() * size, rng() * size, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
  return c
}

/* ---------------- facade factory ---------------- */

interface FacadeStyle {
  base: string
  window: string
  frame: string
  pattern: 'brick' | 'plaster' | 'panel' | 'stone' | 'corrugated' | 'painted'
  brick1?: string
  brick2?: string
  arch?: boolean // arched window tops (civic look)
  bigWin?: boolean // taller ground-floor-style windows
  band?: string // spandrel/string-course band under the windows (full width)
}

function drawFacadeModule(style: FacadeStyle, size = 256): HTMLCanvasElement {
  // one tile = 4 window modules across × 1 floor tall
  const [c, ctx] = canvas(size, size / 2)
  const W = size
  const H = size / 2
  ctx.fillStyle = style.base
  ctx.fillRect(0, 0, W, H)

  if (style.pattern === 'brick') {
    const bh = 6
    for (let y = 0; y < H; y += bh) {
      const off = (y / bh) % 2 === 0 ? 0 : 8
      for (let x = -16; x < W; x += 16) {
        ctx.fillStyle = rng2() < 0.5 ? style.brick1! : style.brick2!
        ctx.fillRect(x + off + 1, y + 1, 14, bh - 2)
      }
    }
  } else if (style.pattern === 'plaster') {
    const rng = mulberry32(7)
    for (let i = 0; i < 400; i++) {
      ctx.globalAlpha = 0.06
      ctx.fillStyle = rng() < 0.5 ? '#000000' : '#ffffff'
      ctx.fillRect(rng() * W, rng() * H, 2 + rng() * 3, 2 + rng() * 3)
    }
    ctx.globalAlpha = 1
  } else if (style.pattern === 'panel') {
    // vertical panel seams
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    for (let x = 0; x < W; x += 32) ctx.fillRect(x, 0, 2, H)
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    for (let x = 2; x < W; x += 32) ctx.fillRect(x, 0, 1, H)
  } else if (style.pattern === 'stone') {
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'
    ctx.lineWidth = 1.5
    for (let y = 0; y < H; y += 16) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
      ctx.stroke()
      for (let x = (y / 16) % 2 === 0 ? 0 : 24; x < W; x += 48) {
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x, y + 16)
        ctx.stroke()
      }
    }
  } else if (style.pattern === 'corrugated') {
    for (let x = 0; x < W; x += 12) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
      ctx.fillRect(x, 0, 4, H)
      ctx.fillStyle = 'rgba(0,0,0,0.16)'
      ctx.fillRect(x + 8, 0, 3, H)
    }
    // rust streaks
    const rng = mulberry32(99)
    for (let i = 0; i < 14; i++) {
      ctx.globalAlpha = 0.12
      ctx.fillStyle = '#7a4a30'
      const x = rng() * W
      ctx.fillRect(x, rng() * H * 0.4, 2 + rng() * 3, 20 + rng() * 40)
    }
    ctx.globalAlpha = 1
  } else if (style.pattern === 'painted') {
    const rng = mulberry32(31)
    for (let i = 0; i < 260; i++) {
      ctx.globalAlpha = 0.08
      ctx.fillStyle = rng() < 0.5 ? '#000000' : '#ffffff'
      ctx.fillRect(rng() * W, rng() * H, 3, 2)
    }
    ctx.globalAlpha = 1
  }

  // windows: 4 per tile, each ~ module width/4
  const winW = W / 4
  for (let i = 0; i < 4; i++) {
    const x = i * winW + winW * 0.22
    const y = style.bigWin ? H * 0.14 : H * 0.2
    const w = winW * 0.56
    const h = style.bigWin ? H * 0.66 : H * 0.58
    if (style.arch) {
      // stone surround + arched top (civic arch look)
      ctx.fillStyle = style.frame
      ctx.fillRect(x - 5, y - 2, w + 10, h + 6)
      ctx.beginPath()
      ctx.moveTo(x - 2, y + h)
      ctx.lineTo(x - 2, y + w / 2)
      ctx.arc(x + w / 2, y + w / 2, w / 2 + 2, Math.PI, 0, false)
      ctx.lineTo(x + w + 2, y + h)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = style.window
      ctx.beginPath()
      ctx.moveTo(x, y + h)
      ctx.lineTo(x, y + w / 2)
      ctx.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0, false)
      ctx.lineTo(x + w, y + h)
      ctx.closePath()
      ctx.fill()
      // keystone
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.fillRect(x + w / 2 - 3, y - 8, 6, 8)
    } else {
      ctx.fillStyle = style.frame
      ctx.fillRect(x - 3, y - 3, w + 6, h + 6)
      ctx.fillStyle = style.window
      ctx.fillRect(x, y, w, h)
    }
    // glass reflection streak
    ctx.fillStyle = 'rgba(255,255,255,0.13)'
    ctx.fillRect(x + w * 0.15, y, w * 0.2, h)
    // sill
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(x - 5, y + h + 3, w + 10, 4)
  }
  // spandrel / string-course band under the windows (full width of the tile)
  if (style.band) {
    const by = Math.round(H * 0.82)
    ctx.fillStyle = style.band
    ctx.fillRect(0, by, W, 6)
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.fillRect(0, by, W, 1.6)
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(0, by + 6, W, 2)
  }
  return c
}

function drawFacadeEmissive(style: FacadeStyle, size = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size / 2)
  const W = size
  const H = size / 2
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, H)
  const rng = mulberry32(Math.floor(style.base.length * 977 + size))
  const winW = W / 4
  for (let i = 0; i < 4; i++) {
    const x = i * winW + winW * 0.22
    const y = style.bigWin ? H * 0.14 : H * 0.2
    const w = winW * 0.56
    const h = style.bigWin ? H * 0.66 : H * 0.58
    if (rng() < 0.38) {
      // lit room: whole window glows warm with slight variance
      const g = ctx.createLinearGradient(x, y, x, y + h)
      const warm = rng() < 0.7 ? '#ffce8a' : '#ffd9b8'
      g.addColorStop(0, warm)
      g.addColorStop(1, '#b8864e')
      ctx.fillStyle = g
      if (style.arch) {
        ctx.beginPath()
        ctx.moveTo(x, y + h)
        ctx.lineTo(x, y + w / 2)
        ctx.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0, false)
        ctx.lineTo(x + w, y + h)
        ctx.closePath()
        ctx.fill()
      } else {
        ctx.fillRect(x, y, w, h)
      }
    } else if (rng() < 0.3) {
      // partially lit
      ctx.fillStyle = '#8a6a42'
      ctx.fillRect(x, y + h * 0.55, w, h * 0.45)
    }
  }
  return c
}

const rng2 = mulberry32(4242)

function makeFacade(style: FacadeStyle): FacadeMaterial {
  const map = tex(drawFacadeModule(style))
  const emissiveMap = tex(drawFacadeEmissive(style))
  const material = new THREE.MeshStandardMaterial({
    map,
    emissiveMap,
    emissive: new THREE.Color('#ffd9a0'),
    emissiveIntensity: 0,
    roughness: 0.85,
    metalness: 0.02,
    // per-building vertex tints (buildings.ts) give EVERY building its own
    // weathered tone even when two share the same facade family
    vertexColors: true,
  })
  const roof = new THREE.MeshStandardMaterial({
    map: tex(noisy(128, '#4e4c48', [{ color: '#3c3a36', n: 160, rMin: 1, rMax: 3 }, { color: '#5c5a55', n: 90, rMin: 1, rMax: 2 }], mulberry32(11))),
    roughness: 0.95,
  })
  const trim = new THREE.MeshStandardMaterial({ color: style.pattern === 'brick' ? '#8f887c' : '#b8b2a4', roughness: 0.8 })
  return { material, roof, trim, storefront: false, style: 'modern' }
}

/* ---------------- glass curtain wall (towers) ----------------
 * The old glassTower had NO map — a flat tinted slab with nothing on it,
 * which read as "giant glass buildings without window supports". The new
 * module texture bakes a real curtain-wall grid: one tile = 2 panes × 1
 * floor (pane ≈ 1.65 m wide on a 3.3 × 3.05 m wall module), dark mullions
 * on BOTH axes, a spandrel band at each floor line, per-pane tone variation
 * and sheen streaks. Geometry mullions (buildings.ts) add real relief on
 * top of this.
 */

function curtainWallCanvas(size = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size / 2)
  const W = size
  const H = size / 2
  const panes = 2 // across (× 1 floor down)
  const pw = W / panes
  const rng = mulberry32(2113)
  for (let i = 0; i < panes; i++) {
    // per-pane glass tone — reflects different sky/interiors
    const l = 0.82 + rng() * 0.3
    const cool = rng() < 0.7
    ctx.fillStyle = cool
      ? `rgb(${Math.round(96 * l)},${Math.round(148 * l)},${Math.round(138 * l)})`
      : `rgb(${Math.round(118 * l)},${Math.round(150 * l)},${Math.round(128 * l)})`
    ctx.fillRect(i * pw, 0, pw, H)
    // spandrel: darker opaque band covering the slab edge at each floor line
    const spH = Math.round(H * 0.24)
    const g = ctx.createLinearGradient(0, H - spH, 0, H)
    g.addColorStop(0, 'rgba(38,48,46,0.85)')
    g.addColorStop(1, 'rgba(30,38,37,0.95)')
    ctx.fillStyle = g
    ctx.fillRect(i * pw, H - spH, pw, spH)
    // vision-glass sheen — diagonal reflection streak
    ctx.save()
    ctx.beginPath()
    ctx.rect(i * pw, 0, pw, H - spH)
    ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.moveTo(i * pw + rng() * pw * 0.5, H - spH)
    ctx.lineTo(i * pw + rng() * pw * 0.5 + pw * 0.42, 0)
    ctx.lineTo(i * pw + rng() * pw * 0.5 + pw * 0.75, 0)
    ctx.lineTo(i * pw + rng() * pw * 0.5 + pw * 0.3, H - spH)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  // MULLIONS — verticals between/around panes + horizontal floor lines
  ctx.fillStyle = '#2c3432'
  for (let i = 0; i <= panes; i++) ctx.fillRect(i * pw - 3, 0, 6, H)
  // thin inner glazing bars
  ctx.fillStyle = 'rgba(40,50,48,0.75)'
  for (let i = 0; i < panes; i++) ctx.fillRect(i * pw + pw / 2 - 1, 0, 2, H - Math.round(H * 0.24))
  // horizontal: head of each floor (top edge) + sill line at the spandrel top
  ctx.fillStyle = '#2c3432'
  ctx.fillRect(0, 0, W, 5)
  ctx.fillRect(0, H - Math.round(H * 0.24) - 3, W, 5)
  ctx.fillRect(0, H - 5, W, 5)
  // weathering: faint streaks down from the mullion heads
  for (let i = 0; i < 8; i++) {
    ctx.globalAlpha = 0.05 + rng() * 0.07
    ctx.fillStyle = '#dfe8e2'
    const x = rng() * W
    ctx.fillRect(x, 0, 1.5, H * (0.3 + rng() * 0.6))
  }
  ctx.globalAlpha = 1
  return c
}

function curtainWallEmissive(size = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size / 2)
  const W = size
  const H = size / 2
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, H)
  const panes = 2
  const pw = W / panes
  const rng = mulberry32(2114)
  const spH = Math.round(H * 0.24)
  for (let i = 0; i < panes; i++) {
    if (rng() < 0.36) {
      const warm = rng() < 0.75 ? '#ffce8a' : '#e8e2c8'
      const g = ctx.createLinearGradient(0, 4, 0, H - spH)
      g.addColorStop(0, warm)
      g.addColorStop(1, '#8a6a42')
      ctx.fillStyle = g
      ctx.fillRect(i * pw + 4, 4, pw - 8, H - spH - 8)
      if (rng() < 0.4) {
        // partially darkened (blinds / corner office)
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fillRect(i * pw + 4, 4 + (H - spH) * (0.3 + rng() * 0.3), pw - 8, H - spH)
      }
    }
  }
  return c
}

/* ---------------- special-building facades ----------------
 * Every special building gets its OWN module texture so each civic
 * archetype reads instantly (hospital = white cladding + green glass,
 * school = warm brick + tall white-framed windows, …).
 */

const SPECIAL_STYLES: Record<string, FacadeStyle> = {
  hospital: { base: '#e3e5de', window: '#7fa396', frame: '#cdd1c6', pattern: 'panel' },
  clinic: { base: '#eaede5', window: '#8fb5a6', frame: '#d6d9ce', pattern: 'panel' },
  market: { base: '#d9c8a4', window: '#463c30', frame: '#8a7a5c', pattern: 'stone', arch: true, bigWin: true },
  library: { base: '#c6b99a', window: '#413a30', frame: '#a3947a', pattern: 'stone' },
  school: { base: '#a35a40', window: '#3a3630', frame: '#e2dccc', pattern: 'brick', brick1: '#a8634a', brick2: '#96513a' },
  fire: { base: '#93402f', window: '#332e2a', frame: '#d8cfc0', pattern: 'brick', brick1: '#9a4636', brick2: '#863828' },
  police: { base: '#8a9094', window: '#3a4244', frame: '#60686c', pattern: 'panel' },
  hub: { base: '#b8ad97', window: '#3c3630', frame: '#d2c8b0', pattern: 'stone', arch: true, bigWin: true },
  depot: { base: '#8b9088', window: '#3a3f3c', frame: '#6a706a', pattern: 'corrugated' },
  factory: { base: '#93928c', window: '#39413f', frame: '#666c66', pattern: 'corrugated' },
  office: { base: '#a0a6a1', window: '#3d4a46', frame: '#6f7873', pattern: 'panel' },
  retail: { base: '#d8cbaa', window: '#443c32', frame: '#c2b394', pattern: 'plaster', bigWin: true },
}

const _specialFacades = new Map<string, THREE.MeshStandardMaterial>()
const _specialFacadeList: THREE.MeshStandardMaterial[] = []
export function getSpecialFacade(kind: string): THREE.MeshStandardMaterial {
  let m = _specialFacades.get(kind)
  if (!m) {
    const style = SPECIAL_STYLES[kind] ?? SPECIAL_STYLES.depot!
    m = new THREE.MeshStandardMaterial({
      map: tex(drawFacadeModule(style)),
      emissiveMap: tex(drawFacadeEmissive(style)),
      emissive: new THREE.Color('#ffd9a0'),
      emissiveIntensity: 0,
      roughness: 0.85,
      metalness: 0.02,
    })
    _specialFacades.set(kind, m)
    _specialFacadeList.push(m)
  }
  return m
}
/** all special-facade materials (engine drives their night window glow) */
export function getSpecialFacadeMaterials(): THREE.MeshStandardMaterial[] {
  return _specialFacadeList
}

/* ---------------- entrance murals (painted friezes) ----------------
 * Wide painted band above each special building's entrance: colored
 * ground + moulding + silhouette icon + big lettering. ONE texture per
 * (kind, text) — stretched once across the facade, never tiled.
 */

interface MuralTheme {
  bg: string
  fg: string
  accent: string
  icon: (ctx: CanvasRenderingContext2D, x: number, y: number) => void
}

const MURAL_THEMES: Record<string, MuralTheme> = {
  hospital: {
    bg: '#f0ede2', fg: '#a83226', accent: '#a83226',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#a83226'
      ctx.fillRect(x - 9, y - 30, 18, 60)
      ctx.fillRect(x - 30, y - 9, 60, 18)
    },
  },
  clinic: {
    bg: '#eef2ea', fg: '#1f6b40', accent: '#1f6b40',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#1f6b40'
      ctx.fillRect(x - 8, y - 27, 16, 54)
      ctx.fillRect(x - 27, y - 8, 54, 16)
    },
  },
  hub: {
    bg: '#24483a', fg: '#e8d9a8', accent: '#e8d9a8',
    icon: (ctx, x, y) => {
      ctx.strokeStyle = '#e8d9a8'
      ctx.lineWidth = 5
      ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 18); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 12, y + 6); ctx.stroke()
    },
  },
  market: {
    bg: '#f5ead2', fg: '#7a4a22', accent: '#d88a3a',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#d88a3a'
      ctx.beginPath(); ctx.arc(x, y + 4, 22, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#4a8c5c'
      ctx.beginPath(); ctx.ellipse(x + 10, y - 20, 12, 6, -0.6, 0, Math.PI * 2); ctx.fill()
    },
  },
  fire: {
    bg: '#b03a26', fg: '#ffe8d8', accent: '#ffb84a',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#ffb84a'
      ctx.beginPath()
      ctx.moveTo(x, y - 30)
      ctx.quadraticCurveTo(x + 24, y - 4, x + 12, y + 16)
      ctx.quadraticCurveTo(x + 6, y + 28, x, y + 28)
      ctx.quadraticCurveTo(x - 6, y + 28, x - 12, y + 16)
      ctx.quadraticCurveTo(x - 24, y - 4, x, y - 30)
      ctx.fill()
      ctx.fillStyle = '#ffe8d8'
      ctx.beginPath()
      ctx.moveTo(x, y - 6)
      ctx.quadraticCurveTo(x + 12, y + 8, x + 5, y + 20)
      ctx.quadraticCurveTo(x, y + 26, x, y + 26)
      ctx.quadraticCurveTo(x, y + 26, x - 5, y + 20)
      ctx.quadraticCurveTo(x - 12, y + 8, x, y - 6)
      ctx.fill()
    },
  },
  police: {
    bg: '#3c4448', fg: '#e8ecea', accent: '#c9c5b4',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#c9c5b4'
      ctx.beginPath()
      ctx.moveTo(x - 22, y - 26)
      ctx.lineTo(x + 22, y - 26)
      ctx.lineTo(x + 22, y + 2)
      ctx.quadraticCurveTo(x + 22, y + 22, x, y + 30)
      ctx.quadraticCurveTo(x - 22, y + 22, x - 22, y + 2)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#3c4448'
      ctx.fillRect(x - 4, y - 16, 8, 30)
      ctx.fillRect(x - 14, y - 6, 28, 8)
    },
  },
  school: {
    bg: '#2f5c40', fg: '#f0e8d0', accent: '#f0e8d0',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#f0e8d0'
      ctx.beginPath()
      ctx.moveTo(x - 30, y - 8)
      ctx.lineTo(x, y - 22)
      ctx.lineTo(x + 30, y - 8)
      ctx.lineTo(x, y + 6)
      ctx.closePath()
      ctx.fill()
      ctx.fillRect(x - 8, y + 2, 4, 16)
      ctx.fillRect(x + 4, y + 2, 4, 16)
      ctx.fillRect(x - 10, y + 18, 20, 5)
    },
  },
  library: {
    bg: '#f0ead8', fg: '#4a3a26', accent: '#8f4f3a',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#4a3a26'
      ctx.beginPath()
      ctx.moveTo(x - 28, y - 18)
      ctx.quadraticCurveTo(x - 10, y - 24, x, y - 14)
      ctx.quadraticCurveTo(x + 10, y - 24, x + 28, y - 18)
      ctx.lineTo(x + 28, y + 18)
      ctx.quadraticCurveTo(x + 10, y + 12, x, y + 20)
      ctx.quadraticCurveTo(x - 10, y + 12, x - 28, y + 18)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = '#f0ead8'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 20); ctx.stroke()
    },
  },
  depot: {
    bg: '#4a5044', fg: '#e8ead8', accent: '#e8ead8',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#e8ead8'
      ctx.fillRect(x - 28, y - 18, 56, 28)
      ctx.fillStyle = '#4a5044'
      ctx.fillRect(x - 22, y - 12, 14, 10)
      ctx.fillRect(x - 4, y - 12, 14, 10)
      ctx.fillStyle = '#e8ead8'
      ctx.beginPath(); ctx.arc(x - 16, y + 14, 6, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(x + 16, y + 14, 6, 0, Math.PI * 2); ctx.fill()
    },
  },
  recycling: {
    bg: '#2e5c34', fg: '#e8f2e0', accent: '#e8f2e0',
    icon: (ctx, x, y) => {
      ctx.strokeStyle = '#e8f2e0'
      ctx.lineWidth = 7
      for (let a = 0; a < 3; a++) {
        const rot = (a * Math.PI * 2) / 3
        ctx.beginPath()
        ctx.arc(x, y, 20, rot, rot + 1.5)
        ctx.stroke()
        const ea = rot + 1.5
        const tx = x + Math.cos(ea) * 20
        const ty = y + Math.sin(ea) * 20
        ctx.save()
        ctx.translate(tx, ty)
        ctx.rotate(ea + Math.PI / 2)
        ctx.beginPath()
        ctx.moveTo(0, -9); ctx.lineTo(8, 5); ctx.lineTo(-8, 5)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    },
  },
  factory: {
    bg: '#4a4842', fg: '#e8e2d0', accent: '#e8e2d0',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#e8e2d0'
      for (let a = 0; a < 8; a++) {
        const rot = (a * Math.PI) / 4
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(rot)
        ctx.fillRect(-5, -30, 10, 14)
        ctx.restore()
      }
      ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#4a4842'
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill()
    },
  },
  retail: {
    bg: '#1f4d38', fg: '#f2ead2', accent: '#f2ead2',
    icon: (ctx, x, y) => {
      ctx.strokeStyle = '#f2ead2'
      ctx.lineWidth = 5
      ctx.beginPath(); ctx.arc(x, y - 14, 12, Math.PI, 0); ctx.stroke()
      ctx.fillStyle = '#f2ead2'
      ctx.fillRect(x - 22, y - 14, 44, 38)
    },
  },
  works: {
    bg: '#4a4e42', fg: '#e8ead8', accent: '#e8ead8',
    icon: (ctx, x, y) => {
      ctx.fillStyle = '#e8ead8'
      ctx.fillRect(x - 26, y - 6, 52, 14)
      ctx.beginPath(); ctx.moveTo(x - 26, y - 6); ctx.lineTo(x - 10, y - 24); ctx.lineTo(x - 2, y - 6); ctx.closePath(); ctx.fill()
      ctx.beginPath(); ctx.moveTo(x - 8, y - 6); ctx.lineTo(x + 6, y - 24); ctx.lineTo(x + 14, y - 6); ctx.closePath(); ctx.fill()
    },
  },
}

const _murals = new Map<string, THREE.MeshBasicMaterial>()
export function getMuralMaterial(text: string, kind: string): THREE.MeshBasicMaterial {
  const key = kind + '|' + text
  let m = _murals.get(key)
  if (!m) {
    const W = 1024
    const H = 128
    const [c, ctx] = canvas(W, H)
    const theme = MURAL_THEMES[kind] ?? MURAL_THEMES.works!
    // ground + mouldings
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(0, 0, W, 7)
    ctx.fillRect(0, H - 7, W, 7)
    ctx.fillStyle = 'rgba(255,255,255,0.2)'
    ctx.fillRect(0, 7, W, 3)
    // end chevrons
    ctx.fillStyle = theme.accent
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(24 + i * 22, 26, 10, H - 52)
      ctx.fillRect(W - 34 - i * 22, 26, 10, H - 52)
    }
    // silhouette icon
    theme.icon(ctx, 110, H / 2)
    // lettering
    ctx.fillStyle = theme.fg
    let fs = 64
    ctx.font = `bold ${fs}px Arial, sans-serif`
    while (ctx.measureText(text).width > W - 360 && fs > 22) {
      fs -= 2
      ctx.font = `bold ${fs}px Arial, sans-serif`
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 190, H / 2 + 2)
    m = new THREE.MeshBasicMaterial({ map: tex(c, false), toneMapped: false })
    _murals.set(key, m)
  }
  return m
}

/* ---------------- dumpster / bin weathering texture ---------------- */

let _binGrime: THREE.CanvasTexture | null = null
export function getBinGrimeTexture(): THREE.CanvasTexture {
  if (!_binGrime) {
    const [c, ctx] = canvas(256, 128)
    ctx.fillStyle = '#b9b9b4'
    ctx.fillRect(0, 0, 256, 128)
    // horizontal ribs (body stiffeners)
    for (let y = 14; y < 128; y += 24) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      ctx.fillRect(0, y, 256, 5)
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      ctx.fillRect(0, y + 5, 256, 2)
    }
    // grime speckle
    const rng = mulberry32(51)
    for (let i = 0; i < 260; i++) {
      ctx.globalAlpha = 0.1 + rng() * 0.14
      ctx.fillStyle = rng() < 0.55 ? '#3c3c38' : '#e2e0d8'
      ctx.fillRect(rng() * 256, rng() * 128, 2 + rng() * 5, 1 + rng() * 3)
    }
    // rust streaks running down from the rim
    for (let i = 0; i < 10; i++) {
      const x = rng() * 256
      const w = 2 + rng() * 5
      const g = ctx.createLinearGradient(0, 0, 0, 40 + rng() * 70)
      g.addColorStop(0, 'rgba(122,74,48,0.5)')
      g.addColorStop(1, 'rgba(122,74,48,0)')
      ctx.fillStyle = g
      ctx.fillRect(x, 0, w, 40 + rng() * 70)
    }
    ctx.globalAlpha = 1
    _binGrime = tex(c)
  }
  return _binGrime
}

/* ---------------- ground textures (world-tiled, baked UVs) ----------------
 * Ground materials use texture.repeat = (1,1); the world-scale tiling is
 * baked per-geometry via worldUVPlane/worldUVBox so a 6 m tile stays 6 m on
 * a 20 m street AND on a 200 m arterial (the old global repeats stretched
 * the grain 10:1 lengthwise on long strips — the "flat looking ground").
 */

/** multiply-multiply a hex color */
function shade(hex: string, mul: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, Math.round(((n >> 16) & 255) * mul))
  const g = Math.min(255, Math.round(((n >> 8) & 255) * mul))
  const b = Math.min(255, Math.round((n & 255) * mul))
  return `rgb(${r},${g},${b})`
}

/** bake world-scale tiling into a plane/circle geometry's UVs (0..1 → sx/tile × sz/tile) */
export function worldUVPlane(geo: THREE.BufferGeometry, sx: number, sz: number, tile: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const su = Math.max(1, sx / tile)
  const sv = Math.max(1, sz / tile)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
  uv.needsUpdate = true
  return geo
}

/** bake world-scale tiling into a BoxGeometry's per-face UVs (len = x-size, wid = z-size) */
export function worldUVBox(geo: THREE.BufferGeometry, len: number, wid: number, tile: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const uTop = Math.max(1, len / tile)
  const vTop = Math.max(1, wid / tile)
  for (let f = 0; f < 6; f++) {
    let su = uTop
    let sv = vTop
    if (f === 0 || f === 1) { su = vTop; sv = 1 } // ±X faces span wid × height
    else if (f === 4 || f === 5) { su = uTop; sv = 1 } // ±Z faces span len × height
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv)
    }
  }
  uv.needsUpdate = true
  return geo
}

/** fill a geometry's color attribute with one flat tint (for vertexColors materials) */
export function tintGeo(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r
    arr[i * 3 + 1] = color.g
    arr[i * 3 + 2] = color.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

/** asphalt: aggregate, mottling, tar repairs, cracks, oil stains (+ bump) */
function groundAsphalt(size: number, seed: number, rough: boolean): [HTMLCanvasElement, HTMLCanvasElement] {
  const [c, ctx] = canvas(size, size)
  const [bc, bctx] = canvas(size, size)
  ctx.fillStyle = rough ? '#484a4d' : '#404346'
  ctx.fillRect(0, 0, size, size)
  bctx.fillStyle = '#808080'
  bctx.fillRect(0, 0, size, size)
  const rng = mulberry32(seed)
  // large tonal mottling (9-way wrapped so tiles stay seamless)
  const blob = (col: string, a: number, rMin: number, rMax: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const x = rng() * size
      const y = rng() * size
      const r = rMin + rng() * (rMax - rMin)
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r)
          g.addColorStop(0, col)
          g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.globalAlpha = a
          ctx.fillStyle = g
          ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2)
        }
      }
    }
  }
  blob(rough ? '#3c3e40' : '#393b3e', 0.2, size * 0.08, size * 0.25, 26)
  blob('#55585c', 0.14, size * 0.06, size * 0.2, 22)
  ctx.globalAlpha = 1
  // aggregate speckle
  const agg = rough
    ? ['#5b5e60', '#6a6d6f', '#3a3c3e', '#525456', '#77797b']
    : ['#4c4f52', '#56595c', '#34363a', '#5f6265', '#2c2e31']
  const dots = rough ? 5200 : 4200
  for (let i = 0; i < dots; i++) {
    ctx.globalAlpha = 0.14 + rng() * 0.3
    ctx.fillStyle = agg[Math.floor(rng() * agg.length)]
    ctx.beginPath()
    ctx.arc(rng() * size, rng() * size, (rough ? 1 : 0.8) + rng() * (rough ? 3.2 : 2.4), 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = 0; i < 2600; i++) {
    bctx.globalAlpha = 0.25 + rng() * 0.3
    bctx.fillStyle = rng() < 0.5 ? '#ffffff' : '#404040'
    bctx.beginPath()
    bctx.arc(rng() * size, rng() * size, 0.8 + rng() * (rough ? 2.6 : 1.8), 0, Math.PI * 2)
    bctx.fill()
  }
  ctx.globalAlpha = 1
  bctx.globalAlpha = 1
  // tar repair patches
  for (let i = 0; i < (rough ? 6 : 4); i++) {
    const w = size * (0.1 + rng() * 0.16)
    const h = size * (0.05 + rng() * 0.1)
    ctx.save()
    ctx.translate(rng() * size, rng() * size)
    ctx.rotate((rng() - 0.5) * 0.5)
    ctx.globalAlpha = 0.35 + rng() * 0.2
    ctx.fillStyle = rng() < 0.5 ? '#33363a' : '#4e5155'
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
  }
  // oil / fuel stains
  for (let i = 0; i < (rough ? 10 : 7); i++) {
    const x = rng() * size
    const y = rng() * size
    const r = size * (0.03 + rng() * 0.06)
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r)
        g.addColorStop(0, 'rgba(20,22,24,0.34)')
        g.addColorStop(0.7, 'rgba(20,22,24,0.12)')
        g.addColorStop(1, 'rgba(20,22,24,0)')
        ctx.fillStyle = g
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2)
      }
    }
  }
  // cracks — random-walk polylines drawn 9-way wrapped (precomputed path)
  const crack = (segs: number, step: number, width: number, alpha: number, col: string) => {
    let x = rng() * size
    let y = rng() * size
    let ang = rng() * Math.PI * 2
    const pts: [number, number][] = []
    for (let s = 0; s < segs; s++) {
      pts.push([x, y])
      ang += (rng() - 0.5) * 1.1
      x += Math.cos(ang) * step
      y += Math.sin(ang) * step
    }
    const stroke = (c2: CanvasRenderingContext2D, lw: number) => {
      c2.globalAlpha = alpha
      c2.strokeStyle = col
      c2.lineWidth = lw
      c2.lineCap = 'round'
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          c2.beginPath()
          c2.moveTo(pts[0][0] + ox, pts[0][1] + oy)
          for (const [px, py] of pts) c2.lineTo(px + ox, py + oy)
          c2.stroke()
        }
      }
    }
    stroke(ctx, width)
    stroke(bctx, width + 0.6)
  }
  for (let i = 0; i < (rough ? 14 : 9); i++) crack(4 + Math.floor(rng() * 9), size * 0.02, rough ? 1.6 : 1.1, 0.4, '#26282b')
  // tire-polish sheen bands (driven lanes only)
  if (!rough) {
    ctx.globalAlpha = 1
    for (const bx of [size * 0.3, size * 0.7]) {
      const g = ctx.createLinearGradient(bx - size * 0.07, 0, bx + size * 0.07, 0)
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.5, 'rgba(255,255,255,0.05)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(bx - size * 0.07, 0, size * 0.14, size)
    }
  }
  ctx.globalAlpha = 1
  bctx.globalAlpha = 1
  return [c, bc]
}

/** sidewalk: per-slab tinted pavers, joints, cracks, corner chips (+ bump) */
function groundSidewalk(size = 256): [HTMLCanvasElement, HTMLCanvasElement] {
  const [c, ctx] = canvas(size, size)
  const [bc, bctx] = canvas(size, size)
  const slabs = 4
  const sw = size / slabs
  const rng = mulberry32(33)
  bctx.fillStyle = '#909090'
  bctx.fillRect(0, 0, size, size)
  for (let sy = 0; sy < slabs; sy++) {
    for (let sx = 0; sx < slabs; sx++) {
      ctx.fillStyle = shade('#918f88', 0.86 + rng() * 0.24)
      ctx.fillRect(sx * sw, sy * sw, sw, sw)
      for (let i = 0; i < 60; i++) {
        ctx.globalAlpha = 0.05 + rng() * 0.06
        ctx.fillStyle = rng() < 0.5 ? '#6e6c66' : '#a8a6a0'
        ctx.fillRect(sx * sw + rng() * sw, sy * sw + rng() * sw, 1.5, 1.5)
      }
      bctx.globalAlpha = 0.5
      for (let i = 0; i < 22; i++) {
        bctx.fillStyle = rng() < 0.5 ? '#a5a5a5' : '#7c7c7c'
        bctx.fillRect(sx * sw + rng() * sw, sy * sw + rng() * sw, 1.5, 1.5)
      }
      bctx.globalAlpha = 1
      if (rng() < 0.13) {
        ctx.globalAlpha = 0.5
        ctx.strokeStyle = '#5b5952'
        ctx.lineWidth = 1
        ctx.beginPath()
        let x = sx * sw + rng() * sw
        let y = sy * sw
        ctx.moveTo(x, y)
        const steps = 3 + Math.floor(rng() * 3)
        for (let s2 = 0; s2 < steps; s2++) {
          x += (rng() - 0.5) * 14
          y += sw / steps
          ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      if (rng() < 0.1) {
        ctx.globalAlpha = 0.4
        ctx.fillStyle = '#6a6862'
        ctx.beginPath()
        ctx.arc(sx * sw + (rng() < 0.5 ? 0 : sw), sy * sw + (rng() < 0.5 ? 0 : sw), 3 + rng() * 4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  }
  const jw = 2
  for (let i = 0; i <= slabs; i++) {
    const p = Math.min(i * sw, size - jw)
    ctx.fillStyle = 'rgba(60,58,52,0.55)'
    ctx.fillRect(p, 0, jw, size)
    ctx.fillRect(0, p, size, jw)
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.fillRect(p + jw, 0, 1.5, size)
    ctx.fillRect(0, p + jw, size, 1.5)
    bctx.fillStyle = '#303030'
    bctx.fillRect(p, 0, 3, size)
    bctx.fillRect(0, p, size, 3)
  }
  return [c, bc]
}

/** lawn grass: mottled patches, blade strokes, mow bands, sparse flowers (+ bump) */
function groundGrass(size = 512, dark = false): [HTMLCanvasElement, HTMLCanvasElement] {
  const [c, ctx] = canvas(size, size)
  const [bc, bctx] = canvas(size, size)
  ctx.fillStyle = dark ? '#4c7a3c' : '#63914b'
  ctx.fillRect(0, 0, size, size)
  bctx.fillStyle = '#808080'
  bctx.fillRect(0, 0, size, size)
  const rng = mulberry32(dark ? 41 : 40)
  const patches: [string, number][] = dark
    ? [['#3e6a32', 0.22], ['#568a40', 0.16], ['#456f36', 0.18], ['#5e8a4a', 0.1]]
    : [['#578240', 0.2], ['#74a458', 0.16], ['#86a95d', 0.1], ['#5c8a48', 0.16], ['#96985a', 0.08]]
  for (const [col, a] of patches) {
    for (let i = 0; i < 22; i++) {
      const x = rng() * size
      const y = rng() * size
      const r = size * (0.04 + rng() * 0.11)
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r)
          g.addColorStop(0, col)
          g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.globalAlpha = a
          ctx.fillStyle = g
          ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2)
        }
      }
    }
  }
  // subtle mow bands aligned to the tile edge
  ctx.globalAlpha = dark ? 0.05 : 0.045
  for (let x = 0; x < size; x += size / 4) {
    ctx.fillStyle = (x / (size / 4)) % 2 === 0 ? '#ffffff' : '#000000'
    ctx.fillRect(x, 0, size / 8, size)
  }
  const greens = dark
    ? ['#33582a', '#2e5226', '#3f6a33', '#587f3d']
    : ['#4a7a36', '#528a3c', '#6da04a', '#3f6a30', '#7fae5a']
  for (let i = 0; i < 5200; i++) {
    ctx.globalAlpha = 0.16 + rng() * 0.3
    ctx.strokeStyle = greens[Math.floor(rng() * greens.length)]
    ctx.lineWidth = 1
    const x = rng() * size
    const y = rng() * size
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (rng() - 0.5) * 2, y - (2 + rng() * 4))
    ctx.stroke()
  }
  if (!dark) {
    for (let i = 0; i < 90; i++) {
      ctx.globalAlpha = 0.5 + rng() * 0.3
      ctx.fillStyle = rng() < 0.6 ? '#e8e4d0' : '#e8d88a'
      ctx.beginPath()
      ctx.arc(rng() * size, rng() * size, 0.9 + rng() * 1.1, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  bctx.globalAlpha = 0.3
  for (let i = 0; i < 2400; i++) {
    bctx.fillStyle = rng() < 0.5 ? '#8a8a8a' : '#767676'
    bctx.fillRect(rng() * size, rng() * size, 2, 2)
  }
  ctx.globalAlpha = 1
  bctx.globalAlpha = 1
  return [c, bc]
}

/** compacted-gravel park path: soil mottling + shadowed pebbles */
function groundPath(size = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size)
  ctx.fillStyle = '#a89b7e'
  ctx.fillRect(0, 0, size, size)
  const rng = mulberry32(44)
  for (let i = 0; i < 40; i++) {
    const x = rng() * size
    const y = rng() * size
    const r = size * (0.05 + rng() * 0.12)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, rng() < 0.5 ? '#97896c' : '#b7ab8c')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.16
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  const cols = ['#94876c', '#b8ac8e', '#c6ba98', '#867a60', '#d0c6a6']
  for (let i = 0; i < 900; i++) {
    const x = rng() * size
    const y = rng() * size
    const r = 0.8 + rng() * 2.2
    ctx.globalAlpha = 0.35
    ctx.fillStyle = '#6f6450'
    ctx.beginPath()
    ctx.ellipse(x + 0.8, y + 1, r * 1.1, r * 0.9, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 0.55 + rng() * 0.35
    ctx.fillStyle = cols[Math.floor(rng() * cols.length)]
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * 0.85, rng() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  return c
}

/** grey ballast gravel (industrial edges, rail yards) */
function groundGravel(size = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size)
  ctx.fillStyle = '#7d7a72'
  ctx.fillRect(0, 0, size, size)
  const rng = mulberry32(46)
  for (let i = 0; i < 70; i++) {
    const x = rng() * size
    const y = rng() * size
    const r = size * (0.04 + rng() * 0.1)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, rng() < 0.5 ? '#6e6b64' : '#8c8981')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.2
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  const cols = ['#66635c', '#8f8c84', '#a5a29a', '#56544e', '#b5b2aa']
  for (let i = 0; i < 1300; i++) {
    const x = rng() * size
    const y = rng() * size
    const r = 1.2 + rng() * 3
    ctx.globalAlpha = 0.4
    ctx.fillStyle = '#45433e'
    ctx.beginPath()
    ctx.ellipse(x + 1, y + 1.2, r * 1.15, r, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 0.6 + rng() * 0.35
    ctx.fillStyle = cols[Math.floor(rng() * cols.length)]
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * 0.82, rng() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  return c
}

/** civic plaza: running-bond stone pavers, bevels, replacement slabs (+ bump) */
function groundPlaza(size = 256): [HTMLCanvasElement, HTMLCanvasElement] {
  const [c, ctx] = canvas(size, size)
  const [bc, bctx] = canvas(size, size)
  const rng = mulberry32(45)
  ctx.fillStyle = '#6e675c'
  ctx.fillRect(0, 0, size, size)
  bctx.fillStyle = '#505050'
  bctx.fillRect(0, 0, size, size)
  const rows = 8
  const rh = size / rows
  const bw = size / 4
  for (let r2 = 0; r2 < rows; r2++) {
    const off = r2 % 2 === 0 ? 0 : -bw / 2
    for (let bx = -1; bx < 5; bx++) {
      const x = off + bx * bw
      const l = 0.88 + rng() * 0.26
      ctx.fillStyle = rng() < 0.12 ? shade('#b0a284', l * 0.9) : shade('#b5ab97', l)
      ctx.fillRect(x + 1.2, r2 * rh + 1.2, bw - 2.4, rh - 2.4)
      ctx.fillStyle = 'rgba(255,255,255,0.13)'
      ctx.fillRect(x + 1.2, r2 * rh + 1.2, bw - 2.4, 1.6)
      for (let i = 0; i < 26; i++) {
        ctx.globalAlpha = 0.05 + rng() * 0.07
        ctx.fillStyle = rng() < 0.5 ? '#8a8172' : '#d0c8b4'
        ctx.fillRect(x + 2 + rng() * (bw - 4), r2 * rh + 2 + rng() * (rh - 4), 1.5, 1.5)
      }
      if (rng() < 0.06) {
        ctx.globalAlpha = 0.5
        ctx.fillStyle = shade('#9a8f7a', 0.85)
        ctx.fillRect(x + 1.2, r2 * rh + 1.2, bw - 2.4, rh - 2.4)
      }
      ctx.globalAlpha = 1
      bctx.fillStyle = '#a8a8a8'
      bctx.fillRect(x + 1.2, r2 * rh + 1.2, bw - 2.4, rh - 2.4)
    }
  }
  for (let r2 = 0; r2 <= rows; r2++) {
    bctx.fillStyle = '#404040'
    bctx.fillRect(0, Math.min(r2 * rh, size - 2), size, 2.4)
  }
  for (let bx = 0; bx <= 4; bx++) {
    bctx.fillStyle = '#404040'
    bctx.fillRect(Math.min(bx * bw, size - 2), 0, 2.4, size)
  }
  return [c, bc]
}

/** wrap a canvas into a ground texture: repeat (1,1) — UVs carry the tiling */
function groundTex(c: HTMLCanvasElement, bump?: HTMLCanvasElement, bumpScale = 0.02): THREE.MeshStandardMaterial {
  const t = tex(c)
  t.repeat.set(1, 1)
  t.anisotropy = 8
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 })
  if (bump) {
    const bt = tex(bump)
    bt.repeat.set(1, 1)
    m.bumpMap = bt
    m.bumpScale = bumpScale
  }
  return m
}

/* ---------------- storefront texture ---------------- */

function storefrontTexture(frame: string, signBg: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 128)
  ctx.fillStyle = frame
  ctx.fillRect(0, 0, 256, 128)
  // sign band
  ctx.fillStyle = signBg
  ctx.fillRect(6, 6, 244, 30)
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = 'bold 17px Arial'
  ctx.textAlign = 'center'
  ctx.fillText('· SHOP ·', 128, 27)
  // glass
  ctx.fillStyle = '#3d4a46'
  ctx.fillRect(8, 42, 240, 80)
  ctx.fillStyle = 'rgba(255,240,200,0.20)'
  ctx.fillRect(8, 42, 240, 26)
  // mullions
  ctx.fillStyle = frame
  for (let x = 68; x < 248; x += 60) ctx.fillRect(x, 42, 5, 80)
  return tex(c)
}

/* ============================================================ */

export function createMaterials(): CityMaterials {
  const std = (color: number | string, rough = 0.9, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal })

  const [aspC, aspB] = groundAsphalt(512, 1, false)
  const asphalt = groundTex(aspC, aspB, 0.02)
  asphalt.roughness = 0.93
  const [asrC, asrB] = groundAsphalt(512, 2, true)
  const asphaltRough = groundTex(asrC, asrB, 0.03)
  asphaltRough.roughness = 0.98

  const [swC, swB] = groundSidewalk(256)
  const sidewalk = groundTex(swC, swB, 0.035)
  sidewalk.roughness = 0.9
  // pull the sidewalk tone down so it stops reading as blank white at high sun
  sidewalk.color = new THREE.Color('#cfcabc')

  const [grC, grB] = groundGrass(512, false)
  const grass = groundTex(grC, grB, 0.03)
  grass.roughness = 1

  const [gdC, gdB] = groundGrass(512, true)
  const grassDark = groundTex(gdC, gdB, 0.03)
  grassDark.roughness = 1

  const parkPath = groundTex(groundPath(256), undefined)
  parkPath.roughness = 0.95

  const gravel = groundTex(groundGravel(256), undefined)
  gravel.roughness = 0.98

  const [plC, plB] = groundPlaza(256)
  const plaza = groundTex(plC, plB, 0.03)
  plaza.roughness = 0.95
  // pull the plaza tone down — at high sun the warm pavers blew out to white
  plaza.color = new THREE.Color('#cfc8b6')

  // downtown block-court: big precast concrete panels, expansion joints,
  // service-box lids, tire wear — clearly distinct from the pedestrian
  // sidewalk (small slabs) and the civic plaza (warm stone pavers)
  const court = (() => {
    const [c, ctx] = canvas(256, 256)
    const [bc, bctx] = canvas(256, 256)
    const rng = mulberry32(47)
    ctx.fillStyle = '#7e7c74'
    ctx.fillRect(0, 0, 256, 256)
    bctx.fillStyle = '#606060'
    bctx.fillRect(0, 0, 256, 256)
    const cells = 2 // 2×2 panels per tile → 3.6 m panels on a 7.2 m tile
    const cw = 256 / cells
    for (let cy = 0; cy < cells; cy++) {
      for (let cx2 = 0; cx2 < cells; cx2++) {
        ctx.fillStyle = shade('#807e76', 0.9 + rng() * 0.2)
        ctx.fillRect(cx2 * cw + 2, cy * cw + 2, cw - 4, cw - 4)
        for (let i = 0; i < 90; i++) {
          ctx.globalAlpha = 0.05 + rng() * 0.08
          ctx.fillStyle = rng() < 0.5 ? '#6a6862' : '#96948c'
          ctx.fillRect(cx2 * cw + 2 + rng() * (cw - 4), cy * cw + 2 + rng() * (cw - 4), 2 + rng() * 3, 1.5 + rng() * 2.5)
        }
        ctx.globalAlpha = 1
        // tire-arc wear across some panels
        if (rng() < 0.5) {
          ctx.globalAlpha = 0.09
          ctx.strokeStyle = '#61605a'
          ctx.lineWidth = 7 + rng() * 8
          ctx.beginPath()
          const y0 = cy * cw + rng() * cw
          ctx.moveTo(cx2 * cw, y0)
          ctx.quadraticCurveTo(cx2 * cw + cw / 2, y0 + (rng() - 0.5) * 30, (cx2 + 1) * cw, y0 + (rng() - 0.5) * 24)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
        if (rng() < 0.3) {
          // service-box lid
          const s = 14 + rng() * 10
          const lx = cx2 * cw + 10 + rng() * (cw - 20 - s)
          const ly = cy * cw + 10 + rng() * (cw - 20 - s)
          ctx.globalAlpha = 0.85
          ctx.fillStyle = '#6d6b64'
          ctx.fillRect(lx, ly, s, s)
          ctx.globalAlpha = 0.5
          ctx.strokeStyle = '#4e4c46'
          ctx.lineWidth = 2
          ctx.strokeRect(lx, ly, s, s)
          ctx.globalAlpha = 1
        }
        bctx.fillStyle = '#3c3c3c'
        bctx.fillRect(cx2 * cw, cy * cw, 3, 256)
        bctx.fillRect(cx2 * cw, cy * cw, 256, 3)
      }
    }
    return groundTex(c, bc, 0.03)
  })()
  court.roughness = 0.94

  // facades — 21 families so districts never repeat the same face twice in a row
  const facades: FacadeMaterial[] = [
    makeFacade({ base: '#8f4f3a', window: '#2e2a26', frame: '#d8d0c0', pattern: 'brick', brick1: '#94573f', brick2: '#87483a' }),
    makeFacade({ base: '#7d5a42', window: '#2a2824', frame: '#c9c0ae', pattern: 'brick', brick1: '#82614a', brick2: '#72503a' }),
    makeFacade({ base: '#c9bfa8', window: '#33302a', frame: '#8a8474', pattern: 'plaster' }),
    makeFacade({ base: '#d3cbb2', window: '#38352e', frame: '#97917e', pattern: 'plaster' }),
    makeFacade({ base: '#a8b08c', window: '#2e3228', frame: '#6f7758', pattern: 'plaster' }),
    makeFacade({ base: '#b0aca0', window: '#3d4448', frame: '#5a5a56', pattern: 'panel' }),
    makeFacade({ base: '#9b9e98', window: '#363d42', frame: '#4a4d4e', pattern: 'panel' }),
    makeFacade({ base: '#b5ad9c', window: '#2e2b26', frame: '#8a8272', pattern: 'stone' }),
    makeFacade({ base: '#8d9094', window: '#33383c', frame: '#6a6e72', pattern: 'corrugated' }),
    makeFacade({ base: '#7e8a6e', window: '#2a2e26', frame: '#d0c8b4', pattern: 'painted' }),
    makeFacade({ base: '#5a463a', window: '#292520', frame: '#b3a890', pattern: 'brick', brick1: '#66503f', brick2: '#4e3c30' }),
    makeFacade({ base: '#a3542f', window: '#2e2a24', frame: '#e2d8c2', pattern: 'brick', brick1: '#a85c33', brick2: '#94482a' }),
    makeFacade({ base: '#ddd2b4', window: '#34302a', frame: '#c4b795', pattern: 'painted' }),
    makeFacade({ base: '#c08a62', window: '#38302a', frame: '#a8785a', pattern: 'painted' }),
    makeFacade({ base: '#8f9a72', window: '#2c3026', frame: '#75805c', pattern: 'painted' }),
    makeFacade({ base: '#b3ad9d', window: '#38342c', frame: '#98917e', pattern: 'stone', bigWin: true }),
    makeFacade({ base: '#6e7470', window: '#3a423e', frame: '#565c58', pattern: 'panel' }),
    makeFacade({ base: '#cfa668', window: '#383026', frame: '#b08850', pattern: 'plaster' }),
    // downtown mid-rise additions — bronze curtain grid, banded brick,
    // green glass grid — break the pale-panel monotony
    makeFacade({ base: '#5c5648', window: '#3a4642', frame: '#8a7440', pattern: 'panel', band: '#4a4438' }),
    makeFacade({ base: '#8a4f38', window: '#2c2824', frame: '#e2d4b0', pattern: 'brick', brick1: '#95553c', brick2: '#84482f', band: '#d8c9a4' }),
    makeFacade({ base: '#6a7a6c', window: '#2e4038', frame: '#3f4c44', pattern: 'panel', band: '#54645a' }),
  ]
  facades[5].storefront = true
  facades[6].storefront = true
  facades[16].storefront = true
  facades[19].storefront = true

  const glassTower = new THREE.MeshStandardMaterial({
    map: tex(curtainWallCanvas(256)),
    color: '#c2d4cc',
    metalness: 0.42,
    roughness: 0.3,
    emissive: new THREE.Color('#ffe9c0'),
    emissiveIntensity: 0,
    emissiveMap: tex(curtainWallEmissive(256)),
    vertexColors: true,
  })

  const signCache = new Map<string, THREE.MeshBasicMaterial>()

  return {
    asphalt,
    asphaltRough,
    roadLine: new THREE.MeshBasicMaterial({ color: '#dcdcd2' }),
    roadLineYellow: new THREE.MeshBasicMaterial({ color: '#c9a437' }),
    crosswalk: new THREE.MeshBasicMaterial({ color: '#d8d8ce' }),
    bikeLane: new THREE.MeshBasicMaterial({ color: '#3f7d52' }),
    sidewalk,
    curb: std('#a3a19a', 0.85),
    tramTrack: std('#54565a', 0.6, 0.5),
    gravel,
    plaza,
    court,
    grass,
    grassDark,
    parkPath,
    water: new THREE.MeshStandardMaterial({ color: '#3e6e63', roughness: 0.12, metalness: 0.15 }),
    trunk: new THREE.MeshStandardMaterial({ map: tex(noisy(64, '#6a5238', [{ color: '#57432c', n: 60, rMin: 1, rMax: 2 }], mulberry32(7))), roughness: 1 }),
    foliage: std('#4e7c3a', 1),
    foliageDark: std('#3d6330', 1),
    planter: std('#9c6b4f', 0.9),
    facades,
    glassTower,
    roofCommon: new THREE.MeshStandardMaterial({ map: tex(noisy(128, '#524f4a', [{ color: '#44423e', n: 150, rMin: 1, rMax: 3 }], mulberry32(8))), roughness: 0.95, vertexColors: true }),
    metal: std('#9aa0a2', 0.42, 0.8),
    metalDark: std('#4c5054', 0.5, 0.72),
    concrete: new THREE.MeshStandardMaterial({ map: tex(noisy(128, '#a5a199', [{ color: '#96928a', n: 140, rMin: 1, rMax: 3 }], mulberry32(9))), roughness: 0.9 }),
    concreteLight: new THREE.MeshStandardMaterial({ map: tex(noisy(128, '#c2beb2', [{ color: '#b2ae9f', n: 120, rMin: 1, rMax: 3 }], mulberry32(10))), roughness: 0.85 }),
    brickRed: std('#8f4f3a', 0.9),
    wood: new THREE.MeshStandardMaterial({
      map: tex(
        (() => {
          const [c, ctx] = canvas(128, 128)
          ctx.fillStyle = '#8a6a48'
          ctx.fillRect(0, 0, 128, 128)
          const rng = mulberry32(12)
          for (let y = 0; y < 128; y += 16) {
            ctx.fillStyle = `rgba(60,40,20,${0.25 + rng() * 0.2})`
            ctx.fillRect(0, y, 128, 2)
            ctx.fillStyle = `rgba(255,220,180,${0.06 + rng() * 0.08})`
            ctx.fillRect(0, y + 3, 128, 5)
          }
          return c
        })(),
      ),
      roughness: 0.85,
    }),
    white: std('#e8e6df', 0.6),
    black: std('#26282a', 0.7),
    poleMetal: std('#7c8084', 0.5, 0.65),
    streetlightHead: new THREE.MeshStandardMaterial({ color: '#c9c5b4', emissive: '#ffd9a0', emissiveIntensity: 0, roughness: 0.5, metalness: 0.4 }),
    neonRed: new THREE.MeshStandardMaterial({ color: '#7a2a22', emissive: '#ff5a4a', emissiveIntensity: 0.5, roughness: 0.6 }),
    neonGreen: new THREE.MeshStandardMaterial({ color: '#2a6a3a', emissive: '#4aff8a', emissiveIntensity: 0.5, roughness: 0.6 }),
    neonAmber: new THREE.MeshBasicMaterial({ color: '#ffb84a' }),
    fabricRed: new THREE.MeshStandardMaterial({
      map: tex(
        (() => {
          const [c, ctx] = canvas(64, 64)
          ctx.fillStyle = '#b04232'
          ctx.fillRect(0, 0, 64, 64)
          ctx.fillStyle = '#e8e0d0'
          ctx.fillRect(0, 0, 16, 64)
          ctx.fillRect(32, 0, 16, 64)
          return c
        })(),
      ),
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    fabricGreen: std('#4a8c5c', 0.9),
    fabricOrange: std('#d88a3a', 0.9),
    carPaints: ['#c94f3d', '#d8d4cc', '#5b7461', '#9a9da1', '#d8a832', '#3f4a42'].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.32, metalness: 0.65 })),
    glassDark: new THREE.MeshStandardMaterial({ color: '#44585a', roughness: 0.16, metalness: 0.42 }),
    tire: std('#1a1c1e', 0.96),
    headlight: new THREE.MeshBasicMaterial({ color: '#fff2c0', toneMapped: false }),
    taillight: new THREE.MeshBasicMaterial({ color: '#ff3a2a', toneMapped: false }),
    specialFacade(kind: string) {
      return getSpecialFacade(kind)
    },
    muralMaterial(text: string, kind: string) {
      return getMuralMaterial(text, kind)
    },
    signMaterial(text: string, opts) {
      const key = text + JSON.stringify(opts ?? {})
      let m = signCache.get(key)
      if (!m) {
        const w = opts?.w ?? Math.max(128, Math.min(512, text.length * 22))
        const h = opts?.h ?? 64
        const [c, ctx] = canvas(w, h)
        ctx.fillStyle = opts?.bg ?? '#20342a'
        ctx.fillRect(0, 0, w, h)
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'
        ctx.lineWidth = 3
        ctx.strokeRect(3, 3, w - 6, h - 6)
        ctx.fillStyle = opts?.fg ?? '#eaf2e2'
        let fs = Math.floor(h * 0.52)
        ctx.font = `bold ${fs}px Arial, sans-serif`
        while (ctx.measureText(text).width > w - 20 && fs > 10) {
          fs -= 2
          ctx.font = `bold ${fs}px Arial, sans-serif`
        }
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, w / 2, h / 2 + 1)
        m = new THREE.MeshBasicMaterial({ map: tex(c, false), toneMapped: false })
        signCache.set(key, m)
      }
      return m
    },
  }
}

// storefront materials shared for buildings.ts
const _storefrontMats = new Map<string, THREE.MeshStandardMaterial>()
export function getStorefrontMaterial(variant: number): THREE.MeshStandardMaterial {
  const frames: [string, string][] = [
    ['#2f4238', '#1f4d38'],
    ['#5c2a22', '#8c2f26'],
    ['#2e2e30', '#3a3a3c'],
    ['#6a5a2e', '#8a742f'],
  ]
  const key = String(variant % frames.length)
  let m = _storefrontMats.get(key)
  if (!m) {
    const [frame, sign] = frames[variant % frames.length]
    m = new THREE.MeshStandardMaterial({ map: storefrontTexture(frame, sign), roughness: 0.4, metalness: 0.2 })
    _storefrontMats.set(key, m)
  }
  return m
}

// mowed-stripe grass for sports pitches
let _pitchMat: THREE.MeshStandardMaterial | null = null
export function getPitchMaterial(): THREE.MeshStandardMaterial {
  if (!_pitchMat) {
    const [c, ctx] = canvas(256, 128)
    for (let x = 0; x < 256; x += 32) {
      ctx.fillStyle = x % 64 === 0 ? '#4f8340' : '#5c9449'
      ctx.fillRect(x, 0, 32, 128)
    }
    _pitchMat = new THREE.MeshStandardMaterial({ map: tex(c), roughness: 1 })
  }
  return _pitchMat
}

// chain-link fence with alpha
let _fenceMat: THREE.MeshStandardMaterial | null = null
export function getFenceMaterial(): THREE.MeshStandardMaterial {
  if (!_fenceMat) {
    const [c, ctx] = canvas(64, 64)
    ctx.clearRect(0, 0, 64, 64)
    ctx.strokeStyle = 'rgba(150,155,158,0.9)'
    ctx.lineWidth = 1.5
    for (let i = -64; i < 128; i += 8) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 64, 64); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(i + 64, 0); ctx.lineTo(i, 64); ctx.stroke()
    }
    const t = tex(c)
    _fenceMat = new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4, color: '#aab0b2' })
  }
  return _fenceMat
}
