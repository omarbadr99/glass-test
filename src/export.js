// Shareable-export helpers: deterministic video via WebCodecs + a muxer
// (standard, broadly-playable mp4/webm, up to 4K), with MediaRecorder as a
// fallback for browsers without WebCodecs.

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer'
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

export function webCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

function bitrateFor(width, height) {
  return Math.min(40_000_000, Math.max(6_000_000, Math.round(width * height * 3)))
}

// Find an encoder config the browser actually supports for this size. For mp4
// we try H.264 from high level down; if none fits (e.g. square 4K exceeds H.264
// limits) we fall back to VP9/VP8 in webm, which handle any size.
async function pickConfig(format, width, height, fps) {
  const bitrate = bitrateFor(width, height)
  const firstSupported = async (codecs) => {
    for (const codec of codecs) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps })
        if (r.supported) return codec
      } catch {
        /* keep trying */
      }
    }
    return null
  }
  if (format === 'mp4') {
    const avc = await firstSupported(['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d4028'])
    if (avc) return { container: 'mp4', muxerCodec: 'avc', codec: avc, ext: 'mp4', bitrate }
  }
  const vp9 = await firstSupported(['vp09.00.10.08', 'vp09.00.41.08'])
  if (vp9) return { container: 'webm', muxerCodec: 'V_VP9', codec: vp9, ext: 'webm', bitrate }
  const vp8 = await firstSupported(['vp8'])
  if (vp8) return { container: 'webm', muxerCodec: 'V_VP8', codec: 'vp8', ext: 'webm', bitrate }
  return null
}

// Render `durationSec * fps` frames deterministically and encode them into one
// seamless loop. Returns { blob, ext } — ext may differ from the requested
// format if it had to fall back (e.g. mp4 → webm at an unsupported size).
export async function encodeVideo(engine, { format, width, height, render, fps = 30, durationSec = 2 }) {
  const cfg = await pickConfig(format, width, height, fps)
  if (!cfg) throw new Error('No supported video encoder for this size — try a smaller frame size.')

  engine.renderer.setPixelRatio(1)
  engine.renderer.setSize(width, height, false)

  let target
  let muxer
  if (cfg.container === 'mp4') {
    target = new Mp4Target()
    muxer = new Mp4Muxer({
      target,
      video: { codec: cfg.muxerCodec, width, height },
      fastStart: 'in-memory',
    })
  } else {
    target = new WebmTarget()
    muxer = new WebmMuxer({ target, video: { codec: cfg.muxerCodec, width, height, frameRate: fps } })
  }

  let encodeError = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e
    },
  })
  const config = { codec: cfg.codec, width, height, bitrate: cfg.bitrate, framerate: fps }
  if (cfg.container === 'mp4') config.avc = { format: 'avc' } // AVCC for mp4-muxer
  encoder.configure(config)

  // Copy each GL frame through a 2D canvas (proven reliable) before wrapping it
  // in a VideoFrame for the encoder.
  const cap = document.createElement('canvas')
  cap.width = width
  cap.height = height
  const cctx = cap.getContext('2d')

  const total = Math.round(durationSec * fps)
  const usPerFrame = 1e6 / fps
  for (let i = 0; i < total; i++) {
    if (encodeError) throw encodeError
    while (encoder.encodeQueueSize > 2) await new Promise((r) => setTimeout(r))
    render(i / total)
    cctx.drawImage(engine.renderer.domElement, 0, 0, width, height)
    const frame = new VideoFrame(cap, {
      timestamp: Math.round(i * usPerFrame),
      duration: Math.round(usPerFrame),
    })
    encoder.encode(frame, { keyFrame: i % fps === 0 })
    frame.close()
  }
  await encoder.flush()
  if (encodeError) throw encodeError
  muxer.finalize()

  const type = cfg.container === 'mp4' ? 'video/mp4' : 'video/webm'
  return { blob: new Blob([target.buffer], { type }), ext: cfg.ext }
}

// ---- MediaRecorder fallback (older browsers without WebCodecs) ----

