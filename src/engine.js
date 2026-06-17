import * as THREE from 'three'

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

// A few backdrop swatches plus a free color picker in the UI. Exports are
// always composited onto an opaque background — glossy metals never read right
// on a transparent canvas, and GIF/video can't carry alpha anyway.
export const BACKGROUNDS = ['#101014', '#f7f6f2', '#0a1a2f', '#1d1208', '#123524']

// Widest a single film strip may get before we wrap frames into a grid sheet.
// Canvases past ~16k px fail to allocate in some browsers, so we stay under
// that and arrange the frames into rows instead of one very long row.
export const MAX_SHEET_DIM = 16384

// Lay `frames` cells of `size` px into the squarest grid whose width stays
// within `maxDim`. We prefer a column count that divides the frame count so
// the last row is full and CSS playback never lands on a blank cell.
export function computeGrid(frames, size, maxDim = MAX_SHEET_DIM) {
  const maxCols = Math.max(1, Math.floor(maxDim / size))
  let cols = Math.min(frames, maxCols)
  if (cols < frames) {
    for (let c = cols; c >= 1; c--) {
      if (frames % c === 0) {
        cols = c
        break
      }
    }
  }
  return { cols, rows: Math.ceil(frames / cols) }
}

// Deterministic pseudo-random in [0, 1) so flicker bakes identically every time.
function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

// A few bright emissive planes added to the reflection-probe scene. They
// survive the PMREM bake as specular highlights, so even a flat-colored
// backdrop still gives the metal shape rather than a dead silhouette. Returns
// the geometries/materials to dispose once the bake is done.
function addStudioPanels(scene) {
  const trash = []
  const panel = (w, h, pos, intensity) => {
    const geo = new THREE.PlaneGeometry(w, h)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffffff,
      emissiveIntensity: intensity,
      roughness: 1,
      side: THREE.DoubleSide,
    })
    const m = new THREE.Mesh(geo, mat)
    m.position.set(pos[0], pos[1], pos[2])
    m.lookAt(0, 0, 0)
    scene.add(m)
    trash.push(geo, mat)
  }
  panel(6, 4, [0, 5, 5], 2.2) // top key
  panel(5, 6, [-6, 1, 3], 1.3) // left fill
  panel(5, 5, [6, -1, -3], 1.0) // right rim
  return trash
}

