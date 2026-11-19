import QcSelection from '../components/QcSelection.jsx'

export default function QcPage({ runs, run, onRunChange }) {
  return <QcSelection runs={runs} run={run} onRunChange={onRunChange} />
}
