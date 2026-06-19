import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Engine,
  MATERIAL_NAMES,
  SPIN_MOTIONS,
  OBJECT_MOTIONS,
  LIGHT_MOTIONS,
  BACKGROUNDS,
  computeGrid,
} from './engine'
import { PRESETS, shapesFromSVG } from './shapes'
import { supportedVideoTypes, recordVideo, downloadBlob } from './export'

const LOOP_SECONDS = 2

// CSS-sphere previews approximating each finish, shown in the material picker.
const MATERIAL_SWATCH = {
  chrome: 'radial-gradient(circle at 34% 28%, #ffffff, #cfd3d9 38%, #6b7077 74%, #2b2e33)',
  gunmetal: 'radial-gradient(circle at 34% 28%, #b6bcc5, #545a63 52%, #23262b)',
  gold: 'radial-gradient(circle at 34% 28%, #fff6cf, #ffc861 44%, #b9842f 80%, #5e421a)',
  copper: 'radial-gradient(circle at 34% 28%, #ffdcc6, #ff9466 44%, #b35a36 80%, #5e2f1c)',
  porcelain: 'radial-gradient(circle at 34% 28%, #ffffff, #f1efe9 56%, #cfcabf)',
  obsidian: 'radial-gradient(circle at 34% 28%, #565660, #16161a 56%, #050507)',
  glass:
    'radial-gradient(circle at 34% 28%, rgba(255,255,255,0.95), rgba(186,206,226,0.55) 52%, rgba(120,150,180,0.35))',
}

// Turn the subject's vector shapes into a tiny SVG path for the left strip.
function shapesToIcon(shapes, flipY) {
  const parts = []
  const xs = []
  const ys = []
  shapes.forEach((s) => {
    const { shape, holes } = s.extractPoints(22)
    const ring = (pts) => {
      if (!pts.length) return ''
      return (
        pts
          .map((p, i) => {
            const x = p.x
            const y = flipY ? -p.y : p.y
            xs.push(x)
            ys.push(y)
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
          })
          .join(' ') + ' Z'
      )
    }
    parts.push(ring(shape))
    holes.forEach((h) => parts.push(ring(h)))
  })
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const pad = Math.max(w, h) * 0.1
  return { d: parts.join(' '), vb: `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}` }
}

// Precompute preset icons once (presets are y-up math coords → flip for SVG).
const PRESET_ICONS = PRESETS.map((p) => ({ key: p.key, ...shapesToIcon(p.make(), true) }))

function SubjectIcon({ icon }) {
  return (
    <svg viewBox={icon.vb} className="subject-svg" aria-hidden="true">
      <path d={icon.d} fillRule="evenodd" />
    </svg>
  )
}

function cssSnippet(frames, w, h, cols, rows) {
  const sheetW = cols * w
  const sheetH = rows * h
  if (rows === 1) {
    return `.loop {
  width: ${w}px;
  height: ${h}px;
  background: url("sheet.png") 0 0 / ${sheetW}px ${h}px no-repeat;
  animation: loop ${LOOP_SECONDS}s steps(${frames}) infinite;
}
@keyframes loop {
  to { background-position: -${sheetW}px 0; }
}`
  }
  const rowSeconds = ((LOOP_SECONDS * cols) / frames).toFixed(3)
  return `.loop {
  width: ${w}px;
  height: ${h}px;
  background: url("sheet.png") 0 0 / ${sheetW}px ${sheetH}px no-repeat;
  animation:
    loop-x ${rowSeconds}s steps(${cols}) infinite,
    loop-y ${LOOP_SECONDS}s steps(${rows}) infinite;
}
@keyframes loop-x {
  to { background-position-x: -${sheetW}px; }
}
@keyframes loop-y {
  to { background-position-y: -${sheetH}px; }
}`
}

