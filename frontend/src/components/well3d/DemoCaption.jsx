import { Box, Typography } from '@mui/material'

// Caption overlay for the 3D demo, centred at the bottom of the scene.
export default function DemoCaption({ caption, step, total }) {
  if (!caption) return null
  return (
    <Box data-testid="well3d-demo-caption" sx={{
      position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', maxWidth: '80%',
      bgcolor: 'rgba(38,50,56,0.88)', color: '#fff', px: 2, py: 1, borderRadius: 1, pointerEvents: 'none',
    }}>
      <Typography variant="subtitle2">
        {caption.title}{step > 0 && ` · stop ${step}/${total}`}
      </Typography>
      <Typography variant="body2">{caption.text}</Typography>
    </Box>
  )
}
