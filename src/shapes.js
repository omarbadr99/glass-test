import * as THREE from 'three'
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js'

const TAU = Math.PI * 2

function polygon(points) {
  const s = new THREE.Shape()
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)))
  s.closePath()
  return [s]
}

function star() {
  const pts = []
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5
    const rad = i % 2 === 0 ? 1 : 0.45
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad])
  }
  return polygon(pts)
}

function heart() {
  const s = new THREE.Shape()
  const n = 120
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * TAU
    const x = 16 * Math.sin(th) ** 3
    const y = 13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th)
    if (i === 0) s.moveTo(x / 17, y / 17)
    else s.lineTo(x / 17, y / 17)
  }
  s.closePath()
  return [s]
}

function bolt() {
  return polygon([
    [0.25, 1],
    [-0.45, -0.08],
    [-0.08, -0.08],
    [-0.25, -1],
    [0.45, 0.08],
    [0.08, 0.08],
  ])
}

function gear() {
  const s = new THREE.Shape()
  const teeth = 9
  const R = 1
  const r = 0.76
  const step = TAU / teeth
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    const pts = [
      [r, a],
      [r, a + 0.1 * step],
      [R, a + 0.22 * step],
      [R, a + 0.48 * step],
      [r, a + 0.6 * step],
    ]
    for (const [rad, ang] of pts) {
      const x = Math.cos(ang) * rad
      const y = Math.sin(ang) * rad
      if (i === 0 && rad === pts[0][0] && ang === a) s.moveTo(x, y)
      else s.lineTo(x, y)
    }
  }
  s.closePath()
  const hole = new THREE.Path()
  hole.absarc(0, 0, 0.32, 0, TAU, true)
  s.holes.push(hole)
  return [s]
}

function smiley() {
  const s = new THREE.Shape()
  s.absarc(0, 0, 1, 0, TAU, false)
  for (const ex of [-0.38, 0.38]) {
    const eye = new THREE.Path()
    eye.absarc(ex, 0.32, 0.14, 0, TAU, true)
    s.holes.push(eye)
  }
  const mouth = new THREE.Path()
  const a1 = -2.75
  const a2 = -0.39
  mouth.absarc(0, 0.1, 0.66, a1, a2, false)
  mouth.absarc(0, 0.1, 0.46, a2, a1, true)
  mouth.closePath()
  s.holes.push(mouth)
  return [s]
}

function moon() {
  const s = new THREE.Shape()
  s.absarc(0, 0, 1, Math.PI / 2, Math.PI * 1.5, false)
  const cx = 0.5
  const rad = Math.hypot(cx, 1)
  const a = Math.atan2(1, -cx)
  s.absarc(cx, 0, rad, -a, a, true)
  s.closePath()
  return [s]
}

function gem() {
  return polygon([
    [-0.62, 0.5],
    [0.62, 0.5],
    [1, 0.08],
    [0, -0.85],
    [-1, 0.08],
  ])
}

function squircle() {
  const s = new THREE.Shape()
  const w = 1
  const r = 0.55
  s.moveTo(-w + r, -w)
  s.lineTo(w - r, -w)
  s.quadraticCurveTo(w, -w, w, -w + r)
  s.lineTo(w, w - r)
  s.quadraticCurveTo(w, w, w - r, w)
  s.lineTo(-w + r, w)
  s.quadraticCurveTo(-w, w, -w, w - r)
  s.lineTo(-w, -w + r)
  s.quadraticCurveTo(-w, -w, -w + r, -w)
  s.closePath()
  return [s]
}

export const PRESETS = [
  { key: 'star', make: star },
  { key: 'heart', make: heart },
  { key: 'bolt', make: bolt },
  { key: 'gear', make: gear },
  { key: 'smiley', make: smiley },
  { key: 'moon', make: moon },
  { key: 'gem', make: gem },
  { key: 'squircle', make: squircle },
]

// Parses an uploaded SVG file's text into extrudable shapes.
// Returns { shapes, yUp: false } or throws if nothing fillable is found.
export function shapesFromSVG(text) {
  const data = new SVGLoader().parse(text)
  const shapes = []
  for (const path of data.paths) {
    const style = path.userData?.style ?? {}
    if (style.fill === 'none') continue
    shapes.push(...SVGLoader.createShapes(path))
  }
  if (shapes.length === 0) {
    throw new Error('no filled paths found in this svg')
  }
  return { shapes, yUp: false }
}
