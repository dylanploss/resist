import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, FormControl, InputLabel, LinearProgress, MenuItem, Paper, Select, Typography } from '@mui/material'
import ApiStatus from '../ApiStatus.jsx'
import ColorBar from './ColorBar.jsx'
import { buildField } from './field.js'
import { api } from '../../api.js'
import { useApi } from '../../hooks/useApi.js'

const FieldScene = lazy(() => import('./FieldScene.jsx'))

const MAX_POINTS = 300
const EXAGGERATIONS = [1, 2, 5, 10, 20]

// Field view: every run at its UTM position. Clicking a well calls onPick(run).
export default function FieldView({ active, toggle, onPick }) {
  const field = useApi(() => api(`/field?max_points=${MAX_POINTS}`), 'field')
  const [exaggeration, setExaggeration] = useState(5)
  const [hovered, setHovered] = useState(null)
  const scene = useRef(null)
  const data = field.data
  const built = useMemo(() => (data?.runs.length ? buildField(data, exaggeration) : null), [data, exaggeration])
  const info = data?.runs.find((r) => r.run === hovered)

  return (
    <Paper sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}>
        {toggle}
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel id="field-exaggeration">Vertical exag.</InputLabel>
          <Select labelId="field-exaggeration" label="Vertical exag." value={exaggeration}
            onChange={(e) => setExaggeration(Number(e.target.value))}>
            {EXAGGERATIONS.map((o) => <MenuItem key={o} value={o}>{o}×</MenuItem>)}
          </Select>
        </FormControl>
        <Button size="small" variant="outlined" onClick={() => scene.current?.fit()} disabled={!built}>Reset view</Button>
        {data && (
          <Typography variant="caption" color="text.secondary">
            {data.runs.length} runs at UTM positions · {MAX_POINTS} points max per run · colour: deepest AR resistivity
            per run, one scale for the field
          </Typography>
        )}
      </Box>
      <ApiStatus state={field} label="Field" onRetry={field.reload} />
      {field.loading && (
        <Typography variant="caption" color="text.secondary">Loading every run; the first time can take a while.</Typography>
      )}
      {data?.skipped.map((s) => (
        <Alert key={s.run} severity="warning" sx={{ mb: 1 }}>Not shown: {s.run} ({s.reason})</Alert>
      ))}
      {data && !data.runs.length && <Alert severity="warning">No run has a position to draw.</Alert>}
      {built && (
        <Box sx={{ position: 'relative', height: { xs: 480, lg: 640 }, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
          <Suspense fallback={<LinearProgress />}>
            <FieldScene ref={scene} scene={built} hovered={hovered} active={active} onHover={setHovered} onPick={onPick} />
          </Suspense>
          <Box sx={{ position: 'absolute', top: 8, left: 8, bgcolor: 'rgba(255,255,255,0.85)', p: 1, borderRadius: 1, pointerEvents: 'none' }}
            data-testid="field-readout">
            {info ? (
              <>
                <Typography variant="subtitle2">{info.well}</Typography>
                <Typography variant="body2">
                  MD {Math.round(info.md_range_ft[0])}–{Math.round(info.md_range_ft[1])} ft · colour {info.curve ?? 'none'}<br />
                  Click to open in Single well
                </Typography>
              </>
            ) : (
              <Typography variant="body2">Hover a well to highlight it, click to fly into it.<br />Drag to orbit, scroll to zoom.</Typography>
            )}
          </Box>
          {data.color && (
            <Box sx={{ position: 'absolute', top: 8, right: 8, pointerEvents: 'none' }}>
              <ColorBar spec={data.color} unit="ohmm" />
            </Box>
          )}
        </Box>
      )}
    </Paper>
  )
}
