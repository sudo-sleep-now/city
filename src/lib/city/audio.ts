/* ============================================================
 * AmbientAudio — 100% procedural WebAudio ambience (no assets):
 *   · rain       — looped filtered noise, gain follows weather.rain
 *   · birds      — daytime chirps (swept sine blips), suppressed by rain
 *   · crickets   — soft pulsed tone at night (low volume)
 * NOTE: the old constant WIND loop was REMOVED — a permanent
 * band-passed noise bed gave users headaches (round-13 feedback).
 * There is deliberately NO always-on sound source anymore; the
 * default ambience is SILENCE, broken only by weather/life events.
 * Started from the user gesture (Enter button). Indoors everything
 * is muffled. M toggles mute (also a HUD button on touch).
 * ============================================================ */

export interface AmbientInput {
  rain: number
  night: number
  inside: boolean
  /** 0..1 emergency-siren loudness — event-gated, 0 = silent (default) */
  siren?: number
}

export class AmbientAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private rainGain: GainNode | null = null
  private cricketGain: GainNode | null = null
  private birdTimer = 3
  private muted = false
  private started = false
  // siren voice — created lazily on the FIRST emergency event, removed
  // (gain 0) whenever no unit is responding. Never an always-on source.
  private sirenOsc: OscillatorNode | null = null
  private sirenLfo: OscillatorNode | null = null
  private sirenGain: GainNode | null = null

  /** must be called from a user-gesture handler */
  start() {
    if (this.started) return
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      this.ctx = new Ctx()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.7
      this.master.connect(this.ctx.destination)

      // shared noise buffer (2 s white noise)
      const len = this.ctx.sampleRate * 2
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1

      // rain: lowpassed noise
      const rainSrc = this.ctx.createBufferSource()
      rainSrc.buffer = buf
      rainSrc.loop = true
      const rainLP = this.ctx.createBiquadFilter()
      rainLP.type = 'lowpass'
      rainLP.frequency.value = 1100
      const rainHP = this.ctx.createBiquadFilter()
      rainHP.type = 'highpass'
      rainHP.frequency.value = 350
      this.rainGain = this.ctx.createGain()
      this.rainGain.gain.value = 0
      rainSrc.connect(rainHP).connect(rainLP).connect(this.rainGain).connect(this.master)
      rainSrc.start()

      // crickets: soft pulsed tone (gain gated by an LFO square-ish shape).
      // Deliberately quiet + lower pitch — a loud 4.3 kHz whine reads as
      // tinnitus-inducing rather than pleasant.
      const crk = this.ctx.createOscillator()
      crk.type = 'triangle'
      crk.frequency.value = 3400
      this.cricketGain = this.ctx.createGain()
      this.cricketGain.gain.value = 0
      const crkLfo = this.ctx.createOscillator()
      crkLfo.type = 'square'
      crkLfo.frequency.value = 14
      const crkLfoGain = this.ctx.createGain()
      crkLfoGain.gain.value = 0.0018
      crkLfo.connect(crkLfoGain).connect(this.cricketGain.gain)
      crk.connect(this.cricketGain).connect(this.master)
      crk.start()
      crkLfo.start()

      this.started = true
    } catch {
      // audio unavailable — stay silent
    }
  }

  get isMuted() {
    return this.muted
  }

  toggleMute() {
    this.muted = !this.muted
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.7, this.ctx.currentTime, 0.15)
    }
    return this.muted
  }

  update(dt: number, input: AmbientInput) {
    if (!this.started || !this.ctx || !this.rainGain || !this.cricketGain) return
    const t = this.ctx.currentTime
    const muffle = input.inside ? 0.3 : 1
    this.rainGain.gain.setTargetAtTime(0.16 * input.rain * muffle, t, 0.4)
    this.cricketGain.gain.setTargetAtTime(input.night > 0.55 && input.rain < 0.4 && !input.inside ? 0.0022 * (input.night - 0.55) * 4 : 0, t, 0.8)

    // emergency siren — European two-tone (Martin horn) wail, volume by
    // distance to the responding units; silent the moment the scene ends
    const level = Math.min(1, Math.max(0, input.siren ?? 0)) * muffle
    if (level > 0.001) {
      if (!this.sirenOsc && this.master) {
        const osc = this.ctx.createOscillator()
        osc.type = 'triangle'
        osc.frequency.value = 660
        const lfo = this.ctx.createOscillator()
        lfo.type = 'square'
        lfo.frequency.value = 0.85
        const lfoGain = this.ctx.createGain()
        lfoGain.gain.value = 105 // alternates 555 ↔ 765 Hz
        lfo.connect(lfoGain).connect(osc.frequency)
        this.sirenGain = this.ctx.createGain()
        this.sirenGain.gain.value = 0
        osc.connect(this.sirenGain).connect(this.master)
        osc.start()
        lfo.start()
        this.sirenOsc = osc
        this.sirenLfo = lfo
      }
      this.sirenGain?.gain.setTargetAtTime(0.038 * level * level, t, 0.25)
    } else if (this.sirenGain) {
      this.sirenGain.gain.setTargetAtTime(0, t, 0.5)
    }

    // daytime birds — random chirps every 2.5–8 s
    this.birdTimer -= dt
    if (this.birdTimer <= 0) {
      this.birdTimer = 2.5 + Math.random() * 5.5
      if (input.night < 0.35 && input.rain < 0.35 && !input.inside && !this.muted) {
        this.chirp()
      }
    }
  }

  private chirp() {
    if (!this.ctx || !this.master) return
    const notes = 2 + Math.floor(Math.random() * 3)
    let at = this.ctx.currentTime + 0.05
    const base = 2300 + Math.random() * 900
    for (let n = 0; n < notes; n++) {
      const osc = this.ctx.createOscillator()
      osc.type = 'sine'
      const g = this.ctx.createGain()
      const f0 = base + n * 140 + Math.random() * 200
      osc.frequency.setValueAtTime(f0, at)
      osc.frequency.exponentialRampToValueAtTime(f0 * (1.15 + Math.random() * 0.2), at + 0.07)
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.9, at + 0.12)
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(0.014 + Math.random() * 0.008, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0005, at + 0.13)
      osc.connect(g).connect(this.master)
      osc.start(at)
      osc.stop(at + 0.15)
      at += 0.14 + Math.random() * 0.1
    }
  }

  dispose() {
    try {
      this.sirenOsc?.stop()
      this.sirenLfo?.stop()
      this.ctx?.close()
    } catch {
      /* noop */
    }
    this.ctx = null
    this.sirenOsc = null
    this.sirenLfo = null
    this.sirenGain = null
    this.started = false
  }
}