export class Engine {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)

    this.scene = new THREE.Scene()
    // Sharp reflection probe rebuilt from the backdrop (see refreshEnvironment)
    // so metals mirror the actual background image/color. A high-res cube (not
    // PMREM, which is pre-blurred) is what makes a true mirror possible.
    this._cubeRT = new THREE.WebGLCubeRenderTarget(1024, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    })
    this._cubeCam = new THREE.CubeCamera(0.1, 100, this._cubeRT)

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
    this.camera.position.set(0, 0.35, 5.4)
    this.camera.lookAt(0, 0, 0)

    this.keyIntensity = 1.6
    this.key = new THREE.DirectionalLight(0xffffff, this.keyIntensity)
    this.key.position.set(2.5, 3, 4)
    this.scene.add(this.key)

    // root holds the standing distance from the backdrop; rig carries the
    // motion; holder carries per-subject orientation fixes. Keeping distance on
    // root (outside the spinning rig) moves the item in/out without orbiting it.
    this.root = new THREE.Group()
    this.rig = new THREE.Group()
    this.holder = new THREE.Group()
    this.rig.add(this.holder)
    this.root.add(this.rig)
    this.scene.add(this.root)

    this.mesh = null
    this.shapes = []
    this.yUp = true
    this.settings = {
      material: 'chrome',
      tint: '#ffffff',
      tintAmount: 0,
      reflectivity: 0.5,
      size: 1,
      distance: 0,
      depth: 0.22,
      bevel: 0.04,
      spin: 'turntable',
      object: 'none',
      light: 'none',
      background: { kind: 'color', color: BACKGROUNDS[0] },
    }
    // Reused scratch color + lazily loaded backdrop image texture.
    this._bgColor = new THREE.Color()
    this._bgTexture = null
    this._bgSrc = null
    this.viewSize = 0

    this.refreshEnvironment()
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
    const prev = this.settings
    const geomChanged = next.depth !== prev.depth || next.bevel !== prev.bevel
    const matChanged =
      next.material !== prev.material ||
      next.tint !== prev.tint ||
      next.tintAmount !== prev.tintAmount ||
      next.reflectivity !== prev.reflectivity
    const sizeChanged = next.size !== prev.size
    const distanceChanged = next.distance !== prev.distance
    const b1 = prev.background
    const b2 = next.background
    const bgChanged = !b1 || b1.kind !== b2.kind || b1.color !== b2.color || b1.src !== b2.src
    this.settings = { ...next }
    if (bgChanged) this.setBackground(next.background)
    if (sizeChanged) this.applyTransform()
    // Distance feeds glass refraction (thickness) as well as the reflection
    // probe, so the material is rebuilt when it changes.
    if (this.mesh && geomChanged) this.rebuild()
    else if (this.mesh && (matChanged || distanceChanged)) this.mesh.material = this.makeMaterial()
    // Distance also re-scales the reflected backdrop in the probe, so the probe
    // must rebake; debounce it (shared with background changes) for smoothness.
    if (bgChanged || distanceChanged) {
      clearTimeout(this._envTimer)
      this._envTimer = setTimeout(() => this.refreshEnvironment(), 120)
    }
  }

  // Size is the only control that changes the item's apparent size; the item
  // stays centered at the origin so it never drifts. Distance is handled in
  // refreshEnvironment (it moves the reflected backdrop, not the item).
  applyTransform() {
    if (this.mesh) this.mesh.scale.setScalar(this._baseScale * (this.settings.size ?? 1))
  }

  makeMaterial() {
    if (this.mesh?.material) this.mesh.material.dispose()
    // Clear any previous screen-reflection hook; re-attached below if needed.
    this._ssrUniforms = null
    const { material, tint, tintAmount } = this.settings
    const reflectivity = this.settings.reflectivity ?? 0.5
    const def = MATERIALS[material]
    const mat = new THREE.MeshPhysicalMaterial(def)
    // Tint pulls the base finish toward the chosen hue; 0 leaves it untouched.
    if (tintAmount > 0) mat.color.lerp(new THREE.Color(tint), tintAmount)
    // Reflectivity dial scales the material's designed roughness: 0.5 keeps it
    // as authored, →1 drives roughness toward a mirror, →0 toward matte. A
    // small env-intensity lift on the bright side makes the gain read clearly.
    const base = def.roughness ?? 0.5
    const f =
      reflectivity >= 0.5
        ? (1 - reflectivity) / 0.5
        : 1 + ((0.5 - reflectivity) / 0.5) * 4
    mat.roughness = Math.min(1, base * f)
    mat.envMapIntensity = 0.55 + reflectivity * 0.9
    // For transmissive finishes (glass) distance drives the refraction: a
    // thicker slab bends what you see through it more, so the backdrop shifts
    // and magnifies as the item floats further off it.
    if (def.transmission) {
      const t = ((this.settings.distance ?? 0) + 3) / 5
      mat.thickness = THREE.MathUtils.lerp(0.4, 3, t)
      mat.ior = THREE.MathUtils.lerp(1.3, 1.7, t)
    } else if (this.settings.background?.kind === 'image' && this._bgTexture) {
      // Opaque finishes over an image backdrop reflect it via screen space, so
      // a flat face shows the backdrop true-to-size (env maps magnify it).
      this._attachScreenReflection(mat)
    }
    return mat
  }

  // Sample the backdrop at each fragment's screen position so the surface
  // mirrors the actual background behind it: at the low distance the sample is
  // 1:1 (the item blends into the backdrop like the glass refraction), and
  // distance zooms the sample around centre. Reflectivity sets how fully it
  // takes over from the shaded metal, and adds blur toward the matte end.
  _attachScreenReflection(mat) {
    const tex = this._bgTexture
    const dist = this.settings.distance ?? 0
    const t = (dist + 3) / 5
    const reflectivity = this.settings.reflectivity ?? 0.5
    const uniforms = {
      uBgMap: { value: tex },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBgRepeat: { value: tex.repeat.clone() },
      uBgOffset: { value: tex.offset.clone() },
      uZoom: { value: THREE.MathUtils.lerp(1.15, 3.2, t) },
      uReflMix: { value: THREE.MathUtils.clamp(0.25 + reflectivity * 0.75, 0, 1) },
      uBlur: { value: (1 - reflectivity) * 5 + t * 1.5 },
    }
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.fragmentShader =
        `uniform sampler2D uBgMap;
uniform vec2 uResolution;
uniform vec2 uBgRepeat;
uniform vec2 uBgOffset;
uniform float uZoom;
uniform float uReflMix;
uniform float uBlur;
` +
        shader.fragmentShader.replace(
          '#include <tonemapping_fragment>',
          `{
  vec2 _suv = gl_FragCoord.xy / uResolution;
  vec2 _zuv = (_suv - 0.5) / uZoom + 0.5;
  vec2 _buv = _zuv * uBgRepeat + uBgOffset;
  vec3 _bg = texture2D(uBgMap, _buv, uBlur).rgb;
  _bg = pow(_bg, vec3(2.2));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, _bg * diffuseColor.rgb, uReflMix);
  float _fres = pow(1.0 - clamp(normalize(vNormal).z, 0.0, 1.0), 3.0);
  gl_FragColor.rgb += _fres * uReflMix * 0.2;
}
#include <tonemapping_fragment>`
        )
    }
    mat.needsUpdate = true
    this._ssrUniforms = uniforms
  }

  // Resolve a background descriptor: { kind: 'color', color } | { kind:
  // 'transparent' } | { kind: 'image', src }. Image textures load async and
  // are center-cropped to the square frame; render() falls back to transparent
  // until the bitmap is ready.
  setBackground(bg) {
    if (!bg || bg.kind !== 'image') {
      if (this._bgTexture) {
        this._bgTexture.dispose()
        this._bgTexture = null
      }
      this._bgSrc = null
      return
    }
    if (bg.src === this._bgSrc) return
    this._bgSrc = bg.src
    new THREE.TextureLoader().load(bg.src, (tex) => {
      // Ignore a stale load if the source changed again mid-flight.
      if (this._bgSrc !== bg.src) {
        tex.dispose()
        return
      }
      tex.colorSpace = THREE.SRGBColorSpace
      const img = tex.image
      const aspect = img.width / img.height
      if (aspect > 1) {
        tex.repeat.set(1 / aspect, 1)
        tex.offset.set((1 - 1 / aspect) / 2, 0)
      } else {
        tex.repeat.set(1, aspect)
        tex.offset.set(0, (1 - aspect) / 2)
      }
      this._bgTexture?.dispose()
      this._bgTexture = tex
      // The bitmap now exists: rebuild reflections and (re)attach the
      // screen-space reflection to an opaque material that was waiting for it.
      this.refreshEnvironment()
      if (this.mesh && !MATERIALS[this.settings.material].transmission) {
        this.mesh.material = this.makeMaterial()
      }
    })
  }

  // Rebuild the sharp reflection probe so metals mirror the *actual* backdrop.
  // The probe scene is surrounded by the background — a flat image plane behind
  // the camera for a crisp, recognizable frontal mirror, plus an equirect wrap
  // so the sides aren't black — then captured into a high-res cube the
  // materials sample. Roughness (the reflectivity dial) blurs it via mipmaps:
  // a mirror at 0, a soft sheen as it climbs.
  refreshEnvironment() {
    const env = new THREE.Scene()
    const bg = this.settings.background
    const trash = []

    if (bg?.kind === 'image' && this._bgTexture?.image) {
      const img = this._bgTexture.image
      const aspect = img.width / img.height || 1

      // One large backdrop plane that fully covers the reflection hemisphere so
      // there's no magnified 360°-wrap leaking into the surface. Distance sets
      // how large the image reads via UV scale (not plane distance): the low
      // end shows it ~true-to-size (matching the backdrop the glass refracts),
      // the high end magnifies a centered crop, edges clamped so they smear
      // rather than reveal the wrap. (-3..2 → t 0..1.)
      // Equirect wrap only fills the side/back angles (occluded in front by the
      // covering plane below), so the surface carries the image's tones rather
      // than going black as it spins past the plane's edge.
      const eq = this._bgTexture.clone()
      eq.mapping = THREE.EquirectangularReflectionMapping
      eq.repeat.set(1, 1)
      eq.offset.set(0, 0)
      eq.colorSpace = THREE.SRGBColorSpace
      eq.needsUpdate = true
      env.background = eq
      trash.push(eq)

      const flat = this._bgTexture.clone()
      flat.mapping = THREE.UVMapping
      flat.wrapS = THREE.ClampToEdgeWrapping
      flat.wrapT = THREE.ClampToEdgeWrapping
      flat.colorSpace = THREE.SRGBColorSpace
      flat.center.set(0.5, 0.5)
      const t = ((this.settings.distance ?? 0) + 3) / 5
      const repeat = THREE.MathUtils.lerp(4.2, 1.4, t) // low = wide/true-size, high = zoomed
      flat.repeat.set(repeat, repeat)
      flat.needsUpdate = true

      // Plane at a fixed close distance, sized to span the whole front
      // hemisphere; its aspect matches the image so the crop isn't distorted.
      const planeZ = 8
      const fullH = 48
      const geo = new THREE.PlaneGeometry(fullH * aspect, fullH)
      const mat = new THREE.MeshBasicMaterial({ map: flat, side: THREE.DoubleSide })
      const plane = new THREE.Mesh(geo, mat)
      plane.position.set(0, 0, planeZ)
      plane.lookAt(0, 0, 0)
      env.add(plane)
      trash.push(flat, geo, mat)
    } else if (bg?.kind === 'color') {
      env.background = new THREE.Color(bg.color)
      trash.push(...addStudioPanels(env))
    } else {
      env.background = new THREE.Color(0x202024) // transparent → neutral grey
      trash.push(...addStudioPanels(env))
    }

    // Captured from the origin (where the item sits); distance is expressed by
    // the backdrop plane's position above, not by moving the camera or item.
    this._cubeCam.position.set(0, 0, 0)
    this._cubeCam.updateMatrixWorld(true)

    // Capture linear radiance (no tone map) so the main render tone-maps the
    // reflection exactly once — otherwise the mirror reads muted.
    const prevTone = this.renderer.toneMapping
    this.renderer.toneMapping = THREE.NoToneMapping
    this._cubeCam.update(this.renderer, env)
    this.renderer.toneMapping = prevTone
    this.scene.environment = this._cubeRT.texture

    trash.forEach((d) => d.dispose())
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
    // Heavier subdivision so curved outlines and the rounded bevel read as
    // smooth rather than faceted, especially at large export sizes.
    const geometry = new THREE.ExtrudeGeometry(this.shapes, {
      steps: 1,
      depth: depth / scale,
      curveSegments: 96,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel / scale,
      bevelSize: bevel / scale,
      bevelOffset: -bevel / (2 * scale),
      bevelSegments: 12,
    })
    geometry.center()

    this.mesh = new THREE.Mesh(geometry, this.makeMaterial())
    // Base scale fits the outline; the size dial multiplies it in applyTransform.
    this._baseScale = scale
    // SVG files are y-down; a half-turn around X re-rights them and is
    // harmless because the extrusion is centered along Z.
    this.holder.rotation.x = this.yUp ? 0 : Math.PI
    this.holder.add(this.mesh)
    this.applyTransform()
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

  // Renders one pose with the active backdrop. The same path drives the live
  // preview and every bake, so what you see is what you export. A transparent
  // background leaves the canvas clear (checkerboard shows, PNG keeps alpha);
  // a color or loaded image fills it opaque.
  render(t) {
    this.setPose(t)
    const bg = this.settings.background
    if (bg?.kind === 'image' && this._bgTexture) {
      this.scene.background = this._bgTexture
    } else if (bg?.kind === 'color') {
      this.scene.background = this._bgColor.set(bg.color)
    } else {
      // transparent, or an image still loading
      this.scene.background = null
      this.renderer.setClearColor(0x000000, 0)
    }
    // Screen-space reflection needs the live drawing-buffer size (differs
    // between the preview and the supersampled bake) to map fragments to uv.
    if (this._ssrUniforms) this.renderer.getDrawingBufferSize(this._ssrUniforms.uResolution.value)
    this.renderer.render(this.scene, this.camera)
  }

  // Renders `frames` evenly spaced poses, each at 2x and downsampled for clean
  // edges, into a sprite sheet. When a single row of `size`-px cells would be
  // wider than `maxDim`, the frames wrap into a grid. Returns the canvas plus
  // its grid shape so callers can build matching CSS.
  bakeSheet(frames, size, maxDim = MAX_SHEET_DIM) {
    const { cols, rows } = computeGrid(frames, size, maxDim)
    const sheet = document.createElement('canvas')
    sheet.width = cols * size
    sheet.height = rows * size
    const ctx = sheet.getContext('2d')
    ctx.imageSmoothingQuality = 'high'

    this.renderer.setPixelRatio(1)
    this.renderer.setSize(size * 2, size * 2, false)
    for (let i = 0; i < frames; i++) {
      this.render(i / frames)
      const dx = (i % cols) * size
      const dy = Math.floor(i / cols) * size
      ctx.drawImage(this.renderer.domElement, 0, 0, size * 2, size * 2, dx, dy, size, size)
    }
    if (this.viewSize) this.setViewSize(this.viewSize)
    return { canvas: sheet, cols, rows }
  }

  // Convenience wrapper that forces a single uncapped row — used for the small
  // live preview strip, which never approaches the sheet-size limit.
  bakeStrip(frames, size) {
    return this.bakeSheet(frames, size, Infinity).canvas
  }

  bakePoster(size = 1024) {
    return this.bakeSheet(1, size).canvas
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
    }
    clearTimeout(this._envTimer)
    this._bgTexture?.dispose()
    this._cubeRT?.dispose()
    this.renderer.dispose()
  }
}
