import { createContext, useContext } from 'react'

// Run and curve shared between the QC and 3D well tabs.
// Value: { run, setRun, curve, setCurve, openWell3d(run, curve) }.
export const SelectionContext = createContext(null)

export const useSelection = () => useContext(SelectionContext)
