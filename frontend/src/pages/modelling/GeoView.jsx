import { useMemo } from 'react'
import { Alert, Box, Button, FormControl, IconButton, InputLabel, MenuItem, Select, Slider, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import { getCore } from '../../compute/udarCore.js'
import LineChart from '../../components/LineChart.jsx'
import { clamp, clone, fsig } from '../../udar/format.js'
import { PRESETS_GEO1, buildSection, stationAngles } from '../../udar/state.js'
import { Card, Hint, NumField, Panel } from './fields.jsx'
import SectionChart from './SectionChart.jsx'

const ZERO_LINE = [{ y: 0 }]

export default function GeoView({ S, update, cfg, cfgError, setCursor }) {
  const w = S.well
  const g = S.geo1
  const geom = useMemo(() => {
    const { buildTrajectory, stationList, trajEnd } = getCore()
    try {
      const tr = buildTrajectory(cfg.traj, 0.5)
      const st = stationList(cfg, tr)
      let dmin = Infinity
      let dmax = -Infinity
      for (const p of st) {
        dmin = Math.min(dmin, p.D)
        dmax = Math.max(dmax, p.D)
      }
      return { tr, end: trajEnd(tr), sec: buildSection(cfg, tr), md: st.map((s) => s.md), ang: stationAngles(cfg, st), n: st.length, dmin, dmax }
    } catch {
      return null
    }
  }, [cfg])

  const setWell = (k) => (v) => update((d) => (d.well[k] = v))
  const setGeo = (k) => (v) => update((d) => (d.geo1[k] = v))
  const cursor = geom ? clamp(S.cursorMd, geom.tr.md[0], geom.end) : S.cursorMd

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(420px, 520px) 1fr' }, gap: 2 }}>
      <Stack spacing={2}>
        <Card title="Wellbore">
          <Hint>Minimum-curvature trajectory. Inclination and azimuth change linearly with measured depth inside each section, so the build and turn rates are constant per section.</Hint>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mb: 1 }}>
            <NumField label="Start MD" unit="m" value={w.md0} onChange={setWell('md0')} />
            <NumField label="Start North" unit="m" value={w.N0} onChange={setWell('N0')} />
            <NumField label="Start East" unit="m" value={w.E0} onChange={setWell('E0')} />
            <NumField label="Start TVD" unit="m" value={w.D0} onChange={setWell('D0')} />
            <NumField label="Start inclination" unit="°" step={0.5} value={w.inc0} onChange={setWell('inc0')} />
            <NumField label="Start azimuth" unit="°" value={w.az0} onChange={setWell('az0')} />
          </Box>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Length (m)</TableCell>
                <TableCell>End inc (°)</TableCell>
                <TableCell>End azi (°)</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {w.sections.map((s, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <NumField label="" value={s.len} min={1} step={5} width={100} onChange={(v) => update((d) => (d.well.sections[i].len = v))} />
                  </TableCell>
                  <TableCell>
                    <NumField label="" value={s.incEnd} step={0.5} width={100} onChange={(v) => update((d) => (d.well.sections[i].incEnd = v))} />
                  </TableCell>
                  <TableCell>
                    <NumField label="" value={s.azEnd} width={100} onChange={(v) => update((d) => (d.well.sections[i].azEnd = v))} />
                  </TableCell>
                  <TableCell padding="none">
                    {w.sections.length > 1 && (
                      <IconButton size="small" aria-label="Remove section" onClick={() => update((d) => d.well.sections.splice(i, 1))}>
                        ×
                      </IconButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Button
            size="small"
            onClick={() =>
              update((d) => {
                const l = d.well.sections[d.well.sections.length - 1]
                d.well.sections.push({ len: 100, incEnd: l.incEnd, azEnd: l.azEnd })
              })
            }
          >
            Add section
          </Button>
        </Card>
        <Card title="Logging interval and tool rotation">
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1 }}>
            <NumField label="From MD" unit="m" value={w.mdStart} onChange={setWell('mdStart')} />
            <NumField label="To MD" unit="m" value={w.mdEnd} onChange={setWell('mdEnd')} />
            <NumField label="Step" unit="m" min={0.25} step={0.5} value={w.mdStep} onChange={setWell('mdStep')} />
            <NumField label="Toolface" unit="°" step={5} value={w.tf} onChange={setWell('tf')} title="Degrees from high side, clockwise looking down-hole" />
          </Box>
        </Card>
        <Card title="Geology: planar dipping layers">
          <FormControl size="small" sx={{ minWidth: 260, mb: 1 }}>
            <InputLabel id="geo-preset">Load a preset…</InputLabel>
            <Select
              labelId="geo-preset"
              label="Load a preset…"
              value=""
              onChange={(e) =>
                update((d) => {
                  d.geo1 = clone(PRESETS_GEO1[e.target.value])
                })
              }
            >
              {Object.keys(PRESETS_GEO1).map((k) => (
                <MenuItem key={k} value={k}>
                  {k}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1 }}>
            <NumField label="Dip" unit="°" min={0} max={89} step={0.5} value={g.dip} onChange={setGeo('dip')} />
            <NumField label="Dip azimuth" unit="°" value={g.dipAz} onChange={setGeo('dipAz')} />
            <NumField label="Top of layer 2" unit="m TVD" value={g.z0} onChange={setGeo('z0')} title="Top of layer 2 at well start" />
          </Box>
          <Hint>Layer 1 is the upper half-space. The dip azimuth is the direction in which the layers get deeper. Rh is the resistivity along bedding, Rv across it.</Hint>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Rh (Ω·m)</TableCell>
                <TableCell>Rv (Ω·m)</TableCell>
                <TableCell>Thickness TVT (m)</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {g.layers.map((l, i) => (
                <TableRow key={i}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell>
                    <NumField label="" value={l.rh} min={0.01} width={90} onChange={(v) => update((d) => (d.geo1.layers[i].rh = v))} />
                  </TableCell>
                  <TableCell>
                    <NumField label="" value={l.rv} min={0.01} width={90} onChange={(v) => update((d) => (d.geo1.layers[i].rv = v))} />
                  </TableCell>
                  <TableCell>
                    {i === 0 || i === g.layers.length - 1 ? (
                      <Typography variant="caption" color="text.secondary">
                        half-space
                      </Typography>
                    ) : (
                      <NumField label="" value={l.tvt} min={0.1} step={0.5} width={90} onChange={(v) => update((d) => (d.geo1.layers[i].tvt = v))} />
                    )}
                  </TableCell>
                  <TableCell padding="none">
                    {g.layers.length > 1 && (
                      <IconButton size="small" aria-label="Remove layer" onClick={() => update((d) => d.geo1.layers.splice(i, 1))}>
                        ×
                      </IconButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Button
            size="small"
            onClick={() =>
              update((d) => {
                const L = d.geo1.layers
                if (L.length >= 2) L[L.length - 1].tvt = L[L.length - 1].tvt || 6
                const l = L[L.length - 1]
                L.push({ rh: l.rh, rv: l.rv, tvt: 0 })
              })
            }
          >
            Add layer below
          </Button>
        </Card>
      </Stack>
      <Stack spacing={2}>
        {cfgError && <Alert severity="warning">{cfgError}</Alert>}
        {geom && (
          <>
            <Panel title="Section view" sub="click the well to place the tool">
              <SectionChart sec={geom.sec} height={340} cursorMd={cursor} onPick={setCursor} />
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center', px: 1 }}>
                <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>Tool position</Typography>
                <Slider size="small" min={geom.tr.md[0]} max={geom.end} step={0.5} value={cursor} onChange={(e, v) => setCursor(v)} aria-label="Tool position along the well" />
                <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                  MD {fsig(cursor, 5)} m
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>
                Well length <b>{fsig(geom.end - geom.tr.md[0], 4)} m</b> · TVD <b>{fsig(geom.dmin, 5)}</b> to <b>{fsig(geom.dmax, 5)} m</b> · Stations <b>{geom.n}</b> · Layers{' '}
                <b>{g.layers.length}</b>
              </Typography>
            </Panel>
            <Panel title="Tool angle to bedding" sub="positive when the tool heads toward deeper layers">
              <LineChart
                series={[{ name: 'Tool angle to bedding', color: '#2a78d6', x: geom.md, y: geom.ang }]}
                height={180}
                xlabel="Measured depth (m)"
                ylabel="Angle (°)"
                hlines={ZERO_LINE}
                cursorX={cursor}
                onPick={(p) => setCursor(p.x)}
                legend={false}
              />
            </Panel>
          </>
        )}
      </Stack>
    </Box>
  )
}
