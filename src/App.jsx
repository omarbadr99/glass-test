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

// CSS that plays the baked sheet. A single row uses one steps() animation; a
// wrapped grid steps across columns each row and advances rows over the loop.
function cssSnippet(frames, size, cols, rows) {
  const sheetW = cols * size
  const sheetH = rows * size
  if (rows === 1) {
    return `.loop {
  width: ${size}px;
  height: ${size}px;
  background: url("sheet.png") 0 0 / ${sheetW}px ${size}px no-repeat;
  animation: loop ${LOOP_SECONDS}s steps(${frames}) infinite;
}
@keyframes loop {
  to { background-position: -${sheetW}px 0; }
}`
  }
  const rowSeconds = ((LOOP_SECONDS * cols) / frames).toFixed(3)
  return `.loop {
  width: ${size}px;
  height: ${size}px;
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

function downloadCanvas(canvas, filename, done) {
  canvas.toBlob((blob) => {
    downloadBlob(blob, filename)
    done?.(blob)
  }, 'image/png')
}

function Chips({ options, value, onChange }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={o}
          className={`chip${o === value ? ' active' : ''}`}
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
    <div className="slider">
      <div className="slider-head">
        <span>{label}</span>
        <span>{display ?? value}</span>
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

export default function App() {
  const canvasRef = useRef(null)
  const viewportRef = useRef(null)
  const fileRef = useRef(null)
  const bgFileRef = useRef(null)
  const pausedRef = useRef(false)
  const [engine, setEngine] = useState(null)

  const [subject, setSubject] = useState('star')
  const [upload, setUpload] = useState(null) // { name, shapes }
  const [uploadError, setUploadError] = useState('')
  const [material, setMaterial] = useState('chrome')
  const [tint, setTint] = useState('#4da3ff')
  const [tintAmount, setTintAmount] = useState(0)
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

  // Collapse the three background controls into one descriptor for the engine.
  const background = useMemo(() => {
    if (bgKind === 'transparent') return { kind: 'transparent' }
    if (bgKind === 'image' && bgImage) return { kind: 'image', src: bgImage.src }
    return { kind: 'color', color: bgColor }
  }, [bgKind, bgColor, bgImage])

  // Available share formats: the CSS-playable PNG sheet plus whatever video
  // containers this browser can actually encode (mp4 preferred, webm fallback).
  const videoTypes = useMemo(() => supportedVideoTypes(), [])
  const formats = useMemo(() => ['sheet', ...videoTypes.map((v) => v.format)], [videoTypes])
  const [format, setFormat] = useState('sheet')

  const [preview, setPreview] = useState(null) // { url, kb }
  const [baked, setBaked] = useState(null) // { format, ... }
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  // Create the engine, size it to its container, run the preview loop.
  useEffect(() => {
    const eng = new Engine(canvasRef.current)
    const fit = () => eng.setViewSize(Math.min(viewportRef.current.clientWidth, 720))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(viewportRef.current)

    let raf
    const tick = (now) => {
      // Paused while a video records, so the recorder captures only the
      // dedicated export frames and not the live preview poses.
      if (!pausedRef.current) eng.render((now / (LOOP_SECONDS * 1000)) % 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    setEngine(eng)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      eng.dispose()
      setEngine(null)
    }
  }, [])

  // Keep the scene in sync with the controls.
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
      depth,
      bevel,
      background,
      spin,
      object: objectMotion,
      light: lightMotion,
    })
  }, [engine, material, tint, tintAmount, depth, bevel, background, spin, objectMotion, lightMotion])

  // Re-bake the low-res preview strip whenever anything changes (debounced).
  useEffect(() => {
    if (!engine) return
    const id = setTimeout(() => {
      const strip = engine.bakeStrip(frames, 96)
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
    depth,
    bevel,
    background,
    spin,
    objectMotion,
    lightMotion,
    frames,
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
    const { canvas, cols, rows } = engine.bakeSheet(frames, frameSize)
    downloadCanvas(canvas, 'sheet.png', (blob) => {
      setBaked({
        format: 'sheet',
        kb: Math.round(blob.size / 1024),
        width: canvas.width,
        height: canvas.height,
        cols,
        rows,
      })
    })
    downloadCanvas(engine.bakePoster(1024), 'poster.png')
  }

  const bakeVideo = async () => {
    const type = videoTypes.find((v) => v.format === format)
    if (!type) return
    setBusy(true)
    pausedRef.current = true
    try {
      const blob = await recordVideo(engine, {
        size: frameSize,
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
      if (engine.viewSize) engine.setViewSize(engine.viewSize)
      setBusy(false)
    }
  }

  const bake = () => {
    if (busy) return
    if (format === 'sheet') bakeSheet()
    else bakeVideo()
  }

  const grid = computeGrid(frames, frameSize)
  const copyCss = () => {
    navigator.clipboard.writeText(cssSnippet(frames, frameSize, grid.cols, grid.rows)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const bakeLabel = busy
    ? format === 'sheet'
      ? 'baking…'
      : 'recording…'
    : format === 'sheet'
      ? 'bake sheet + poster'
      : `bake ${format}`

  return (
    <div className="app">
      <header>
        <h1>flipbook</h1>
        <p>
          stage an object, give it a finish and a motion — bake it into a strip of frames, a video,
          or (soon) a gif any website can play.
        </p>
      </header>

      <main>
        <section className="stage">
          <div className="viewport" ref={viewportRef}>
            <canvas ref={canvasRef} />
          </div>
          <div className="filmstrip">
            {preview ? (
              <img src={preview.url} alt="baked frame strip preview" />
            ) : (
              <div className="strip-empty" />
            )}
          </div>
          <p className="caption">
            {preview ? `preview · ${frames} frames · 96px · ${preview.kb}KB` : 'baking preview…'}
          </p>
        </section>

        <aside className="panel">
          <div className="section">
            <h2>subject</h2>
            <div className="chips">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={`chip${subject === p.key ? ' active' : ''}`}
                  onClick={() => setSubject(p.key)}
                >
                  {p.key}
                </button>
              ))}
            </div>
            <div className="chips">
              <button className="chip ghost" onClick={() => fileRef.current.click()}>
                {upload && subject === 'upload' ? `svg: ${upload.name}` : 'upload svg'}
              </button>
              {upload && subject !== 'upload' && (
                <button className="chip" onClick={() => setSubject('upload')}>
                  svg: {upload.name}
                </button>
              )}
            </div>
            {uploadError && <p className="error">{uploadError}</p>}
            <input
              ref={fileRef}
              type="file"
              accept=".svg,image/svg+xml"
              hidden
              onChange={onUpload}
            />
          </div>

          <div className="section">
            <h2>material</h2>
            <Chips options={MATERIAL_NAMES} value={material} onChange={setMaterial} />
            <Slider
              label="depth"
              value={depth}
              display={depth.toFixed(2)}
              min={0.04}
              max={0.6}
              step={0.01}
              onChange={setDepth}
            />
            <Slider
              label="bevel"
              value={bevel}
              display={bevel.toFixed(3)}
              min={0}
              max={0.12}
              step={0.005}
              onChange={setBevel}
            />
            <div className="tint-row">
              <span className="motion-label">tint</span>
              <label className="swatch picker" style={{ background: tint }}>
                <input type="color" value={tint} onChange={(e) => setTint(e.target.value)} />
              </label>
              <input
                className="tint-range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={tintAmount}
                onChange={(e) => setTintAmount(Number(e.target.value))}
              />
              <span className="tint-val">{Math.round(tintAmount * 100)}%</span>
            </div>
          </div>

          <div className="section">
            <h2>background</h2>
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
            <div className="chips">
              <button className="chip ghost" onClick={() => bgFileRef.current.click()}>
                {bgImage ? `image: ${bgImage.name}` : 'upload image'}
              </button>
              {bgImage && bgKind !== 'image' && (
                <button className="chip" onClick={() => setBgKind('image')}>
                  use image
                </button>
              )}
            </div>
            <input
              ref={bgFileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={onBgUpload}
            />
            <p className="hint">
              {bgKind === 'transparent'
                ? 'transparent — png/poster keep alpha; video falls back to black.'
                : 'baked into every export.'}
            </p>
          </div>

          <div className="section">
            <h2>motion</h2>
            <div className="motion-row">
              <span className="motion-label">spin</span>
              <Chips options={SPIN_MOTIONS} value={spin} onChange={setSpin} />
            </div>
            <div className="motion-row">
              <span className="motion-label">object</span>
              <Chips options={OBJECT_MOTIONS} value={objectMotion} onChange={setObjectMotion} />
            </div>
            <div className="motion-row">
              <span className="motion-label">light</span>
              <Chips options={LIGHT_MOTIONS} value={lightMotion} onChange={setLightMotion} />
            </div>
          </div>

          <div className="section">
            <h2>film</h2>
            <Slider label="frames" value={frames} min={8} max={96} step={4} onChange={setFrames} />
            <Slider
              label="frame size"
              value={frameSize}
              display={`${frameSize}px`}
              min={64}
              max={1024}
              step={64}
              onChange={setFrameSize}
            />
            <div className="tint-row">
              <span className="motion-label">custom</span>
              <input
                className="num"
                type="number"
                min={64}
                max={1024}
                step={1}
                value={frameSize}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value) || 0)
                  setFrameSize(Math.max(64, Math.min(1024, v)))
                }}
              />
              <span className="tint-val">px</span>
            </div>
          </div>

          <div className="section">
            <h2>share as</h2>
            <Chips options={formats} value={format} onChange={setFormat} />
            <p className="hint">
              {format === 'sheet'
                ? grid.rows > 1
                  ? `sharp & CSS-playable · ${grid.cols}×${grid.rows} grid sheet`
                  : 'sharp & CSS-playable · single-row strip'
                : 'smallest & smooth · best for sharing'}
            </p>
          </div>

          <button className="bake" onClick={bake} disabled={!engine || busy}>
            {bakeLabel}
          </button>

          {baked?.format === 'sheet' && (
            <div className="section result">
              <h2>baked</h2>
              <p className="hint">
                downloaded sheet.png ({baked.width}×{baked.height} · {baked.kb}KB) and poster.png.
                drop them next to your html and paste this css:
              </p>
              <pre>{cssSnippet(frames, frameSize, baked.cols, baked.rows)}</pre>
              <button className="chip" onClick={copyCss}>
                {copied ? 'copied' : 'copy css'}
              </button>
            </div>
          )}

          {baked?.format === 'video' && (
            <div className="section result">
              <h2>baked</h2>
              <p className="hint">
                downloaded loop.{baked.ext} ({baked.kb}KB) — a {LOOP_SECONDS}s seamless loop ready
                to post anywhere.
              </p>
            </div>
          )}

          {baked?.format === 'error' && (
            <div className="section result">
              <h2>export failed</h2>
              <p className="error">{baked.message}</p>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}
