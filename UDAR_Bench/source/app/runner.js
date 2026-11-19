// ===================================================================================
// runner.js -- Web Worker pool (blob workers built from the core script text) with a main-thread fallback
// ===================================================================================
class Pool {
  constructor(src) {
    this.src = src; this.n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)); this.workers = []; this.ok = true; this.gen = 0; this.pending = new Set();
    try { this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); } catch (e) { this.ok = false; }
  }
  spawn() {
    if (!this.ok) return false;
    try { while (this.workers.length < this.n) { const w = new Worker(this.url); w.busy = false; this.workers.push(w); } return true; }
    catch (e) { this.ok = false; this.workers = []; return false; }
  }
  cancel() { this.gen++; for (const w of this.workers) w.terminate(); this.workers = []; for (const r of Array.from(this.pending)) r(new Error('cancelled')); this.pending.clear(); }
  // payloads: array of {type, payload}; returns results in order. onProgress(fractionDone)
  async run(type, payloads, onProgress, maxWorkers) {
    const gen = this.gen, total = payloads.length, results = new Array(total), prog = new Float64Array(total);
    const report = () => { if (onProgress) { let s = 0; for (let i = 0; i < total; i++) s += prog[i]; onProgress(s / total); } };
    if (this.spawn()) {
      return new Promise((resolve, reject0) => {
        let next = 0, done = 0, failed = false; const reject = (e) => { this.pending.delete(reject); reject0(e); }; this.pending.add(reject);
        const feed = (w) => {
          if (failed || gen !== this.gen) return;
          if (next >= total) return; const i = next++; w.busy = true; w.job = i;
          w.onmessage = (e) => {
            if (gen !== this.gen) return; const m = e.data;
            if (m.progress) { prog[i] = m.progress[0] / m.progress[1]; report(); return; }
            if (m.error) { failed = true; reject(new Error(m.error)); return; }
            results[i] = m.result; prog[i] = 1; report(); w.busy = false; done++; if (done === total) { this.pending.delete(reject); resolve(results); } else feed(w);
          };
          w.onerror = (ev) => { failed = true; reject(new Error(ev.message || 'worker error')); };
          w.postMessage({ id: i, type, payload: payloads[i] });
        };
        for (const w of this.workers.slice(0, Math.max(1, maxWorkers || this.workers.length))) feed(w);
        if (!total) { this.pending.delete(reject); resolve(results); }
      });
    }
    // fallback: sequential on the main thread, yielding between jobs
    for (let i = 0; i < total; i++) {
      if (gen !== this.gen) throw new Error('cancelled');
      await new Promise(r => setTimeout(r, 0));
      results[i] = handleJob(type, payloads[i], (a, b) => { prog[i] = a / b; });
      prog[i] = 1; report();
    }
    return results;
  }
}
