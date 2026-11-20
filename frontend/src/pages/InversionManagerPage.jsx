import { Fragment, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  FormControlLabel, IconButton, LinearProgress, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material'
import { deleteInversionRecord, getInversionRecords } from '../api.js'
import { useApi } from '../hooks/useApi.js'
import ApiStatus from '../components/ApiStatus.jsx'

const shortRun = (run) => run.replace(/_RES_GEOSIGNAL$/, '')
const num = (v, digits = 2) => (v == null ? '–' : Number(v).toFixed(digits))
const when = (t) => (t ? new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–')

function duration(s) {
  if (s == null) return '–'
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ${Math.round(s - 60 * m)} s` : `${Math.floor(m / 60)} h ${m % 60} min`
}

// Shared column widths, so the tables of all wells line up (the Curves column takes the rest).
const COLUMNS = [44, 230, 150, 200, null, 90, 100, 120, 190, 210, 150]

// Text a record is searched by: well, run, job id, curve names.
const haystack = (r) => [r.well, r.run, r.job_id, ...(r.request.curves ?? [])].join(' ').toLowerCase()

function Detail({ label, children }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap', mb: 0.75 }}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 110 }}>{label}</Typography>
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', flex: 1 }}>{children}</Box>
    </Box>
  )
}

function RecordDetails({ record }) {
  const q = record.request
  const used = record.plan?.used ?? []
  const ignored = record.plan?.ignored ?? []
  return (
    <Box sx={{ py: 1.5, px: 1 }}>
      <Detail label="Selected curves">
        {(q.curves ?? []).map((c) => <Chip key={c} size="small" label={c} sx={{ fontFamily: 'monospace' }} />)}
      </Detail>
      <Detail label="Channels fitted">
        {used.length === 0 && <Typography variant="caption">not recorded</Typography>}
        {used.map((u) => (
          <Tooltip key={u.label} title={`${u.kind} · ${u.measurement} · from ${u.source ?? u.curve}${u.well_note ? ` · ${u.well_note}` : ''}`}>
            <Chip size="small" variant="outlined" color={u.weight > 0 ? 'primary' : 'default'}
              label={`${u.label} ×${u.weight}`} sx={{ fontFamily: 'monospace', opacity: u.weight > 0 ? 1 : 0.6 }} />
          </Tooltip>
        ))}
      </Detail>
      {ignored.length > 0 && (
        <Detail label="Ignored curves">
          {ignored.map((i) => (
            <Tooltip key={i.curve} title={i.reason}>
              <Chip size="small" variant="outlined" label={i.curve} sx={{ fontFamily: 'monospace', opacity: 0.6 }} />
            </Tooltip>
          ))}
        </Detail>
      )}
      <Detail label="Settings">
        <Typography variant="body2">
          Rh {q.rh_min_ohmm ?? 0.1}–{q.rh_max_ohmm ?? 1000} Ω·m · calibration {q.calibration === false ? 'off' : 'on'}
          {q.lines?.length ? ` · ${q.lines.length} dip line(s), dip ±${q.dip_sigma_deg ?? 2}°, anchor ±${q.boundary_sigma_ft ?? 2} ft` : ''}
          {q.base_job_id ? ` · partial re-run of ${q.base_job_id.slice(0, 6)}` : ''}
        </Typography>
      </Detail>
      <Detail label="Identity">
        <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          job {record.job_id} · fingerprint {record.fingerprint}
        </Typography>
      </Detail>
      {record.supersedes?.length > 0 && (
        <Detail label="Replaced">
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {record.supersedes.map((f) => f.slice(0, 12)).join(', ')}
          </Typography>
        </Detail>
      )}
      {record.plan?.warnings?.length > 0 && (
        <Detail label="Plan warnings">
          <Typography variant="caption" color="text.secondary">{record.plan.warnings.join(' ')}</Typography>
        </Detail>
      )}
    </Box>
  )
}

function RecordRow({ record, open, onToggle, onDelete, onOpen, busy }) {
  const q = record.request
  const s = record.stats ?? {}
  const curves = q.curves ?? []
  const weighted = (record.plan?.used ?? []).filter((u) => u.weight > 0).length
  return (
    <Fragment>
      <TableRow hover sx={{ opacity: record.superseded ? 0.6 : 1, '& > td': { borderBottom: open ? 'none' : undefined } }}>
        <TableCell padding="checkbox">
          <IconButton size="small" onClick={onToggle} aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} curves and details of inversion ${record.job_id}`}>
            {open ? '▾' : '▸'}
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{shortRun(record.run)}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{record.job_id.slice(0, 6)}</Typography>
          {!record.run_available && (
            <Tooltip title="The DLIS file of this run is not in this backend's data folder">
              <Chip size="small" variant="outlined" label="run not loaded" sx={{ ml: 0.5 }} />
            </Tooltip>
          )}
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {q.md_min_ft}–{q.md_max_ft} ft
          <Typography variant="caption" color="text.secondary" component="div">{num(q.md_max_ft - q.md_min_ft, 0)} ft</Typography>
        </TableCell>
        <TableCell>
          {q.layers} layers · {q.quick ? 'quick' : 'full'}
          <Typography variant="caption" color="text.secondary" component="div">
            step {q.step_ft ?? '?'} · slice {q.slice_ft ?? '?'} · window {q.window_ft ?? '?'} ft
            {q.lines?.length ? ` · ${q.lines.length} dip line(s)` : ''}{q.base_job_id ? ' · partial' : ''}
          </Typography>
        </TableCell>
        <TableCell>
          {curves.length} curves{record.plan?.used ? ` · ${weighted} channels fitted` : ''}
          <Typography variant="caption" color="text.secondary" component="div"
            sx={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {curves.join(' ')}
          </Typography>
        </TableCell>
        <TableCell align="right">{s.stations ?? '–'}<Typography variant="caption" color="text.secondary" component="div">{s.slices ?? '–'} slices</Typography></TableCell>
        <TableCell align="right">
          <b>{num(s.misfit_normalised)}</b>
          <Typography variant="caption" color="text.secondary" component="div">{s.rms_percent_used == null ? '–' : `${num(s.rms_percent_used, 1)} %`}</Typography>
        </TableCell>
        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
          {duration(s.elapsed_s)}
          <Typography variant="caption" color="text.secondary" component="div">{s.forward_evaluations ?? '–'} evals</Typography>
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>{when(record.finished)}</TableCell>
        <TableCell>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            <Tooltip title={record.current_version ? 'Computed with the current inversion code' : 'Computed with older inversion code; a repeated request recomputes it'}>
              <Chip size="small" color={record.current_version ? 'primary' : 'default'} label={`v${record.version}`} />
            </Tooltip>
            {record.superseded && (
              <Tooltip title="Replaced by a newer result of the same request; hidden on the Inversion and 3D well tabs">
                <Chip size="small" color="warning" variant="outlined" label="superseded" />
              </Tooltip>
            )}
            {(record.stores ?? []).map((st) => <Chip key={st} size="small" variant="outlined" label={st} />)}
          </Stack>
        </TableCell>
        <TableCell align="right">
          <Tooltip title={record.run_available ? 'Show this inversion on the Inversion tab, with its settings, curves and dip lines'
            : "This run's DLIS file is not in this backend's data folder"}>
            <span>
              <Button size="small" disabled={!record.run_available} onClick={onOpen}
                aria-label={`Open inversion ${record.job_id} on the Inversion tab`}>
                Open
              </Button>
            </span>
          </Tooltip>
          <Button size="small" color="error" disabled={busy} onClick={onDelete}
            aria-label={`Delete inversion ${record.job_id}`}>
            Delete
          </Button>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={11} sx={{ py: 0, bgcolor: 'action.hover' }}>
          <Collapse in={open} unmountOnExit><RecordDetails record={record} /></Collapse>
        </TableCell>
      </TableRow>
    </Fragment>
  )
}

export default function InversionManagerPage({ active, onOpen }) {
  // Fetched each time the tab is opened, so inversions run on other tabs show up.
  const state = useApi(getInversionRecords, active ? 'records' : null)
  const [cache, setCache] = useState(null)
  if (state.data && state.data !== cache) setCache(state.data)
  const data = state.data ?? cache
  const [filter, setFilter] = useState('')
  const [showSuperseded, setShowSuperseded] = useState(true)
  const [open, setOpen] = useState({})
  const [pending, setPending] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState(null)

  const all = useMemo(() => data?.records ?? [], [data])
  const wells = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const groups = new Map()
    for (const r of all) {
      if (!showSuperseded && r.superseded) continue
      if (needle && !haystack(r).includes(needle)) continue
      if (!groups.has(r.well)) groups.set(r.well, [])
      groups.get(r.well).push(r)
    }
    return [...groups.entries()]
  }, [all, filter, showSuperseded])
  const shown = wells.reduce((n, [, list]) => n + list.length, 0)
  const superseded = all.filter((r) => r.superseded).length
  const older = all.filter((r) => !r.current_version).length
  const store = data?.store
  const shared = store?.cosmos === 'ok'
  const where = shared ? 'the shared Cosmos graph (for everyone using it) and this backend\'s snapshot file'
    : 'this backend\'s snapshot file'

  const confirmDelete = async () => {
    const record = pending
    setDeleting(true)
    try {
      const body = await deleteInversionRecord(record.fingerprint, record.run)
      setNotice({ severity: body.warning ? 'warning' : 'success',
        text: `Deleted inversion ${record.job_id.slice(0, 6)} (${shortRun(record.run)}, ${record.request.md_min_ft}–${record.request.md_max_ft} ft).`
          + (body.warning ? ` ${body.warning}.` : '') })
      state.reload()
    } catch (e) {
      setNotice({ severity: 'error', text: `Could not delete inversion ${record.job_id.slice(0, 6)}: ${e.message}` })
    } finally {
      setDeleting(false)
      setPending(null)
    }
  }

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
          <Typography variant="h6">Stored inversions</Typography>
          {data && <Chip size="small" label={`${all.length} inversions · ${new Set(all.map((r) => r.well)).size} wells`} />}
          {superseded > 0 && <Chip size="small" variant="outlined" color="warning" label={`${superseded} superseded`} />}
          {older > 0 && <Chip size="small" variant="outlined" label={`${older} from older code (current v${data.version})`} />}
          {store && (
            <Tooltip title={store.reason ?? store.sync ?? ''}>
              <Chip size="small" variant="outlined" color={store.cosmos === 'ok' ? 'success' : 'default'}
                label={`store: ${store.store}${store.cosmos === 'ok' ? '' : ' (Cosmos not connected)'}`} />
            </Tooltip>
          )}
          <Box sx={{ flex: 1 }} />
          <TextField size="small" label="Filter" placeholder="well, run, job id or curve" value={filter}
            onChange={(e) => setFilter(e.target.value)} sx={{ minWidth: 240 }} />
          <FormControlLabel label="Show superseded"
            control={<Switch checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />} />
          <Button size="small" variant="outlined" onClick={state.reload} disabled={state.loading}>Refresh</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
          Misfit is the residual divided by the noise level over the fitted channels (about 1 = fitted to the noise),
          with the RMS misfit of the resistivities in percent below it. Deleting removes an inversion from {where}; it
          cannot be undone here.{shared ? ' A backend elsewhere whose snapshot still holds the inversion uploads it again when it starts.' : ''}
        </Typography>
        {state.loading && data && <LinearProgress sx={{ mt: 1 }} />}
        {!data && <ApiStatus state={state} label="Stored inversions" onRetry={state.reload} />}
        {data && state.error && <Alert severity="error" sx={{ mt: 1 }}>Could not refresh: {state.error.message}</Alert>}
        {notice && <Alert severity={notice.severity} sx={{ mt: 1 }} onClose={() => setNotice(null)}>{notice.text}</Alert>}
      </Paper>

      {data && all.length === 0 && <Alert severity="info">No stored inversions yet. Run one on the Inversion tab.</Alert>}
      {data && all.length > 0 && shown === 0 && <Alert severity="info">No inversion matches the filter.</Alert>}

      {wells.map(([well, list]) => (
        <Paper key={well} variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{well}</Typography>
            <Typography variant="caption" color="text.secondary">
              {list.length} inversion{list.length === 1 ? '' : 's'} · {new Set(list.map((r) => r.run)).size} run(s)
            </Typography>
          </Stack>
          <TableContainer>
            <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 1500 }}>
              <colgroup>{COLUMNS.map((w, i) => <col key={i} style={w ? { width: w } : undefined} />)}</colgroup>
              <TableHead>
                <TableRow>
                  <TableCell />
                  <TableCell>Run</TableCell>
                  <TableCell>MD interval</TableCell>
                  <TableCell>Setup</TableCell>
                  <TableCell>Curves</TableCell>
                  <TableCell align="right">Stations</TableCell>
                  <TableCell align="right">Misfit / noise</TableCell>
                  <TableCell align="right">Compute</TableCell>
                  <TableCell>Finished</TableCell>
                  <TableCell>Version · stored in</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {list.map((r) => (
                  <RecordRow key={r.fingerprint} record={r} open={Boolean(open[r.fingerprint])} busy={deleting}
                    onToggle={() => setOpen((o) => ({ ...o, [r.fingerprint]: !o[r.fingerprint] }))}
                    onDelete={() => setPending(r)} onOpen={() => onOpen?.(r.run, r.job_id)} />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      ))}

      <Dialog open={Boolean(pending)} onClose={() => !deleting && setPending(null)}>
        <DialogTitle>Delete this inversion?</DialogTitle>
        {pending && (
          <DialogContent>
            <DialogContentText component="div">
              <b>{pending.well}</b> · {shortRun(pending.run)}<br />
              MD {pending.request.md_min_ft}–{pending.request.md_max_ft} ft · {pending.request.layers} layers ·
              {' '}{pending.request.quick ? 'quick' : 'full'} · v{pending.version} · job {pending.job_id.slice(0, 6)}<br />
              Finished {when(pending.finished)}
              {pending.stats?.elapsed_s != null ? ` · took ${duration(pending.stats.elapsed_s)} to compute` : ''}
            </DialogContentText>
            <DialogContentText sx={{ mt: 1.5 }}>
              It is removed from {where}. This cannot be undone; getting it back means running the inversion again.
              {pending.supersedes?.length > 0 && ' The older result it replaced stays hidden (superseded).'}
            </DialogContentText>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setPending(null)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={confirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete inversion'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