// Frame aspect ratios for the viewport / export.
const RATIOS = {
  '1:1': [1, 1],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '4:3': [4, 3],
  '3:4': [3, 4],
}
const RATIO_KEYS = Object.keys(RATIOS)

function downloadCanvas(canvas, filename, done) {
  canvas.toBlob((blob) => {
    downloadBlob(blob, filename)
    done?.(blob)
  }, 'image/png')
}

// iOS-style segmented control.
function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o}
          className={`segment${o === value ? ' on' : ''}`}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

function Slider({ label, value, display, min, max, step, onChange }) {
  return (
    <div className="field">
      <div className="field-head">
        <span>{label}</span>
        <span className="field-val">{display ?? value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

// Playback transport under the frame. Runs its own rAF to track the shared
// playhead so the rest of the app doesn't re-render every frame.
function Transport({ playingRef, playheadRef }) {
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(true)
  useEffect(() => {
    let raf
    const tick = () => {
      setPos(playheadRef.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playheadRef])

  const toggle = () => {
    const next = !playing
    setPlaying(next)
    playingRef.current = next
  }
  const scrub = (e) => {
    const v = Number(e.target.value)
    playheadRef.current = v
    setPos(v)
    if (playing) {
      setPlaying(false)
      playingRef.current = false
    }
  }

  return (
    <div className="transport">
      <button className="play" onClick={toggle} aria-label={playing ? 'pause' : 'play'}>
        {playing ? (
          <svg viewBox="0 0 24 24">
            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <input className="scrub" type="range" min={0} max={1} step={0.001} value={pos} onChange={scrub} />
      <span className="time">
        {(pos * LOOP_SECONDS).toFixed(1)}s / {LOOP_SECONDS.toFixed(1)}s
      </span>
    </div>
  )
}

export default function App() {
  const canvasRef = useRef(null)
  const viewportRef = useRef(null)
  const frameAreaRef = useRef(null)
  const fileRef = useRef(null)
  const bgFileRef = useRef(null)
  const pausedRef = useRef(false)
  const playingRef = useRef(true)
  const playheadRef = useRef(0)
  const [engine, setEngine] = useState(null)
  const [frameRatio, setFrameRatio] = useState('1:1')
  const [frameBox, setFrameBox] = useState({ w: 0, h: 0 })

  const [subject, setSubject] = useState('star')
  const [upload, setUpload] = useState(null) // { name, shapes }
  const [uploadError, setUploadError] = useState('')
  const [material, setMaterial] = useState('chrome')
  const [tint, setTint] = useState('#4da3ff')
  const [tintAmount, setTintAmount] = useState(0)
  const [reflectivity, setReflectivity] = useState(0.5)
  const [size, setSize] = useState(1)
  const [distance, setDistance] = useState(0)
  const [depth, setDepth] = useState(0.22)
  const [bevel, setBevel] = useState(0.04)
  const [bgKind, setBgKind] = useState('color') // 'color' | 'transparent' | 'image'
  const [bgColor, setBgColor] = useState(BACKGROUNDS[0])
  const [bgImage, setBgImage] = useState(null) // { src, name }
  const [spin, setSpin] = useState('turntable')
  const [objectMotion, setObjectMotion] = useState('none')
  const [lightMotion, setLightMotion] = useState('none')
  const [frames, setFrames] = useState(48)
  const [frameSize, setFrameSize] = useState(256)

  const background = useMemo(() => {
    if (bgKind === 'transparent') return { kind: 'transparent' }
    if (bgKind === 'image' && bgImage) return { kind: 'image', src: bgImage.src }
    return { kind: 'color', color: bgColor }
  }, [bgKind, bgColor, bgImage])

  // Frame aspect → export/preview cell dimensions (frameSize is the long side).
  const [rw, rh] = RATIOS[frameRatio]
  const frameAr = rw / rh
  const cellW = frameAr >= 1 ? frameSize : Math.round(frameSize * frameAr)
  const cellH = frameAr >= 1 ? Math.round(frameSize / frameAr) : frameSize
  const posterW = frameAr >= 1 ? 1024 : Math.round(1024 * frameAr)
  const posterH = frameAr >= 1 ? Math.round(1024 / frameAr) : 1024
  const previewW = frameAr >= 1 ? 96 : Math.round(96 * frameAr)
  const previewH = frameAr >= 1 ? Math.round(96 / frameAr) : 96

  const uploadIcon = useMemo(
    () => (upload ? shapesToIcon(upload.shapes, false) : null),
    [upload]
  )

  const videoTypes = useMemo(() => supportedVideoTypes(), [])
  const formats = useMemo(() => ['sheet', ...videoTypes.map((v) => v.format)], [videoTypes])
  const [format, setFormat] = useState('sheet')
  // Sprite sheets are capped by the canvas size limit; video frames are encoded
  // individually, so they can go up to 4K (long side).
  const maxFrameSize = format === 'sheet' ? 1024 : 3840

  const [preview, setPreview] = useState(null) // { url, kb }
  const [baked, setBaked] = useState(null) // { format, ... }
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  // Drop back under the sprite-sheet limit when switching to a sheet export.
  useEffect(() => {
    if (format === 'sheet') setFrameSize((s) => Math.min(s, 1024))
  }, [format])

  // Create the engine and run the preview loop.
  useEffect(() => {
    const eng = new Engine(canvasRef.current)
    let raf
    let last = performance.now()
    const tick = (now) => {
      // Paused while a video records (recorder drives its own frames).
      if (!pausedRef.current) {
        const dt = now - last
        if (playingRef.current) {
          playheadRef.current = (playheadRef.current + dt / (LOOP_SECONDS * 1000)) % 1
        }
        eng.render(playheadRef.current)
      }
      last = now
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    setEngine(eng)
    return () => {
      cancelAnimationFrame(raf)
      eng.dispose()
      setEngine(null)
    }
  }, [])

  // Fit the frame to the largest box that matches the aspect ratio and fills
  // the available area; re-runs when the ratio changes or the area resizes.
  useEffect(() => {
    if (!engine) return
    const area = frameAreaRef.current
    const [arw, arh] = RATIOS[frameRatio]
    const ar = arw / arh
    const fit = () => {
      const availW = area.clientWidth
      const availH = area.clientHeight
      let w = availW
      let h = w / ar
      if (h > availH) {
        h = availH
        w = h * ar
      }
      w = Math.max(64, Math.floor(w))
      h = Math.max(64, Math.floor(h))
      setFrameBox({ w, h })
      engine.setView(Math.min(w, 1440), Math.min(h, 1440))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(area)
    return () => ro.disconnect()
  }, [engine, frameRatio])

  useEffect(() => {
    if (!engine) return
    if (subject === 'upload' && upload) engine.setShapes(upload.shapes, false)
    else {
      const preset = PRESETS.find((p) => p.key === subject) ?? PRESETS[0]
      engine.setShapes(preset.make(), true)
    }
  }, [engine, subject, upload])

  useEffect(() => {
    if (!engine) return
    engine.applySettings({
      material,
      tint,
      tintAmount,
      reflectivity,
      size,
      distance,
      depth,
      bevel,
      background,
      spin,
      object: objectMotion,
      light: lightMotion,
    })
  }, [
    engine,
    material,
    tint,
    tintAmount,
    reflectivity,
    size,
    distance,
    depth,
    bevel,
    background,
    spin,
    objectMotion,
    lightMotion,
  ])

  // Re-bake the low-res preview strip whenever anything changes (debounced).
  useEffect(() => {
    if (!engine) return
    const id = setTimeout(() => {
      const strip = engine.bakeStrip(frames, previewW, previewH)
      strip.toBlob((blob) => {
        setPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev.url)
          return { url: URL.createObjectURL(blob), kb: Math.max(1, Math.round(blob.size / 1024)) }
        })
      }, 'image/png')
    }, 350)
    return () => clearTimeout(id)
  }, [
    engine,
    subject,
    upload,
    material,
    tint,
    tintAmount,
    reflectivity,
    size,
    distance,
    depth,
    bevel,
    background,
    spin,
    objectMotion,
    lightMotion,
    frames,
    previewW,
    previewH,
  ])

  const onUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const { shapes } = shapesFromSVG(reader.result)
        setUpload({ name: file.name, shapes })
        setSubject('upload')
        setUploadError('')
      } catch (err) {
        setUploadError(err.message)
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const onBgUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setBgImage({ src: reader.result, name: file.name })
      setBgKind('image')
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const bakeSheet = () => {
    const { canvas, cols, rows } = engine.bakeSheet(frames, cellW, cellH)
    downloadCanvas(canvas, 'sheet.png', (blob) => {
      setBaked({
        format: 'sheet',
        kb: Math.round(blob.size / 1024),
        width: canvas.width,
        height: canvas.height,
        cols,
        rows,
        cw: cellW,
        ch: cellH,
        frames,
      })
    })
    downloadCanvas(engine.bakePoster(posterW, posterH), 'poster.png')
  }

  const bakeVideo = async () => {
    const type = videoTypes.find((v) => v.format === format)
    if (!type) return
    setBusy(true)
    pausedRef.current = true
    try {
      const blob = await recordVideo(engine, {
        width: cellW,
        height: cellH,
        durationMs: LOOP_SECONDS * 1000,
        mime: type.mime,
        render: (t) => engine.render(t),
      })
      downloadBlob(blob, `loop.${type.format}`)
      setBaked({ format: 'video', ext: type.format, kb: Math.round(blob.size / 1024) })
    } catch (err) {
      setBaked({ format: 'error', message: err.message })
    } finally {
      pausedRef.current = false
      if (engine.viewW) engine.setView(engine.viewW, engine.viewH)
      setBusy(false)
    }
  }

  const bake = () => {
    if (busy || !engine) return
    if (format === 'sheet') bakeSheet()
    else bakeVideo()
  }

  const grid = computeGrid(frames, cellW)
  const copyCss = () => {
    const b = baked?.format === 'sheet' ? baked : { frames, cw: cellW, ch: cellH, cols: grid.cols, rows: grid.rows }
    navigator.clipboard.writeText(cssSnippet(b.frames, b.cw, b.ch, b.cols, b.rows)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const exportLabel = busy ? (format === 'sheet' ? 'Baking…' : 'Recording…') : 'Export'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          monolith
        </div>
        <button
          className={`btn-primary${exportOpen ? ' open' : ''}`}
          onClick={() => setExportOpen((o) => !o)}
          disabled={!engine}
          aria-expanded={exportOpen}
        >
          Export
        </button>
      </header>

      <div className="workspace">
        {/* LEFT — subject strip */}
        <aside className="rail-left">
          <div className="rail-label">Shapes</div>
          <div className="shape-strip">
            {PRESET_ICONS.map((p) => (
              <button
                key={p.key}
                className={`shape-btn${subject === p.key ? ' active' : ''}`}
                onClick={() => setSubject(p.key)}
                title={p.key}
              >
                <SubjectIcon icon={p} />
              </button>
            ))}
            {upload && uploadIcon && (
              <button
                className={`shape-btn${subject === 'upload' ? ' active' : ''}`}
                onClick={() => setSubject('upload')}
                title={upload.name}
              >
                <SubjectIcon icon={uploadIcon} />
              </button>
            )}
            <button
              className="shape-btn add"
              onClick={() => fileRef.current.click()}
              title="upload svg"
            >
              +
            </button>
          </div>
          {uploadError && <p className="error">{uploadError}</p>}
          <input ref={fileRef} type="file" accept=".svg,image/svg+xml" hidden onChange={onUpload} />
        </aside>

        {/* CENTER — frame, ratio bar, timeline, frames drawer */}
        <main className="stage">
          <div className="frame-area" ref={frameAreaRef}>
            <div
              className={`frame${bgKind === 'transparent' ? ' checker' : ''}`}
              ref={viewportRef}
              style={{ width: frameBox.w || undefined, height: frameBox.h || undefined }}
            >
              <canvas ref={canvasRef} />
            </div>
          </div>

          <div className="ratio-bar">
            {RATIO_KEYS.map((key) => {
              const [w, h] = RATIOS[key]
              return (
                <button
                  key={key}
                  className={`ratio${frameRatio === key ? ' on' : ''}`}
                  onClick={() => setFrameRatio(key)}
                  title={key}
                >
                  <span className="ratio-box" style={{ aspectRatio: `${w} / ${h}` }} />
                  <span className="ratio-label">{key}</span>
                </button>
              )
            })}
          </div>

          <Transport playingRef={playingRef} playheadRef={playheadRef} />

          <details className="frames-drawer">
            <summary>
              Frames
              <span className="muted">
                {preview ? ` · ${frames} · ${cellW}×${cellH} · ${preview.kb}KB` : ' · baking…'}
              </span>
            </summary>
            <div className="filmstrip">
              {preview ? (
                <img src={preview.url} alt="baked frame strip preview" />
              ) : (
                <div className="strip-empty" />
              )}
            </div>
          </details>
        </main>

        {/* RIGHT — controls */}
        <aside className="rail-right">
          <div className="card">
            <div className="card-title">Material</div>
            <div className="mat-grid">
              {MATERIAL_NAMES.map((m) => (
                <button
                  key={m}
                  className={`mat${m === material ? ' active' : ''}`}
                  onClick={() => setMaterial(m)}
                >
                  <span className="mat-ball" style={{ background: MATERIAL_SWATCH[m] }} />
                  <span className="mat-name">{m}</span>
                </button>
              ))}
            </div>
            <Slider
              label="Reflectivity"
              value={reflectivity}
              display={
                reflectivity <= 0.04 ? 'matte' : reflectivity >= 0.96 ? 'mirror' : `${Math.round(reflectivity * 100)}%`
              }
              min={0}
              max={1}
              step={0.02}
              onChange={setReflectivity}
            />
            <Slider
              label="Depth"
              value={depth}
              display={depth.toFixed(2)}
              min={0.04}
              max={0.6}
              step={0.01}
              onChange={setDepth}
            />
            <Slider
              label="Bevel"
              value={bevel}
              display={bevel.toFixed(3)}
              min={0}
              max={0.12}
              step={0.005}
              onChange={setBevel}
            />
            <div className="field inline">
              <span>Tint</span>
              <label className="swatch picker" style={{ background: tint }}>
                <input type="color" value={tint} onChange={(e) => setTint(e.target.value)} />
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={tintAmount}
                onChange={(e) => setTintAmount(Number(e.target.value))}
              />
              <span className="field-val">{Math.round(tintAmount * 100)}%</span>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Background</div>
            <div className="swatches">
              <button
                className={`swatch checker${bgKind === 'transparent' ? ' active' : ''}`}
                onClick={() => setBgKind('transparent')}
                aria-label="transparent background"
              />
              {BACKGROUNDS.map((c) => (
                <button
                  key={c}
                  className={`swatch${bgKind === 'color' && bgColor === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => {
                    setBgColor(c)
                    setBgKind('color')
                  }}
                  aria-label={`background ${c}`}
                />
              ))}
              <label
                className={`swatch picker${bgKind === 'color' && !BACKGROUNDS.includes(bgColor) ? ' active' : ''}`}
                style={{ background: bgColor }}
              >
                <input
                  type="color"
                  value={bgColor}
                  onChange={(e) => {
                    setBgColor(e.target.value)
                    setBgKind('color')
                  }}
                />
              </label>
            </div>
            <div className="row">
              <button className="btn-ghost" onClick={() => bgFileRef.current.click()}>
                {bgImage ? `Image: ${bgImage.name}` : 'Upload image'}
              </button>
              {bgImage && bgKind !== 'image' && (
                <button className="btn-ghost" onClick={() => setBgKind('image')}>
                  Use image
                </button>
              )}
            </div>
            <input ref={bgFileRef} type="file" accept="image/*" hidden onChange={onBgUpload} />
            <p className="hint">
              {bgKind === 'transparent'
                ? 'Transparent — PNG keeps alpha; video falls back to black.'
                : 'Baked into every export.'}
            </p>
          </div>

          <div className="card">
            <div className="card-title">Placement</div>
            <Slider
              label="Size"
              value={size}
              display={`${Math.round(size * 100)}%`}
              min={0.4}
              max={2.5}
              step={0.05}
              onChange={setSize}
            />
            <Slider
              label="Distance"
              value={distance}
              display={distance === 0 ? 'flat' : distance > 0 ? `+${distance.toFixed(1)}` : distance.toFixed(1)}
              min={-3}
              max={2}
              step={0.1}
              onChange={setDistance}
            />
          </div>

          <div className="card">
            <div className="card-title">Motion</div>
            <div className="field inline">
              <span>Spin</span>
              <Segmented options={SPIN_MOTIONS} value={spin} onChange={setSpin} />
            </div>
            <div className="field inline">
              <span>Object</span>
              <Segmented options={OBJECT_MOTIONS} value={objectMotion} onChange={setObjectMotion} />
            </div>
            <div className="field inline">
              <span>Light</span>
              <Segmented options={LIGHT_MOTIONS} value={lightMotion} onChange={setLightMotion} />
            </div>
          </div>
        </aside>
      </div>

      {exportOpen && (
        <>
          <div className="popover-backdrop" onClick={() => setExportOpen(false)} />
          <div className="export-popover" role="dialog" aria-label="Export options">
            <div className="card-title">Export</div>
            <Slider label="Frames" value={frames} min={8} max={96} step={4} onChange={setFrames} />
            <Slider
              label="Frame size"
              value={frameSize}
              display={`${cellW}×${cellH}`}
              min={64}
              max={maxFrameSize}
              step={64}
              onChange={setFrameSize}
            />
            <div className="field inline">
              <span>Format</span>
              <Segmented options={formats} value={format} onChange={setFormat} />
            </div>
            <p className="hint">
              {format === 'sheet'
                ? grid.rows > 1
                  ? `Sharp & CSS-playable · ${grid.cols}×${grid.rows} grid sheet`
                  : 'Sharp & CSS-playable · single-row strip'
                : `Smallest & smooth · up to 4K (${cellW}×${cellH})`}
            </p>
            <button className="btn-primary wide" onClick={bake} disabled={!engine || busy}>
              {busy ? exportLabel : format === 'sheet' ? 'Bake sheet + poster' : `Bake ${format}`}
            </button>

            {baked?.format === 'sheet' && (
              <div className="result">
                <p className="hint">
                  Downloaded sheet.png ({baked.width}×{baked.height} · {baked.kb}KB) and poster.png.
                </p>
                <pre>{cssSnippet(baked.frames, baked.cw, baked.ch, baked.cols, baked.rows)}</pre>
                <button className="btn-ghost" onClick={copyCss}>
                  {copied ? 'Copied' : 'Copy CSS'}
                </button>
              </div>
            )}
            {baked?.format === 'video' && (
              <p className="hint result">
                Downloaded loop.{baked.ext} ({baked.kb}KB) — a {LOOP_SECONDS}s seamless loop.
              </p>
            )}
            {baked?.format === 'error' && <p className="error result">{baked.message}</p>}
          </div>
        </>
      )}
    </div>
  )
}
