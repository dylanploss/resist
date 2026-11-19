import { useEffect, useEffectEvent, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { frameAt } from './path.js'

const READOUT_MS = 100
const FOLLOW_LIFT = 0.3
const FIT_PADDING = 0.04
const FIT_POLAR = Math.PI / 3

const frame = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), high: new THREE.Vector3() }
const cam = new THREE.Vector3()
const target = new THREE.Vector3()
const dir = new THREE.Vector3()
const Z_AXIS = new THREE.Vector3(0, 0, 1)

function distanceOf(c) {
  c.getPosition(cam, true)
  c.getTarget(target, true)
  return cam.distanceTo(target)
}

// Camera state machine for travelling down the well, used inside the R3F canvas.
// follow: the camera sits behind the travel point, looking down-hole along the tangent; the
//         camera-to-point distance is the zoom and is kept between moves.
// free:   CameraControls orbit; moving along the well pans the orbit target with the travel point.
// While playing, MD advances in useFrame and is reported to React at most every READOUT_MS.
// Returns refs for the CameraControls and the marker mesh, plus zoom(factor) and fit().
export function useTravel({ path, md, mdEnd, playing, speed, mode, followDistance, onMd, onEnd }) {
  const controls = useRef(null)
  const marker = useRef(null)
  const mdRef = useRef(md)
  const lastReport = useRef(0)

  const placeCamera = (value, smooth, maxDistance = Infinity) => {
    const c = controls.current
    if (!path || !c) return
    frameAt(path, value, frame)
    if (marker.current) {
      marker.current.position.copy(frame.pos)
      marker.current.quaternion.setFromUnitVectors(Z_AXIS, frame.tan)
    }
    if (mode === 'follow') {
      const distance = Math.max(Math.min(distanceOf(c), maxDistance), c.minDistance)
      dir.copy(frame.tan).multiplyScalar(-1).addScaledVector(frame.high, FOLLOW_LIFT).normalize()
      cam.copy(frame.pos).addScaledVector(dir, distance)
      c.setLookAt(cam.x, cam.y, cam.z, frame.pos.x, frame.pos.y, frame.pos.z, smooth)
    } else {
      c.moveTo(frame.pos.x, frame.pos.y, frame.pos.z, smooth)
    }
  }

  const onMdChange = useEffectEvent((value) => {
    if (playing && Math.abs(value - mdRef.current) < 1e-6) return
    mdRef.current = value
    placeCamera(value, true)
  })
  useEffect(() => onMdChange(md), [md])

  const onPlayingChange = useEffectEvent((value) => {
    if (!value) onMd(mdRef.current)
  })
  useEffect(() => onPlayingChange(playing), [playing])

  const onPathChange = useEffectEvent(() => placeCamera(mdRef.current, false))
  useEffect(() => onPathChange(), [path])

  const onModeChange = useEffectEvent((value) => {
    const c = controls.current
    if (!c) return
    const rotate = value === 'follow' ? 0 : 1
    c.azimuthRotateSpeed = rotate
    c.polarRotateSpeed = rotate
    c.truckSpeed = 2 * rotate
    if (value === 'follow') placeCamera(mdRef.current, true, followDistance)
  })
  useEffect(() => onModeChange(mode), [mode])

  useFrame((state, delta) => {
    if (!playing || !path) return
    const next = Math.min(mdEnd, mdRef.current + speed * Math.min(delta, 0.1))
    mdRef.current = next
    placeCamera(next, false)
    const now = state.clock.elapsedTime * 1000
    if (next >= mdEnd) {
      onMd(next)
      onEnd()
    } else if (now - lastReport.current > READOUT_MS) {
      lastReport.current = now
      onMd(next)
    }
  })

  const zoom = (factor) => {
    const c = controls.current
    if (c) c.dolly(distanceOf(c) * factor, true)
  }

  // Looks across the well's main horizontal direction from 30° above horizontal, then fits the whole path.
  const fit = () => {
    const c = controls.current
    if (!c || !path) return
    const last = 3 * (path.n - 1)
    const dx = path.pos[last] - path.pos[0]
    const dz = path.pos[last + 2] - path.pos[2]
    const azimuth = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(-dz, dx) : 0
    const size = path.box.getSize(cam)
    const pad = FIT_PADDING * Math.max(size.x, size.y, size.z)
    c.rotateTo(azimuth, FIT_POLAR, true)
    c.fitToBox(path.box, true, { paddingTop: pad, paddingBottom: pad, paddingLeft: pad, paddingRight: pad })
  }

  return { controls, marker, zoom, fit }
}
