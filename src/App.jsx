import { Suspense, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import {
  Center,
  Text3D,
  Environment,
  Lightformer,
  OrbitControls,
  MeshTransmissionMaterial,
} from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import { useControls } from 'leva'

// Respect Vite's base path so the font also loads from a Pages subpath.
const FONT_URL = `${import.meta.env.BASE_URL}fonts/helvetiker_bold.typeface.json`

function Scene() {
  const group = useRef()

  // Tunable parameters via leva.
  const text = useControls('Text', {
    label: { value: 'designer' },
    size: { value: 1.25, min: 0.3, max: 3, step: 0.05 },
    depth: { value: 0.3, min: 0.05, max: 1.5, step: 0.05 },
  })

  const rotation = useControls('Motion', {
    speed: { value: 0.12, min: 0, max: 1.5, step: 0.01 },
  })

  // Liquid-glass parameters. Defaults tuned for a clear, transmissive pill
  // that refracts and disperses the white text sitting inside it.
  const glass = useControls('Liquid Glass', {
    transmission: { value: 1, min: 0, max: 1, step: 0.01 },
    thickness: { value: 1.6, min: 0, max: 5, step: 0.05 },
    roughness: { value: 0, min: 0, max: 1, step: 0.01 },
    ior: { value: 1.45, min: 1, max: 2.333, step: 0.01 },
    chromaticAberration: { value: 0.85, min: 0, max: 2, step: 0.01 },
    anisotropicBlur: { value: 0.1, min: 0, max: 1, step: 0.01 },
    distortion: { value: 0.5, min: 0, max: 1, step: 0.01 },
    distortionScale: { value: 0.5, min: 0, max: 1, step: 0.01 },
    temporalDistortion: { value: 0.2, min: 0, max: 1, step: 0.01 },
    attenuationDistance: { value: 4, min: 0.1, max: 10, step: 0.1 },
    envIntensity: { value: 0.6, min: 0, max: 3, step: 0.05 },
  })

  // Slow, subtle rotation of the whole assembly.
  useFrame((state, delta) => {
    if (group.current) {
      group.current.rotation.y += delta * rotation.speed
    }
  })

  return (
    <group ref={group}>
      {/* Bright white text sitting INSIDE the pill. meshBasicMaterial keeps it
          uniformly white so it reads clearly once refracted through the glass. */}
      <Center>
        <Text3D
          font={FONT_URL}
          size={text.size}
          height={text.depth}
          bevelEnabled
          bevelSize={0.015}
          bevelThickness={0.02}
          bevelSegments={3}
          curveSegments={12}
        >
          {text.label}
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </Text3D>
      </Center>

      {/* Glass pill / capsule enclosing the text. backside refraction makes the
          glass bend the text behind it like a real thick lens. */}
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <capsuleGeometry args={[1.45, 5.2, 64, 128]} />
        <MeshTransmissionMaterial
          backside
          backsideThickness={glass.thickness}
          samples={16}
          resolution={2048}
          backsideResolution={1024}
          transmission={glass.transmission}
          thickness={glass.thickness}
          roughness={glass.roughness}
          ior={glass.ior}
          chromaticAberration={glass.chromaticAberration}
          anisotropicBlur={glass.anisotropicBlur}
          distortion={glass.distortion}
          distortionScale={glass.distortionScale}
          temporalDistortion={glass.temporalDistortion}
          attenuationDistance={glass.attenuationDistance}
          attenuationColor="#ffffff"
          color="#ffffff"
          envMapIntensity={glass.envIntensity}
        />
      </mesh>
    </group>
  )
}

export default function App() {
  return (
    <Canvas
      camera={{ position: [0, 0, 9], fov: 35 }}
      gl={{ antialias: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={['#000000']} />

      <ambientLight intensity={0.2} />

      <Suspense fallback={null}>
        <Scene />
        {/* Controlled studio lighting via Lightformers rather than a bright HDRI,
            so the glass gets clean soft highlights instead of a mirror-chrome look.
            Background stays black. */}
        <Environment resolution={256}>
          <Lightformer
            intensity={2}
            position={[0, 4, 4]}
            scale={[12, 6, 1]}
            color="#ffffff"
          />
          <Lightformer
            intensity={1.2}
            position={[-5, 1, 2]}
            scale={[6, 8, 1]}
            color="#ffffff"
          />
          <Lightformer
            intensity={1}
            position={[5, -2, -3]}
            scale={[8, 6, 1]}
            color="#ffffff"
          />
        </Environment>
      </Suspense>

      <EffectComposer>
        <Bloom
          luminanceThreshold={0.9}
          luminanceSmoothing={0.3}
          intensity={0.35}
          mipmapBlur
        />
      </EffectComposer>

      <OrbitControls enablePan={false} />
    </Canvas>
  )
}
