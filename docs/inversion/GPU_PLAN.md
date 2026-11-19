# Plan: GPU acceleration of the 1D (1.5D) inversion workflow

## Status (paused 2026-11-19, branch `feature/gpu-jax`)

**Done**
- **Phase 1:** transform tables are built once per process and handed to workers. CPU baseline is **296 s**
  (Z-20 20300–20400 ft, 26 stations, 14 channels, 3 layers, Quick; `python -m backend.inversion.benchmark`).
- **Phases 2–3:** `backend/inversion/jax_forward.py` ports the UDAR_Bench layered-TIV engine to JAX, with
  displacement currents and the full ADR channel set. Parity:
  - Tensor vs the closed-form whole-space solution: 2e-16.
  - Tensor vs empymod (analytical direct field): 4e-13.
  - All 70 ADR channels vs the empymod path: ≤ 4e-10 %.
- **empymod path fixes:** `xdirect=True` with standard DLF, and tables built for a horizontal tool. The old
  numerical direct field and zero-offset tables were off by up to about 2e-4 dB, which is several % in
  attenuation-derived resistivity at high resistivity.
- **FP32 gate:** raw FP32 errors are ≤ 1e-5° and ≤ 7e-5 dB, which passes for phase and geosignals. Attenuation
  resistivity above about 30 Ω·m can shift about 1%. FP64 is the default; set `RESIST_PRECISION=32` for T4/A10/L4.
- **Phase 4:** `RESIST_COMPUTE=jax` gives an exact `jacfwd` Jacobian with no process pool. Compiled kernels are
  bucketed to 32-station shapes and cached on disk (`~/.cache/resist-jax`, or `RESIST_JAX_CACHE`).
  On CPU: **73 s** warm / 108 s cold, vs 296 s, with the same answer.
- **Phase 5 (partly done):** `backend/inversion/batched.py` is a vmapped bounded LM using a column-wise JVP
  Jacobian, with memory-bounded chunks (`RESIST_SCAN_CHUNK`).
  - `service.run_scan` runs sliding windows × 3 starts, picks the best start, stitches a per-station curtain and
    publishes a live partial result.
  - API: `mode="scan"`, `window_ft` and `overlap` on `/inversion/jobs`; `/inversion/defaults` reports `device`
    and `scan_available`.
  - Tested on CPU: 3 windows × 3 starts on 100 ft took 349 s.
- **Tests:** `backend/tests/test_jax_forward.py` has 4 fast parity tests (passing) and 1 slow batched-LM test
  (`RESIST_SLOW_TESTS=1`), currently failing (see below). All other 76 backend tests pass.

**Resume here tomorrow**
1. **Batched LM local minimum.** A single start on the wrong side converges to 10.3 ft (truth 4 ft).
   - Run the multi-start check: starts −6, +0.5, +2 and +6 ft in the slow test setup.
   - If the best start recovers the truth, change the test to multi-start, as the service does.
   - If not, add a coarse grid over the first boundary, or more LM iterations and damping restarts.
2. **Phase 6, UI:**
   - Mode switch (single window / sliding-window scan) with a window-length field.
   - Scan curtain as a heatmap of log Rh within the ±band around the well, plus well path and boundaries.
   - Live partial curtain for scans, and the compute device shown in the settings card.
3. **Phase 7, Azure:** Dockerfile (CUDA 12, `jax[cuda12]`), push to ACR, NC T4 v3 or NV A10 v5 VM, DLIS via Blob
   (blobfuse2), `RESIST_WORKER_URL` job forwarding from the local backend, and auto-shutdown. Then run the
   benchmark on the GPU (FP64 and FP32).
4. **Phase 8:** benchmark table (CPU empymod, CPU JAX, Azure GPU), update `HACKATHON_PLAN.md` and the API
   contract, then merge `feature/gpu-jax` into `main` after review.

Note: WSL2 is not installed on the laptop, so local JAX is CPU only. GPU runs need Azure (or `wsl --install`).

## Decisions (confirmed)
- **Cloud and GPU:** Azure, on a cheaper GPU class (NC T4 v3, NV A10 v5, or an L4 SKU if available). FP64 is weak on
  these cards, so the spike must show whether FP32 is accurate enough. If FP32 fails, use mixed precision: FP64 only
  for the receiver ratios and transforms.
- **Data:** raw DLIS files can go to the cloud (Azure Blob Storage, mounted or synced to the worker).
- **Framework:** JAX.
- **Scope:** phases 1–7, including the batched whole-well run and the cloud worker.