export function supportedVideoTypes() {
  if (typeof MediaRecorder === 'undefined') return []
  const candidates = [
    { format: 'mp4', mime: 'video/mp4' },
    { format: 'webm', mime: 'video/webm;codecs=vp9' },
    { format: 'webm', mime: 'video/webm;codecs=vp8' },
    { format: 'webm', mime: 'video/webm' },
  ]
  const out = []
  for (const c of candidates) {
    if (out.some((o) => o.format === c.format)) continue
    if (MediaRecorder.isTypeSupported(c.mime)) out.push(c)
  }
  return out
}

export function recordVideo(engine, { width, height, durationMs, mime, fps = 60, render }) {
  return new Promise((resolve, reject) => {
    engine.renderer.setPixelRatio(1)
    engine.renderer.setSize(width, height, false)
    const stream = engine.renderer.domElement.captureStream(fps)
    let rec
    try {
      rec = new MediaRecorder(stream, { mimeType: mime })
    } catch (e) {
      reject(e)
      return
    }
    const chunks = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onerror = (e) => reject(e.error || new Error('recording failed'))
    rec.onstop = () => resolve(new Blob(chunks, { type: mime.split(';')[0] }))
    const start = performance.now()
    const step = (now) => {
      const elapsed = now - start
      render((elapsed / durationMs) % 1)
      if (elapsed >= durationMs) rec.stop()
      else requestAnimationFrame(step)
    }
    try {
      rec.start()
    } catch (e) {
      reject(e)
      return
    }
    requestAnimationFrame(step)
  })
}

// ---- frame capture (shared by gif / lottie) ----

// Render `n` frames at width×height (2x supersampled, downscaled for clean
// edges) into a reusable 2D canvas and hand each to `onFrame`. Restores the
// live view afterward.
async function captureFrames(engine, width, height, n, onFrame) {
  engine.renderer.setPixelRatio(1)
  engine.renderer.setSize(width * 2, height * 2, false)
  const cap = document.createElement('canvas')
  cap.width = width
  cap.height = height
  const ctx = cap.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  for (let i = 0; i < n; i++) {
    engine.render(i / n)
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(engine.renderer.domElement, 0, 0, width * 2, height * 2, 0, 0, width, height)
    await onFrame(cap, ctx, i)
    if ((i & 7) === 0) await new Promise((r) => setTimeout(r)) // keep UI responsive
  }
  if (engine.viewW) engine.setView(engine.viewW, engine.viewH)
}

// ---- animated GIF ----

export async function encodeGif(engine, { width, height, frames, durationSec = 2, transparent = false }) {
  const gif = GIFEncoder()
  const delay = Math.round((durationSec * 1000) / frames)
  const format = transparent ? 'rgba4444' : 'rgb565'
  await captureFrames(engine, width, height, frames, (cap, ctx) => {
    const { data } = ctx.getImageData(0, 0, width, height)
    const palette = quantize(data, 256, { format, oneBitAlpha: transparent })
    const index = applyPalette(data, palette, format)
    gif.writeFrame(index, width, height, {
      palette,
      delay,
      repeat: 0, // loop forever
      transparent,
      dispose: transparent ? 2 : -1,
    })
  })
  gif.finish()
  return new Blob([gif.bytes()], { type: 'image/gif' })
}

// ---- Lottie JSON (image-sequence flipbook; plays in Framer / lottie-web) ----

function buildLottie(w, h, images, fps) {
  const n = images.length
  return {
    v: '5.9.0',
    fr: fps,
    ip: 0,
    op: n,
    w,
    h,
    nm: 'monolith',
    ddd: 0,
    assets: images.map((p, i) => ({ id: `image_${i}`, w, h, u: '', p, e: 1 })),
    // One image layer per frame, each visible for a single frame.
    layers: images.map((_, i) => ({
      ddd: 0,
      ind: i + 1,
      ty: 2,
      nm: `frame_${i}`,
      refId: `image_${i}`,
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [w / 2, h / 2, 0] },
        a: { a: 0, k: [w / 2, h / 2, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      ip: i,
      op: i + 1,
      st: i,
      bm: 0,
    })),
  }
}

export async function encodeLottie(engine, { width, height, frames, durationSec = 2 }) {
  const images = []
  await captureFrames(engine, width, height, frames, (cap) => {
    images.push(cap.toDataURL('image/png'))
  })
  const json = buildLottie(width, height, images, frames / durationSec)
  return new Blob([JSON.stringify(json)], { type: 'application/json' })
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
