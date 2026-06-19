// Shareable-export helpers. Batch 1 covers the video path (built-in
// MediaRecorder — no extra dependencies); GIF and animated PNG land in batch 2.

// MP4 (H.264) is the most universally shareable container but isn't encodable
// everywhere, so we probe and fall back to WebM. Returns one entry per distinct
// output format, in order of preference, each the browser actually supports.
export function supportedVideoTypes() {
  if (typeof MediaRecorder === 'undefined') return []
  // Prefer un-pinned codec strings so the browser can pick an H.264 level that
  // supports large frames (a fixed low level rejects 4K). Generic first.
  const candidates = [
    { format: 'mp4', mime: 'video/mp4' },
    { format: 'mp4', mime: 'video/mp4;codecs=avc1' },
    { format: 'mp4', mime: 'video/mp4;codecs=avc1.42E01E' },
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

// Records one seamless loop of the scene into a video Blob. The caller's
// `render(t)` drives the engine for each frame (t in [0, 1)); the canvas is
// captured as a stream while we step it in real time. Always opaque — video
// can't carry transparency, hence the always-baked-in background.
export function recordVideo(engine, { width, height, durationMs, mime, fps = 60, render }) {
  return new Promise((resolve, reject) => {
    engine.renderer.setPixelRatio(1)
    engine.renderer.setSize(width, height, false)

    const stream = engine.renderer.domElement.captureStream(fps)
    // Scale bitrate with resolution but keep it within encoder/level limits.
    const bitrate = Math.min(24_000_000, Math.max(8_000_000, Math.round(width * height * 3)))

    // Some encoders reject a given bitrate at large sizes; fall back to letting
    // the browser choose one.
    let rec
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate })
    } catch {
      try {
        rec = new MediaRecorder(stream, { mimeType: mime })
      } catch (e) {
        reject(e)
        return
      }
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

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