## Problem
A 3-layer inversion over 100 ft (26 stations, 14 directional channels) takes about 9 minutes. A full well (thousands of
windows) is out of reach. Today the cost sits in:

- **Forward model:** `adr_forward.py` calls `empymod.bipole` once per station (about 13 ms with directional
  channels). The station loop runs in Python, and empymod runs on numba CPU, not GPU.
- **Jacobian:** finite differences need P+1 forward runs per iteration. They are spread over a `ProcessPoolExecutor`,
  and every worker rebuilds the transform tables, which takes about 8 s for the long-spacing tables.
- **Optimizer:** scipy `least_squares` runs one window and one start at a time.

## Hardware facts
- **Local GPU:** RTX 3070 Ti Laptop, 8 GB. FP64 runs at 1/64 of FP32 speed, but the forward model is still massively
  parallel. FP32 vs FP64 accuracy must be measured.
- **JAX GPU:** needs Linux or WSL2; native Windows JAX is CPU only.
- **PyTorch:** CUDA builds work natively on Windows and Linux.
- **Teammates:** some develop on Mac (Apple GPU), so the code must keep a CPU path.
- **Cloud (available):** Linux GPU VMs remove the Windows limitation. The GPU class matters for FP64:

  | Cloud GPU | FP64 | VRAM | Fit |
  |---|---|---|---|
  | H100 / A100 | Full rate (~1/2 of FP32) | 40–80 GB | Best: run the inversion in FP64 with no precision trade-off; whole-well batches fit in memory |
  | L4 / A10G / T4 | 1/32–1/64 of FP32 | 16–24 GB | Cheap; good if FP32 proves accurate enough in the spike |
  | Local 3070 Ti | 1/64 of FP32 | 8 GB | Development and small windows |

## Deployment architecture (with cloud)
- **Single code path:** JAX runs on CPU (Windows, Mac, CI) and on GPU (Linux cloud, or WSL2 on the laptop), so we
  write the code once.
- **Remote GPU worker:** the FastAPI service is split so inversion jobs can run on a GPU worker:
  - Local or cloud backend: submits jobs to a queue or a simple HTTP worker.
  - The GPU worker runs `run_inversion` with `RESIST_COMPUTE=jax`.
  - The UI keeps polling `/inversion/jobs/{id}`; the live cross-section works unchanged.
- **Container:** one Docker image (CUDA base, `jax[cuda12]`, dlisio, empymod for parity). The same image runs locally
  under WSL2 and on the cloud VM.
- **Data:** DLIS files are stored in an Azure Blob container and mounted (blobfuse2) or synced to the worker at
  start-up. Jobs reference the run ID only, as today.

## Recommendation: JAX
With cloud Linux GPUs available, JAX is the clear choice. PyTorch would only win if native Windows GPU were required.

| | JAX | PyTorch | NVIDIA toolset (CUDA C++, CuPy, Warp) |
|---|---|---|---|
| Fit to the problem (pure function of layers and stations) | Best: `vmap` over stations, frequencies, filter points, starts and windows; `jit` fuses it | Good: batch by hand; `torch.func.vmap`/`jacfwd` exist but are less mature with complex numbers | Hand-written kernels; most work |
| Exact Jacobian | `jacfwd`, which is cheap for 8–14 parameters, so finite differences and the process pool go away | `torch.func.jacfwd`, or autograd per output (slower) | Manual derivation |
| complex128 / FP64 | Yes (`jax_enable_x64`) | Yes | Yes |
| Same code on CPU (Mac, CI) | Yes | Yes | No |
| Native Windows GPU | No (WSL2 only) | **Yes** | Yes |
| Batched optimizer (LM over many windows) | Easy in-graph (`lax.while_loop`) | Feasible | Hard |

The NVIDIA toolset (CuPy, Warp, CUDA C++) is not recommended. It gives the most speed per hour only for one fixed
kernel, it locks us to NVIDIA, and it gives no autodiff.

