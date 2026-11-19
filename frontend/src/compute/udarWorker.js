import { CORE_SRC, getCore } from './udarCore.js'

// Worker pool for UDAR_Bench jobs ('fwd', 'inv', 'fdst'), ported from UDAR_Bench/source/app/runner.js.
// Each worker runs the concatenated core; jobs.js installs the message handler inside the worker.
export class UdarPool {
  constructor(size) {
    const hw = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
    this.n = size || Math.max(1, Math.min(8, hw - 1))
    this.workers = []
    this.ok = true
    this.gen = 0
    this.pending = new Set()
    try {
      this.url = URL.createObjectURL(new Blob([CORE_SRC], { type: 'text/javascript' }))
    } catch {
      this.ok = false
    }
  }

  spawn() {
    if (!this.ok) return false
    try {
      while (this.workers.length < this.n) this.workers.push(new Worker(this.url))
      return true
    } catch {
      this.ok = false
      this.workers = []
      return false
    }
  }

  cancel() {
    this.gen++
    for (const w of this.workers) w.terminate()
    this.workers = []
    for (const reject of Array.from(this.pending)) reject(new Error('cancelled'))
    this.pending.clear()
  }

  dispose() {
    this.cancel()
    if (this.url) URL.revokeObjectURL(this.url)
    this.ok = false
  }

  // Runs one job per payload and resolves with the results in order. onProgress receives the fraction done.
  async run(type, payloads, onProgress, maxWorkers) {
    const gen = this.gen
    const total = payloads.length
    const results = new Array(total)
    const prog = new Float64Array(total)
    const report = () => {
      if (!onProgress) return
      let s = 0
      for (let i = 0; i < total; i++) s += prog[i]
      onProgress(total ? s / total : 1)
    }
    if (this.spawn()) {
      return new Promise((resolve, rejectOuter) => {
        let next = 0
        let done = 0
        let failed = false
        const reject = (e) => {
          this.pending.delete(reject)
          rejectOuter(e)
        }
        this.pending.add(reject)
        const feed = (w) => {
          if (failed || gen !== this.gen || next >= total) return
          const i = next++
          w.onmessage = (e) => {
            if (gen !== this.gen) return
            const m = e.data
            if (m.progress) {
              prog[i] = m.progress[0] / m.progress[1]
              report()
              return
            }
            if (m.error) {
              failed = true
              reject(new Error(m.error))
              return
            }
            results[i] = m.result
            prog[i] = 1
            report()
            done++
            if (done === total) {
              this.pending.delete(reject)
              resolve(results)
            } else feed(w)
          }
          w.onerror = (ev) => {
            failed = true
            reject(new Error(ev.message || 'worker error'))
          }
          w.postMessage({ id: i, type, payload: payloads[i] })
        }
        for (const w of this.workers.slice(0, Math.max(1, maxWorkers || this.workers.length))) feed(w)
        if (!total) {
          this.pending.delete(reject)
          resolve(results)
        }
      })
    }
    const { handleJob } = getCore()
    for (let i = 0; i < total; i++) {
      if (gen !== this.gen) throw new Error('cancelled')
      await new Promise((r) => setTimeout(r, 0))
      results[i] = handleJob(type, payloads[i], (a, b) => {
        prog[i] = a / b
      })
      prog[i] = 1
      report()
    }
    return results
  }
}
