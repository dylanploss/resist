import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material'
import { FREQ_LABEL, STATUS } from '../api.js'

function SelectionSummary({ rows, checked, onRemove, onReset, onSave, saving, saved }) {
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
  const chosen = checked.map((n) => byName[n]).filter(Boolean)
  const count = (test) => chosen.filter(test).length
  const coverage = [
    ['Depth', ['shallow', 'medium', 'deep'].map((t) => [t, count((r) => r.doi_tier === t)])],
    ['Frequency', [2000000, 500000, 125000].map((f) => [FREQ_LABEL[f], count((r) => r.frequency_hz === f)])],
    ['Type', [['resistivity', count((r) => r.family !== 'ZG')], ['geosignal', count((r) => r.family === 'ZG')]]],
  ]

  const warnings = []
  if (chosen.length < 5 || chosen.length > 10) warnings.push(`Choose 5 to 10 curves (now ${chosen.length}).`)
  if (!count((r) => r.doi_tier === 'deep')) warnings.push('No deep curve selected.')
  const deepGeosignal = (r) => r.family === 'ZG' && r.doi_tier === 'deep'
  if (rows.some((r) => deepGeosignal(r) && r.status !== 'rejected') && !count(deepGeosignal)) {
    warnings.push('A clean deep geosignal is available but not selected.')
  }
  chosen.filter((r) => r.status === 'rejected')
    .forEach((r) => warnings.push(`${r.name} was rejected by QC: ${r.reason}`))

  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>Selection for inversion ({chosen.length})</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1.5 }}>
        {chosen.map((r) => (
          <Chip key={r.name} size="small" label={r.name} onDelete={() => onRemove(r.name)}
            sx={{ fontFamily: 'monospace', borderColor: STATUS[r.status].color }} variant="outlined" />
        ))}
      </Box>
      <Stack spacing={0.75} sx={{ mb: 1.5 }}>
        {coverage.map(([title, items]) => (
          <Box key={title} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="caption" sx={{ width: 70 }}>{title}</Typography>
            {items.map(([label, n]) => (
              <Chip key={label} size="small" label={`${label} ${n}`}
                color={n ? 'success' : 'default'} variant={n ? 'filled' : 'outlined'} />
            ))}
          </Box>
        ))}
      </Stack>
      <Stack spacing={0.5} sx={{ mb: 1.5 }}>
        {warnings.map((w) => <Alert key={w} severity="warning" sx={{ py: 0 }}>{w}</Alert>)}
      </Stack>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <Button variant="outlined" size="small" onClick={onReset}>Reset to auto-picks</Button>
        <Button variant="contained" size="small" onClick={onSave}
          disabled={saving || chosen.length < 1 || chosen.length > 10}>
          {saving ? 'Saving…' : 'Save selection'}
        </Button>
        {saved && (
          <Typography variant="caption" color="success.main">
            Saved {saved.curves.length} curves at {saved.saved_at}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

export default SelectionSummary
