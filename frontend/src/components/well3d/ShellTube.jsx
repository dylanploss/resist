import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { buildTexture, buildTube } from './path.js'

const SHELL_OPACITY = 0.35

// Semi-transparent outer tube for the deeper curve of a comparison; drawn after the solid inner tube
// and without depth writes so the inner tube stays visible through it.
export default function ShellTube({ data, path, radius }) {
  const geometry = useMemo(() => buildTube(path, radius), [path, radius])
  const texture = useMemo(() => buildTexture(data), [data])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh geometry={geometry} renderOrder={1}>
      <meshBasicMaterial map={texture} side={THREE.DoubleSide} transparent opacity={SHELL_OPACITY} depthWrite={false} />
    </mesh>
  )
}
