import QcSelection from '../components/QcSelection.jsx'

export default function QcPage({ runs, run, onRunChange, onSelectionChange, onOpenInversion }) {
  return <QcSelection runs={runs} run={run} onRunChange={onRunChange} onSelectionChange={onSelectionChange}
    onOpenInversion={onOpenInversion} />
}
