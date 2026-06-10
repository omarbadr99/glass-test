import { Suspense, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import {
  Center,
  Text3D,
  Environment,
  OrbitControls,
  MeshTransmissionMaterial,
} from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import { useControls } from 'leva'
import * as THREE from 'three'

// Respect Vite's base path so the font also loads from a Pages subpath.
const FONT_URL = `${import.meta.env.BASE_URL}fonts/helvetiker_bold.typeface.json`

function Scene() {
  const group = useRef()

  // Tunable parameters via leva.
  const text = useControls('Text', {
    label: { value: 'designer' },
    size: { value: 1.1, min: 0.3, max: 3, step: 0.05 },
    depth: { value: 0.4, min: 0.05, max: 1.5, step: 0.05 },
  })

  const rotation = useControls('Motion', {
    speed: { value: 0.15, min: 0, max: 1.5, step: 0.01 },
  })

  const glass = useControls('Glass Pill', {
    transmission: { value: 1, min: 0, max: 1, step: 0.01 },
    thickness: { value: 1.2, min: 0, max: 5, step: 0.05 },
    roughness: { value: 0.05, min: 0, max: 1, step: 0.01 },
    ior: { value: 1.5, min: 1, max: 2.333, step: 0.01 },
    chromaticAberration: { value: 0.45, min: 0, max: 1.5, step: 0.01 },
    anisotropy: { value: 0.2, min: 0, max: 2, step: 0.01 },
    distortion: { value: 0.2, min: 0, max: 1, step: 0.01 },
    distortionScale: { value: 0.4, min: 0, max: 1, step: 0.01 },
    temporalDistortion: { value: 0.1, min: 0, max: 1, step: 0.01 },
  })

  // Slow, subtle rotation of the whole assembly.
  useFrame((state, delta) => {
    if (group.current) {
      group.current.rotation.y += delta * rotation.speed
    }
  })

  return (
    <group ref={group}>
      {/* Bold white 3D text, centered at the origin. */}
      <Center>
        <Text3D
          font={FONT_URL}
          size={text.size}
          height={text.depth}
          bevelEnabled
          bevelSize={0.02}
          bevelThickness={0.03}
          bevelSegments={4}
          curveSegments={12}
        >
          {text.label}
          <meshStandardMaterial color="white" roughness={0.2} metalness={0} />
        </Text3D>
      </Center>

      {/* Glass pill / capsule enclosing the text. */}
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <capsuleGeometry args={[1.3, 5.2, 32, 64]} />
        <MeshTransmissionMaterial
          backside
          samples={10}
          resolution={1024}
          transmission={glass.transmission}
          thickness={glass.thickness}
          roughness={glass.roughness}
          ior={glass.ior}
          chromaticAberration={glass.chromaticAberration}
          anisotropy={glass.anisotropy}
          distortion={glass.distortion}
          distortionScale={glass.distortionScale}
          temporalDistortion={glass.temporalDistortion}
          clearcoat={1}
          attenuationDistance={0.5}
          attenuationColor="#ffffff"
          color="#ffffff"
          background={new THREE.Color('#000000')}
        />
      </mesh>
    </group>
  )
}

export default function App() {
  return (
    <Canvas
      camera={{ position: [0, 0, 8], fov: 40 }}
      gl={{ antialias: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={['#000000']} />

      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={2} />
      <directionalLight position={[-5, -3, -5]} intensity={0.8} />

      <Suspense fallback={null}>
        <Scene />
        {/* HDRI provides reflections/refractions for the glass to read as glass. */}
        <Environment preset="city" />
      </Suspense>

      <EffectComposer>
        <Bloom
          luminanceThreshold={0.8}
          luminanceSmoothing={0.2}
          intensity={0.4}
          mipmapBlur
        />
      </EffectComposer>

      <OrbitControls enablePan={false} />
    </Canvas>
  )
}
