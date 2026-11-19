import { useEffect, useEffectEvent, useImperativeHandle, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import * as THREE from 'three'
import { buildTube, buildTexture, frameAt } from './path.js'
import ShellTube from './ShellTube.jsx'
import { useTravel } from './useTravel.js'

const MARKER_COLOR = '#ffb300'
const TICK_STEPS = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000]
const LABEL_HEIGHT = 0.02
const LABEL_PX = 28

// Screen-sized text sprite: constant size on screen, always drawn on top.
function Label({ text, position, color = '#263238', bold = false }) {
  const { material, aspect } = useMemo(() => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const font = `${bold ? 'bold ' : ''}${LABEL_PX}px Roboto, Arial, sans-serif`
    ctx.font = font
    const pad = LABEL_PX / 4
    canvas.width = Math.ceil(ctx.measureText(text).width + 2 * pad)
    canvas.height = Math.ceil(LABEL_PX * 1.4)
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.font = font
    ctx.fillStyle = color
    ctx.textBaseline = 'middle'
    ctx.fillText(text, pad, canvas.height / 2)
    const map = new THREE.CanvasTexture(canvas)
    map.colorSpace = THREE.SRGBColorSpace
    return {
      material: new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, transparent: true }),
      aspect: canvas.width / canvas.height,
    }
  }, [text, color, bold])
  useEffect(() => () => {
    material.map.dispose()
    material.dispose()
  }, [material])
  return <sprite material={material} position={position} scale={[LABEL_HEIGHT * aspect, LABEL_HEIGHT, 1]} renderOrder={10} />
}

function depthTicks(path, radius) {
  const md0 = path.md[0]
  const md1 = path.md[path.n - 1]
  const step = TICK_STEPS.find((s) => (md1 - md0) / s <= 12) ?? TICK_STEPS.at(-1)
  const frame = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), high: new THREE.Vector3() }
  const ticks = []
  const segments = []
  for (let md = Math.ceil(md0 / step) * step; md <= md1; md += step) {
    frameAt(path, md, frame)
    const inner = frame.pos.clone().addScaledVector(frame.high, radius)
    const outer = frame.pos.clone().addScaledVector(frame.high, radius * 4)
    segments.push(...inner.toArray(), ...outer.toArray())
    ticks.push({ md, at: frame.pos.clone().addScaledVector(frame.high, radius * 5).toArray() })
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3))
  return { ticks, geometry }
}

function DepthTicks({ path, radius }) {
  const { ticks, geometry } = useMemo(() => depthTicks(path, radius), [path, radius])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <group>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color="#455a64" />
      </lineSegments>
      {ticks.map((t) => (
        <Label key={t.md} position={t.at} text={`${t.md.toLocaleString()} ft`} />
      ))}
    </group>
  )
}

function NorthArrow({ path }) {
  const { arrow, tip } = useMemo(() => {
    const size = path.box.getSize(new THREE.Vector3())
    const length = Math.max(30, 0.05 * Math.max(size.x, size.y, size.z))
    const origin = new THREE.Vector3(path.pos[0], path.pos[1] + length, path.pos[2])
    const dir = new THREE.Vector3(0, 0, -1)
    return {
      arrow: new THREE.ArrowHelper(dir, origin, length, 0xd32f2f, 0.2 * length, 0.08 * length),
      tip: origin.clone().addScaledVector(dir, length * 1.15).toArray(),
    }
  }, [path])
  useEffect(() => () => arrow.dispose(), [arrow])
  return (
    <group>
      <primitive object={arrow} />
      <Label position={tip} text="N" color="#d32f2f" bold />
    </group>
  )
}

function WellTube({ data, path, radius }) {
  const geometry = useMemo(() => buildTube(path, radius), [path, radius])
  const texture = useMemo(() => buildTexture(data), [data])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial map={texture} side={THREE.DoubleSide} />
    </mesh>
  )
}

function Rig({ api, path, radius, travel }) {
  const { controls, marker, zoom, fit } = useTravel({ ...travel, path, followDistance: radius * 25 })
  useImperativeHandle(api, () => ({ zoom, fit }))

  const onPath = useEffectEvent(() => travel.mode !== 'follow' && fit())
  useEffect(() => onPath(), [path])

  return (
    <>
      <CameraControls ref={controls} makeDefault minDistance={radius * 3} maxDistance={1e5} />
      <mesh ref={marker}>
        <torusGeometry args={[radius * 1.8, radius * 0.3, 12, 48]} />
        <meshBasicMaterial color={MARKER_COLOR} />
      </mesh>
    </>
  )
}

// Coloured tube along the well path with a travel marker, depth ticks and a north arrow.
// `ref` exposes { zoom(factor), fit() }; travel holds { md, mdEnd, playing, speed, mode, onMd, onEnd }.
// radius is the outer (largest) tube radius used for ticks, marker and camera; radii, when given,
// is one tube radius per sample. shell, when given, is { data, radii } for a transparent outer tube.
export default function WellScene({ ref, data, path, radius, radii, shell, active, travel }) {
  return (
    <Canvas flat frameloop={active ? 'always' : 'never'} dpr={[1, 2]}
      camera={{ fov: 45, near: 0.5, far: 1e6, position: [0, 500, 1500] }}
      gl={{ antialias: true }} style={{ background: '#f5f7fa' }}>
      <WellTube data={data} path={path} radius={radii ?? radius} />
      {shell && <ShellTube data={shell.data} path={path} radius={shell.radii} />}
      <DepthTicks path={path} radius={radius} />
      <NorthArrow path={path} />
      <Rig api={ref} path={path} radius={radius} travel={travel} />
    </Canvas>
  )
}
