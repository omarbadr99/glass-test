import { useEffect, useRef, useState } from 'react'
import { Engine, MATERIAL_NAMES, SPIN_MOTIONS, OBJECT_MOTIONS, LIGHT_MOTIONS } from './engine'
import { PRESETS, shapesFromSVG } from './shapes'

const LOOP_SECONDS = 2

function cssSnippet(frames, size) {
  const total = frames * size
  return `.loop {
  width: ${size}px;
  height: ${size}px;
  background: url("strip.png") 0 0 / ${total}px ${size}px no-repeat;
  animation: loop ${LOOP_SECONDS}s steps(${frames}) infinite;
}
@keyframes loop {
  to { background-position: -${total}px 0; }
}`
}

function downloadCanvas(canvas, filename, done) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
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
  const [engine, setEngine] = useState(null)

  const [subject, setSubject] = useState('star')
  const [upload, setUpload] = useState(null) // { name, shapes }
  const [uploadError, setUploadError] = useState('')
  const [material, setMaterial] = useState('chrome')
  const [depth, setDepth] = useState(0.22)
  const [bevel, setBevel] = useState(0.04)
  const [spin, setSpin] = useState('turntable')
  const [objectMotion, setObjectMotion] = useState('none')
  const [lightMotion, setLightMotion] = useState('none')
  const [frames, setFrames] = useState(48)
  const [frameSize, setFrameSize] = useState(256)

  const [preview, setPreview] = useState(null) // { url, kb }
  const [baked, setBaked] = useState(null) // { kb, width }
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
      eng.render((now / (LOOP_SECONDS * 1000)) % 1)
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
    engine.applySettings({ material, depth, bevel, spin, object: objectMotion, light: lightMotion })
  }, [engine, material, depth, bevel, spin, objectMotion, lightMotion])

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
  }, [engine, subject, upload, material, depth, bevel, spin, objectMotion, lightMotion, frames])

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

  const bake = () => {
    const strip = engine.bakeStrip(frames, frameSize)
    downloadCanvas(strip, 'strip.png', (blob) => {
      setBaked({ kb: Math.round(blob.size / 1024), width: frames * frameSize })
    })
    downloadCanvas(engine.bakePoster(1024), 'poster.png')
  }

  const copyCss = () => {
    navigator.clipboard.writeText(cssSnippet(frames, frameSize)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="app">
      <header>
        <h1>flipbook</h1>
        <p>
          stage an object, give it a finish and a motion — bake it into a strip of frames any
          website can play.
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
              max={512}
              step={32}
              onChange={setFrameSize}
            />
          </div>

          <button className="bake" onClick={bake} disabled={!engine}>
            bake strip + poster
          </button>

          {baked && (
            <div className="section result">
              <h2>baked</h2>
              <p className="hint">
                downloaded strip.png ({baked.width}×{frameSize} · {baked.kb}KB) and poster.png. drop
                them next to your html and paste this css:
              </p>
              <pre>{cssSnippet(frames, frameSize)}</pre>
              <button className="chip" onClick={copyCss}>
                {copied ? 'copied' : 'copy css'}
              </button>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}