## Algorithm-by-algorithm limitations
| Algorithm | GPU suitability | Limitation and mitigation |
|---|---|---|
| 1D layered TIV forward (digital linear filter Hankel, `key_201_2012`) | Excellent: stations × Tx-Rx pairs × frequencies × 201 filter points are independent | The layer recursion is sequential but short (K ≤ 5) and is unrolled. Precision: compensated phase at high resistivity is a difference of about 0.01° between receivers 8 in apart, so FP32 may lose it. Validate against empymod and keep FP64 as the default if FP32 fails. Near-axis extrapolation (rho → 0) must be ported carefully. |
| Directional channels (tilted receivers, ZR top/bottom, ZG, long-spacing guess) | Excellent (more pairs, same kernel) | Needs the full 5-component tensor plus frame rotation; port `_raw_azimuthal` as array maths. |
| Whole-space transform tables (phase/attenuation → apparent resistivity) | Trivial | Precompute once (on GPU), then `jnp.interp`. Enforce monotonicity as now. |
| Jacobian | Excellent with autodiff | `jacfwd` through `interp` and `log10` is fine. Bounds and clipping need care (gradient through `clip`). |
| Optimizer (LM / trust region) | **Poor alone** (8–14 parameters, tiny dense solves) | Keep scipy for a single window at first. The GPU gain comes from **batching**: multi-starts and sliding windows solved together in one batched LM. |
| Multi-start, sliding windows, whole well | Excellent once batched | Memory: 8 GB VRAM. A 250-station window with about 70 channels, 3 frequencies, 201 filter points and complex128 needs about 100 MB per forward and about 1.5 GB with `jacfwd`. Chunk windows to fit. |
| Misfit study, calibration fits | Fine (calls the same forward) | None. |
| Stochastic / ensemble uncertainty (future) | Excellent | Benefits most from a batched forward. |
| 2.5D FD (UDAR_Bench `fd25d`) | Hard (sparse direct solves) | Out of scope; would need cuDSS or iterative solvers. |
| QC, transition detector | Not needed | Stays on CPU. |

## Phases (todos)
1. **Profile and quick CPU wins** (`gpu-profile`). Find where the 9 minutes go. Cache the long-spacing tables once per
   process, and vectorize all stations into one empymod call. This also gives a baseline to compare against.
2. **Framework spike** (`gpu-spike`). Port the 1D TIV kernel for one Tx-Rx pair. Check it against empymod to 1e-6 in
   FP64 and FP32. Benchmark CPU vs GPU (laptop under WSL2, then an Azure T4, A10 or L4), at 26 and 250 stations.
   **Precision gate:** FP32 passes if compensated phase and attenuation differ from FP64 by less than 0.1 of the noise
   floor (2%, 0.5°, 0.05 dB) over 1–300 Ω·m. Otherwise use mixed precision: FP32 Hankel sums, FP64 for ratios and
   transforms.
3. **Full ADR forward on the accelerator** (`gpu-forward`). Port `ADRForward.predict` (averaged, ZR top/bottom, ZG,
   long-spacing) as a pure function `predict(params, traj_arrays)` with the same label order. Run parity tests
   against the empymod path on Z-20 and on the synthetic models.
4. **Autodiff Jacobian into the existing optimizer** (`gpu-jacobian`). Plug `jacfwd` into `Inverter.jac`, remove the
   process pool for this backend, and pick the backend with `RESIST_COMPUTE=cpu|jax`, falling back to empymod.
5. **Batched LM** (`gpu-batched-lm`). Write a bounded Levenberg-Marquardt over (starts × windows) in one compiled
   loop, used for multi-start and the sliding-window whole-well run.
6. **Integration and UI** (`gpu-integration`). The service picks the backend and reports the device in the job, and
   the Inversion page shows it. Raise station limits when on GPU.
7. **Azure GPU worker** (`gpu-cloud`). Build a Docker image (CUDA 12 base, `jax[cuda12]`, dlisio, empymod) and push it
   to Azure Container Registry.
   - Run it on an Azure GPU VM (or Azure Container Apps with serverless GPU), with the DLIS files from a Blob
     container.
   - The local backend forwards `/inversion/jobs` to the worker URL (`RESIST_WORKER_URL`); the UI is unchanged.
   - Document start/stop and auto-shutdown to control cost, and benchmark on the chosen SKU.
8. **Tests and benchmarks** (`gpu-tests`). Parity tests run on CPU in CI (JAX CPU), and a benchmark script records
   time per window on CPU, the laptop GPU (WSL2) and the cloud GPU. Update docs.

## Expected gain (to verify in the spike)
- **Single window:** from about 9 minutes to seconds, mainly from autodiff (no finite differences or process pool)
  plus a fused forward.
- **Whole well:** feasible only with the batched LM (phase 5).

## Open questions (asked separately)
- Deployment target: native Windows, WSL2/Linux, or a shared Linux GPU server.
- Framework preference given the trade-off above.
- Scope for the hackathon: phases 1–4 only, or also the batched whole-well run.
