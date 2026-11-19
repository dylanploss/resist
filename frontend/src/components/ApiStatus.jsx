import { Alert, Button, LinearProgress } from '@mui/material'

export default function ApiStatus({ state, label, onRetry }) {
  if (state.loading) return <LinearProgress aria-label={`Loading ${label}`} sx={{ my: 1 }} />
  if (state.error) {
    return (
      <Alert
        severity="error"
        sx={{ my: 1 }}
        action={
          onRetry ? (
            <Button color="inherit" size="small" onClick={onRetry}>
              Retry
            </Button>
          ) : null
        }
      >
        {label}: {state.error.message}
        {state.error.status ? ` (HTTP ${state.error.status})` : ''}
      </Alert>
    )
  }
  return null
}
