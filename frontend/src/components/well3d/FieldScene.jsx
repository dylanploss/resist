import { useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import * as THREE from 'three'
import { buildTexture, buildTube } from './path.js'

const LABEL_HEIGHT = 0.022
const LABEL_PX = 28
const SCALE_STEPS_M = [50, 100, 200, 500, 1000, 2000, 5000, 10000]
// Polar angle from vertical: mostly a map view, tilted enough to see the vertical exaggeration.
const FIT_POLAR = Math.PI / 5
const CLICK_PX = 5
const DIM_OPACITY = 0.25
const HOVER_COLOR = '#d32f2f'

// Screen-sized text sprite, always drawn on top (same approach as WellScene's labels).
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

function WellTube({ well, radius, state, onHover, onPick }) {
  const geometry = useMemo(() => buildTube(well.path, radius, 12), [well, radius])
  const texture = useMemo(() => buildTexture(well.data), [well])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh geometry={geometry}
      onPointerOver={(e) => { e.stopPropagation(); onHover(well.run) }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        if (e.delta > CLICK_PX) return
        e.stopPropagation()
        onPick(well.run)
      }}>
      <meshBasicMaterial map={texture} side={THREE.DoubleSide} transparent={state === 'dim'}
        opacity={state === 'dim' ? DIM_OPACITY : 1} depthWrite={state !== 'dim'} />
    </mesh>
  )
}

// North arrow and scale bar at the south-west corner of the field, on the top plane.
function Compass({ box }) {
  const { arrow, northTip, bar, barLabel, length } = useMemo(() => {
    const size = box.getSize(new THREE.Vector3())
    const length = SCALE_STEPS_M.findLast((s) => s <= Math.max(size.x, size.z) / 4) ?? SCALE_STEPS_M[0]
    const corner = new THREE.Vector3(box.min.x, box.max.y, box.max.z)
    const dir = new THREE.Vector3(0, 0, -1)
    const geometry = new THREE.BufferGeometry().setFromPoints([corner, corner.clone().add(new THREE.Vector3(length, 0, 0))])
    return {
      arrow: new THREE.ArrowHelper(dir, corner, length, 0xd32f2f, 0.2 * length, 0.08 * length),
      northTip: corner.clone().addScaledVector(dir, length * 1.15).toArray(),
      bar: geometry,
      barLabel: corner.clone().add(new THREE.Vector3(length / 2, 0, 0.12 * length)).toArray(),
      length,
    }
  }, [box])
  useEffect(() => () => {
    arrow.dispose()
    bar.dispose()
  }, [arrow, bar])
  return (
    <group>
      <primitive object={arrow} />
      <Label position={northTip} text="N" color="#d32f2f" bold />
      <lineSegments geometry={bar}>
        <lineBasicMaterial color="#263238" />
      </lineSegments>
      <Label position={barLabel} text={length >= 1000 ? `${length / 1000} km` : `${length} m`} />
    </group>
  )
}

function Rig({ api, box }) {
  const controls = useRef(null)
  const fit = () => {
    const c = controls.current
    if (!c) return
    const size = box.getSize(new THREE.Vector3())
    const pad = 0.05 * Math.max(size.x, size.z)
    // Put the field's long horizontal axis across the screen: from the east (north to the right) when it runs north-south.
    c.rotateTo(size.z > size.x ? Math.PI / 2 : 0, FIT_POLAR, false)
    c.fitToBox(box, false, { paddingTop: pad, paddingBottom: pad, paddingLeft: pad, paddingRight: pad })
  }
  useImperativeHandle(api, () => ({ fit }))
  // Fit once on mount; exaggeration changes keep the user's camera.
  const onMount = useEffectEvent(() => fit())
  useEffect(() => onMount(), [])
  return <CameraControls ref={controls} makeDefault minDistance={10} maxDistance={2e5} />
}

// All runs as resistivity-coloured tubes at their UTM positions. Hover highlights a run (others fade);
// a click without dragging calls onPick(run). `ref` exposes { fit() }.
export default function FieldScene({ ref, scene, hovered, active, onHover, onPick }) {
  const { wells, box, radius } = scene
  const labelLift = radius * 6
  return (
    <Canvas flat frameloop={active ? 'always' : 'never'} dpr={[1, 2]}
      camera={{ fov: 45, near: 1, far: 1e6, position: [0, 5000, 8000] }}
      gl={{ antialias: true }} style={{ background: '#f5f7fa', cursor: hovered ? 'pointer' : 'auto' }}
      onPointerMissed={() => onHover(null)}>
      {wells.map((w) => (
        <WellTube key={w.run} well={w} radius={hovered === w.run ? radius * 2 : radius}
          state={hovered && hovered !== w.run ? 'dim' : 'normal'} onHover={onHover} onPick={onPick} />
      ))}
      {wells.map((w) => (
        <Label key={w.run} text={w.label} bold={hovered === w.run}
          color={hovered === w.run ? HOVER_COLOR : '#263238'}
          position={[w.path.pos[0], w.path.pos[1] + labelLift, w.path.pos[2]]} />
      ))}
      <Compass box={box} />
      <Rig api={ref} box={box} />
    </Canvas>
  )
}
