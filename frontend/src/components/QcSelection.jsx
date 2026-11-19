import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid,
  Paper,
  Slider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { postQcSelect } from '../api.js'
import { useApi } from '../hooks/useApi.js'
import ApiStatus from './ApiStatus.jsx'

const num = (v, d = 2) => (v === null || v === undefined ? '–' : typeof v === 'number' ? v.toFixed(d) : String(v))

function ScoresTable({ scores, selected }) {
  const rows = Object.entries(scores).sort((a, b) => (b[1].score ?? -1) - (a[1].score ?? -1))
  return (
    <TableContainer sx={{ maxHeight: 440 }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Curve</TableCell>
            <TableCell>Family</TableCell>
            <TableCell align="right">Score</TableCell>
            <TableCell align="right">Quality</TableCell>
            <TableCell align="right">Coverage</TableCell>
            <TableCell align="right">Noise</TableCell>
            <TableCell>Range OK</TableCell>
            <TableCell align="right">DOI index</TableCell>
            <TableCell>DOI tier</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(([curve, s]) => (
            <TableRow key={curve} selected={selected.includes(curve)}>
              <TableCell sx={{ fontFamily: 'monospace' }}>{curve}</TableCell>
              <TableCell>{s.family ?? ''}</TableCell>
              <TableCell align="right">{num(s.score, 3)}</TableCell>
              <TableCell align="right">{num(s.quality)}</TableCell>
              <TableCell align="right">{num(s.coverage)}</TableCell>
              <TableCell align="right">{num(s.noise)}</TableCell>
              <TableCell>{s.range_ok === undefined || s.range_ok === null ? '–' : s.range_ok ? 'yes' : 'no'}</TableCell>
              <TableCell align="right">{num(s.doi_index)}</TableCell>
              <TableCell>{s.doi_tier ?? ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

function QcSelection({ run }) {
  const [nSelect, setNSelect] = useState(8)
  const [request, setRequest] = useState(null)
  const key = request && request.run === run ? `${request.run}|${request.n}|${request.id}` : null
  const qc = useApi(() => postQcSelect(request.run, request.n), key)
  const r = qc.data

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">QC selection</Typography>
        <Stack direction="row" spacing={3} sx={{ alignItems: 'center', mt: 1, flexWrap: 'wrap' }} useFlexGap>
          <Box sx={{ width: 260 }}>
            <Typography variant="body2" id="nselect-label">
              Curves to select: {nSelect}
            </Typography>
            <Slider aria-labelledby="nselect-label" value={nSelect} min={5} max={10} step={1} marks valueLabelDisplay="auto" onChange={(e, v) => setNSelect(v)} />
          </Box>
          <Button variant="contained" disabled={!run || qc.loading} onClick={() => setRequest({ run, n: nSelect, id: Date.now() })}>
            Run QC selection
          </Button>
          {!run && <Typography color="text.secondary">Pick a run first.</Typography>}
        </Stack>
        <ApiStatus state={qc} label="QC selection" />
      </Paper>
      {r && (
        <>
          {r.warnings && r.warnings.length > 0 && (
            <Alert severity="warning">
              {r.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </Alert>
          )}
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <Paper sx={{ p: 2, height: '100%' }}>
                <Typography variant="h6">
                  Selected ({r.selected.length}) · {r.well}
                </Typography>
                <Table size="small">
                  <TableBody>
                    {r.selected.map((c) => (
                      <TableRow key={c}>
                        <TableCell sx={{ fontFamily: 'monospace' }}>
                          <Chip size="small" color="success" label={c} />
                        </TableCell>
                        <TableCell>{r.selected_reasons[c] ?? ''}</TableCell>
                        <TableCell align="right">{num(r.scores[c] && r.scores[c].score, 3)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <Paper sx={{ p: 2, height: '100%' }}>
                <Typography variant="h6">Rejected ({r.rejected.length})</Typography>
                <TableContainer sx={{ maxHeight: 360 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell>Curve</TableCell>
                        <TableCell>Reason</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {r.rejected.map((x) => (
                        <TableRow key={x.curve}>
                          <TableCell sx={{ fontFamily: 'monospace' }}>{x.curve}</TableCell>
                          <TableCell>{x.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>
            </Grid>
          </Grid>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6">Scores (all curves, highest first)</Typography>
            <ScoresTable scores={r.scores} selected={r.selected} />
          </Paper>
        </>
      )}
    </Stack>
  )
}

export default QcSelection
