import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const TAU = Math.PI * 2

export const MATERIALS = {
  chrome: { color: 0xffffff, metalness: 1, roughness: 0.06 },
  gunmetal: { color: 0x4a4f57, metalness: 1, roughness: 0.32 },
  gold: { color: 0xffc861, metalness: 1, roughness: 0.12 },
  copper: { color: 0xff9466, metalness: 1, roughness: 0.18 },
  porcelain: { color: 0xf6f4ef, metalness: 0, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.15 },
  obsidian: { color: 0x111114, metalness: 0, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 },
  glass: { color: 0xffffff, metalness: 0, roughness: 0.05, transmission: 1, thickness: 0.8, ior: 1.5 },
}

export const MATERIAL_NAMES = Object.keys(MATERIALS)
export const SPIN_MOTIONS = ['turntable', 'swivel', 'none']
export const OBJECT_MOTIONS = ['none', 'sway', 'float', 'nod', 'flip', 'pop']
export const LIGHT_MOTIONS = ['none', 'pan', 'glint', 'flicker']

// Deterministic pseudo-random in [0, 1) so flicker bakes identically every time.
function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

export class Engine {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)

    this.scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
    this.camera.position.set(0, 0.35, 5.4)
    this.camera.lookAt(0, 0, 0)

    this.keyIntensity = 1.6
    this.key = new THREE.DirectionalLight(0xffffff, this.keyIntensity)
    this.key.position.set(2.5, 3, 4)
    this.scene.add(this.key)

    // rig carries the motion; holder carries per-subject orientation fixes
    this.rig = new THREE.Group()
    this.holder = new THREE.Group()
    this.rig.add(this.holder)
    this.scene.add(this.rig)

    this.mesh = null
    this.shapes = []
    this.yUp = true
    this.settings = {
      material: 'chrome',
      depth: 0.22,
      bevel: 0.04,
      spin: 'turntable',
      object: 'none',
      light: 'none',
    }
    this.viewSize = 0
  }

  setViewSize(px) {
    this.viewSize = px
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)
    this.renderer.setSize(px, px, false)
  }

  setShapes(shapes, yUp = true) {
    this.shapes = shapes
    this.yUp = yUp
    this.rebuild()
  }

  applySettings(next) {
    const geomChanged = next.depth !== this.settings.depth || next.bevel !== this.settings.bevel
    const matChanged = next.material !== this.settings.material
    this.settings = { ...next }
    if (this.mesh && geomChanged) this.rebuild()
    else if (this.mesh && matChanged) this.mesh.material = this.makeMaterial()
  }

  makeMaterial() {
    if (this.mesh?.material) this.mesh.material.dispose()
    return new THREE.MeshPhysicalMaterial(MATERIALS[this.settings.material])
  }

  rebuild() {
    if (this.mesh) {
      this.holder.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
      this.mesh = null
    }
    if (!this.shapes.length) return

    // Measure the flat outline first so depth/bevel sliders are in
    // consistent world units no matter how big the source drawing is.
    const probe = new THREE.BufferGeometry().setFromPoints(
      this.shapes.flatMap((sh) => sh.extractPoints(12).shape)
    )
    probe.computeBoundingBox()
    const bb = probe.boundingBox
    probe.dispose()
    const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) || 1
    const scale = 2.1 / span

    const { depth, bevel } = this.settings
    const geometry = new THREE.ExtrudeGeometry(this.shapes, {
      steps: 1,
      depth: depth / scale,
      curveSegments: 48,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel / scale,
      bevelSize: bevel / scale,
      bevelOffset: -bevel / (2 * scale),
      bevelSegments: 5,
    })
    geometry.center()

    this.mesh = new THREE.Mesh(geometry, this.makeMaterial())
    this.mesh.scale.setScalar(scale)
    // SVG files are y-down; a half-turn around X re-rights them and is
    // harmless because the extrusion is centered along Z.
    this.holder.rotation.x = this.yUp ? 0 : Math.PI
    this.holder.add(this.mesh)
  }

  setPose(t) {
    const g = this.rig
    const s = this.settings
    g.rotation.set(0, 0, 0)
    g.position.set(0, 0, 0)
    g.scale.setScalar(1)

    if (s.spin === 'turntable') g.rotation.y = t * TAU
    else if (s.spin === 'swivel') g.rotation.y = Math.sin(t * TAU) * 0.7

    switch (s.object) {
      case 'sway':
        g.rotation.z = Math.sin(t * TAU) * 0.18
        break
      case 'float':
        g.position.y = Math.sin(t * TAU) * 0.16
        break
      case 'nod':
        g.rotation.x = Math.sin(t * TAU) * 0.22
        break
      case 'flip':
        g.rotation.x = t * TAU
        break
      case 'pop':
        g.scale.setScalar(1 + 0.08 * Math.sin(t * TAU))
        break
    }

    this.key.intensity = this.keyIntensity
    this.key.position.set(2.5, 3, 4)
    this.scene.environmentRotation.set(0, 0, 0)
    switch (s.light) {
      case 'pan': {
        const a = t * TAU
        this.key.position.set(Math.sin(a) * 3.5, 2.5, Math.cos(a) * 3.5)
        break
      }
      case 'glint':
        this.scene.environmentRotation.y = t * TAU
        break
      case 'flicker':
        this.key.intensity = this.keyIntensity * (0.65 + 0.7 * hash(Math.floor(t * 16)))
        break
    }
  }

  render(t) {
    this.setPose(t)
    this.renderer.render(this.scene, this.camera)
  }

  // Renders `frames` evenly spaced poses into one horizontal strip.
  // Each frame is rendered at 2x and downsampled for clean edges.
  bakeStrip(frames, size) {
    const strip = document.createElement('canvas')
    strip.width = frames * size
    strip.height = size
    const ctx = strip.getContext('2d')
    ctx.imageSmoothingQuality = 'high'

    this.renderer.setPixelRatio(1)
    this.renderer.setSize(size * 2, size * 2, false)
    for (let i = 0; i < frames; i++) {
      this.render(i / frames)
      ctx.drawImage(this.renderer.domElement, 0, 0, size * 2, size * 2, i * size, 0, size, size)
    }
    if (this.viewSize) this.setViewSize(this.viewSize)
    return strip
  }

  bakePoster(size = 1024) {
    return this.bakeStrip(1, size)
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
    }
    this.scene.environment?.dispose()
    this.renderer.dispose()
  }
}
