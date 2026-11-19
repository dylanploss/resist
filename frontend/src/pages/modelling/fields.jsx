import { useState } from 'react'
import { Box, InputAdornment, Paper, TextField, Typography } from '@mui/material'

// Number input that keeps partial text such as "-" or "1." while typing, ported from numInput in views_common.js.
export function NumField({ label, value, onChange, unit, step = 'any', min, max, width = '100%', title }) {
  const [text, setText] = useState(String(value))
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    if (parseFloat(text) !== value) setText(String(value))
  }
  return (
    <TextField
      size="small"
      type="number"
      label={label}
      title={title}
      value={text}
      sx={{ width }}
      onChange={(e) => {
        setText(e.target.value)
        const v = parseFloat(e.target.value)
        if (isFinite(v)) onChange(v)
      }}
      onBlur={() => {
        if (!isFinite(parseFloat(text))) setText(String(value))
      }}
      slotProps={{
        htmlInput: { step, min, max },
        input: unit ? { endAdornment: <InputAdornment position="end">{unit}</InputAdornment> } : undefined,
      }}
    />
  )
}

export function Card({ title, children, actions }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1, gap: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
          {title}
        </Typography>
        {actions}
      </Box>
      {children}
    </Paper>
  )
}

export function Panel({ title, sub, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {sub && (
          <Typography variant="caption" color="text.secondary">
            {sub}
          </Typography>
        )}
      </Box>
      {children}
    </Paper>
  )
}

export function Hint({ children }) {
  return (
    <Typography variant="caption" color="text.secondary" component="div" sx={{ my: 0.5 }}>
      {children}
    </Typography>
  )
}
