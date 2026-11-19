# Inversion Implementation Plan

**Objective:** Build a 1.5D EM inversion system for the Halliburton ADR tool on Ekofisk data, focusing on efficient windowed Levenberg-Marquardt inversion with trajectory and dip accommodation.

**Timeline:** Four parallel workstreams over 6–8 weeks

---

## Workstream 1: Forward Model & Harmonic Reduction (Weeks 1–3)

### Task 1.1: Implement Harmonic Fitting (Week 1)
**Owner:** Any  
**Input:** 32-bin azimuthal images from DLIS runs  
**Output:** `backend/inversion/harmonics.py` with `fit_harmonic()` and test suite  
**Definition of Done:**
- [ ] Fit first-harmonic sinusoids to synthetic 32-bin data (5 test cases)
- [ ] Correctly extract mean, amplitude, phase, and residual RMS
- [ ] Handle null values (-999.25) and NaN gracefully
- [ ] Achieve <0.1% error on synthetic data where amplitude is known
- [ ] Unit tests pass (6+ cases: clean data, single outlier, all-null, offset harmonic, etc.)
- [ ] Code reviewed for numerical stability

**Success Criteria:**
- All tests pass
- Harmonic extraction code is reusable in both optimization and QC modules

---

### Task 1.2: Prototype 1D VTI Forward Model (Weeks 1–2)
**Owner:** Any (may pair with someone experienced in EM solvers)  
**Input:** ADR dossier, UDAR_Bench repository, empymod reference  
**Output:** `backend/inversion/forward_vti.py` with stubs and interface  
**Definition of Done:**
- [ ] `LayerStack`, `Station`, `DipOrientation` data classes defined and tested
- [ ] Coordinate transforms (`dip_to_normal`, `rotate_to_tool_frame`) implemented and validated
- [ ] ADR tool geometry correctly encoded (6 transmitters, 3 receivers, 32-bin ordering)
- [ ] `forward_vti_1d()` interface designed (inputs/outputs clear)
- [ ] Stubs in place; calls to 1D EM tensor solver deferred to Weeks 2–3
- [ ] Integration with `harmonics.py` pipeline demonstrated

**Success Criteria:**
- Design doc and unit tests show correctness of coordinate transforms
- Interface is compatible with Levenberg-Marquardt inversion

---

### Task 1.3: Integrate Hankel Filter or empymod (Weeks 2–3)
**Owner:** Any (coordinate with open-source EM solver maintainers if needed)  
**Input:** `forward_vti.py` stub, empymod/UDAR_Bench documentation  
**Output:** Working 1D EM tensor evaluation for all ADR S/F pairs  
**Definition of Done:**
- [ ] Choose solver: empymod (Python, open-source) or custom Hankel filters
- [ ] Benchmark cost: target <1 second per station (8–10 s for 10 frequencies × 3 spacings)
- [ ] Implement ADR compensation formulas (attenuation to dB, phase correction)
- [ ] Validate on synthetic layered models from UDAR_Bench
- [ ] Round-trip test: forward + inverse on synthetic should recover model to <1% error
- [ ] Code documented with references to ADR dossier equations

**Success Criteria:**
- Synthetic round-trip test passes
- Computational cost <10 seconds per station (acceptable for inversion)

---

## Workstream 2: Levenberg-Marquardt Inversion Engine (Weeks 2–4)

### Task 2.1: Windowed Parameterization (Week 2)
**Owner:** Any  
**Input:** Forward model interface, harmonic features, transition detector output  
**Output:** Parameter class and jacobian setup  
**Definition of Done:**
- [ ] `WindowParameters` class defined: Rh, Rv, boundary depths, dip, dip azimuth (8–14 DOF)
- [ ] Parameter bounds and priors specified
- [ ] Jacobian (sensitivity matrix) design documented
- [ ] Finite-difference Jacobian scaffolding in place (21 forward calls per iteration)
- [ ] Multi-start library lookup (pre-computed table of mean/amplitude vs. distance/contrast)

**Success Criteria:**
- Parameter class is clean and extensible
- Jacobian computation can be validated against numerical derivatives

---

### Task 2.2: Levenberg-Marquardt Solver (Weeks 2–3)
**Owner:** Any  
**Input:** Parameter class, forward model, harmonic features  
**Output:** `backend/inversion/invert_lm.py` with LM solver  
**Definition of Done:**
- [ ] Implement LM iteration: data misfit, gradient, Hessian update, damping
- [ ] Trust region step control (line search or region reduction)
- [ ] Convergence detection (gradient norm, relative improvement, iteration budget)
- [ ] Multi-start support (5–10 independent trials, report best fit)
- [ ] Regularization: smoothness on boundaries, damping on resistivity changes
- [ ] Unit tests: synthetic inversion on known models (1–3 layer cases)

**Success Criteria:**
- Synthetic round-trip: LM recovers true model to <2% error on resistivity
- Convergence in 5–15 iterations on well-behaved problems
- Multi-start finds global minimum on multi-modal synthetic cases

---

### Task 2.3: Windowed Joint Inversion (Week 3–4)
**Owner:** Any  
**Input:** LM solver, overlap tie terms, continuity priors  
**Output:** Windowed joint inversion loop  
**Definition of Done:**
- [ ] Implement overlapping window loop: slide along MD at 50% overlap
- [ ] Tie-term penalty on boundary positions at overlaps (smoothness)
- [ ] Warm-start inversion: use previous window solution as initialization
- [ ] Store results: layer stack, boundaries, uncertainty (posterior covariance) per window
- [ ] Export to CSV/JSON for QC and visualization
- [ ] Integration test on a single test run (e.g., 2-4 VB-5 interval)

**Success Criteria:**
- Full-run processing time <60 minutes on a workstation (8+ cores)
- Boundary positions are smooth across window overlaps
- Results match UDAR_Bench reference on synthetic data

---

## Workstream 3: Integration & Backend API (Weeks 3–5)

### Task 3.1: Connect to Data Pipeline (Week 3)
**Owner:** Any (coordinate with David's loader/transitions)  
**Input:** Data loader, transition detector output, inversion modules  
**Output:** Unified backend API  
**Definition of Done:**
- [ ] Load a single DLIS run via `backend.data.loader.load_run()`
- [ ] Extract harmonic features from phase/attenuation 32-bin images
- [ ] Import transition detector output as initial window boundaries
- [ ] Parameterize first inversion window using transition hints
- [ ] Run full windowed LM inversion on the run
- [ ] Store results in a persistent output structure

**Success Criteria:**
- Full pipeline runs end-to-end on one test run
- Results are plausible (resistivities within expected ranges, boundaries near transitions)

---

### Task 3.2: REST API Endpoints (Week 4)
**Owner:** Any (coordinate with Ove on frontend)  
**Input:** Windowed inversion results, parameter serialization  
**Output:** FastAPI endpoints for inversion control and results retrieval  
**Definition of Done:**
- [ ] `POST /invert/run` – Start inversion on a specified run
- [ ] `GET /invert/status/:run_id` – Poll inversion progress (percent complete)
- [ ] `GET /invert/results/:run_id` – Retrieve inverted model, boundaries, uncertainty
- [ ] `POST /invert/validate/:run_id` – Run synthetic round-trip validation
- [ ] Error handling: invalid runs, missing data, timeout
- [ ] API documentation (OpenAPI/Swagger)

**Success Criteria:**
- Frontend can request inversion and fetch results
- API is fast enough for near-real-time updates (sub-second response)

---

### Task 3.3: Validation Harness (Week 5)
**Owner:** Any  
**Input:** Forward model, inversion results, synthetic utilities  
**Output:** Validation and uncertainty quantification  
**Definition of Done:**
- [ ] Synthetic round-trip test suite: 10+ synthetic models with known resistivity/dip
- [ ] Run synthetic data through full pipeline; measure parameter recovery
- [ ] Posterior uncertainty from Hessian (confidence ellipses on boundaries and Rh/Rv)
- [ ] Non-circular validation: compare inverted resistivity to core sample data (if available)
- [ ] Spot validation: select 1–2 intervals, run 2D/2.5D forward model, compare 1D vs. 2D
- [ ] Generate validation report (CSV, plots) per run

**Success Criteria:**
- Synthetic round-trip achieves <2% parameter recovery error
- Uncertainty estimates are realistic (consistent with residual noise)
- 2D vs. 1D comparison identifies edge cases (high-contrast horizontal layering)

---

## Workstream 4: Frontend UI & Visualization (Weeks 4–6)

### Task 4.1: Inversion Control Panel (Week 4)
**Owner:** Ove (or any frontend developer)  
**Input:** FastAPI endpoints, inversion results schema  
**Output:** React component for inversion setup and monitoring  
**Definition of Done:**
- [ ] Run selection dropdown (11 DLIS runs)
- [ ] Window size, overlap, regularization sliders
- [ ] Start/stop inversion button with progress bar
- [ ] Real-time status display (current window, iteration count, misfit trend)
- [ ] Error display (invalid input, timeout, missing data)
- [ ] Export button (CSV, JSON, VTK)

**Success Criteria:**
- UI is responsive; can start inversion and see progress updates
- All inversion parameters are configurable

---

### Task 4.2: Results Visualization (Weeks 4–5)
**Owner:** Ove (or any frontend developer)  
**Input:** Inversion results, well trajectory  
**Output:** Interactive 1D and log-plot views  
**Definition of Done:**
- [ ] Log plot view: depth (MD or TVD) vs. inverted Rh, Rv per window
- [ ] Error bars: posterior uncertainty on resistivity per window
- [ ] Boundary overlay: inferred layer tops and dips
- [ ] Comparison with harmonic features: plot mean and amplitude alongside inverted model
- [ ] Dip rose plot: azimuth and magnitude of dips per interval
- [ ] Interactive well path in 3D (Mapbox or Cesium.js for context, optional)

**Success Criteria:**
- Results are easily interpretable by geoscientists
- Comparison between inverted and harmonic data builds confidence

---

### Task 4.3: QC & Export (Week 5–6)
**Owner:** Ove (or any frontend developer)  
**Input:** Validation results, inversion residuals  
**Output:** QC dashboard and export formats  
**Definition of Done:**
- [ ] Misfit per window (observed vs. modeled harmonic features)
- [ ] Residual statistics: mean, std, percentiles
- [ ] Flag windows with poor convergence or large misfit
- [ ] Export to GeoVIS format (if used in-house)
- [ ] Export to VTK for 3D visualization in ParaView
- [ ] Integration with curve QC module (highlight zones with high noise or uncertainty)

**Success Criteria:**
- QC metrics help identify problematic intervals
- Export formats integrate with existing visualization tools

---

## Workstream 5: Validation and Documentation (Weeks 5–6)

### Task 5.1: Cross-Platform Testing (Week 5)
**Owner:** Any  
**Input:** Full system (backend + frontend running)  
**Output:** Test report on Windows laptop, Mac (if available), Linux server  
**Definition of Done:**
- [ ] Install on Windows 10/11 laptop (dev environment)
- [ ] Install on Mac (if available)
- [ ] Install on Linux server (production candidate)
- [ ] Run all tests: data loader, transition detector, harmonic fitting, LM inversion, API
- [ ] Benchmark on each platform: time per window, memory usage, throughput
- [ ] Document platform-specific setup (Python version, dependencies, GPU support)

**Success Criteria:**
- Full pipeline runs on all three OS platforms
- Performance is acceptable on each platform (target: <5 min per run on modern workstation)

---

### Task 5.2: Documentation & User Guide (Week 6)
**Owner:** Any  
**Input:** Code, API endpoints, results schema, visualization screenshots  
**Output:** Comprehensive user and developer guide  
**Definition of Done:**
- [ ] README for inversion module (philosophy, usage, caveats)
- [ ] API documentation (OpenAPI/Swagger spec)
- [ ] Data format spec: input (harmonic features), output (inverted model, uncertainty)
- [ ] How-to guide: run inversion on a new well, interpret results, export
- [ ] Troubleshooting guide: common failures, debug steps
- [ ] Scientific background: 1.5D forward model, LM inversion, regularization choices

**Success Criteria:**
- A new developer can understand and extend the system within a day
- Geoscientists can run inversions and interpret results with minimal help

---

## Milestones & Handoff

| Week | Milestone | Owner | Handoff |
|------|-----------|-------|---------|
| 1–2  | Forward model + harmonics | Workstream 1 | Prototype working, stubs in place |
| 2–3  | LM solver + windowed inversion | Workstream 2 | Synthetic round-trip validated |
| 3–4  | Data pipeline integration | Workstream 3 | Backend API endpoints live |
| 4–5  | Frontend UI + visualization | Workstream 4 | Live control panel, results view |
| 5–6  | Validation, testing, docs | Workstream 5 | Full system integrated, documented |

---

## Risks and Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| 1D EM solver performance exceeds budget | Inversion too slow for production | Implement custom Hankel filters or use UDAR_Bench (C++ wrapper) if empymod is too slow |
| Multi-start initialization on difficult zones | Missed global minima near parallel boundaries | Use stochastic search (simulated annealing) as coarse initializer for flagged windows |
| Unconfirmed tool parameters (bin zero, TX/RX mapping) | Model-data misfit biased or unexplained | Estimate nuisance offsets on thick homogeneous intervals; cross-validate with UDAR_Bench |
| Borehole and mandrel effects not modeled | 1D model biased near high-contrast boundaries | Add nuisance per-channel gains; validate with 2D/2.5D on 1–2 spots; flag zones as "1D uncertain" |
| Noise estimates are guesses | Regularization and uncertainty are unreliable | Pre-process field data to estimate noise from residual of harmonic fit; refine after first inversion runs |

---

## Success Criteria for Full Platform

1. **Data quality:** Harmonic features extracted from all 11 runs with <5% residual noise
2. **Inversion:** Full-run inversion completes in <60 minutes on a workstation
3. **Validation:** Synthetic round-trip recovers true resistivity to <2% error
4. **Visualization:** Results are interpretable on the frontend; boundary trends are smooth across windows
5. **Robustness:** System handles missing data, null values, and edge cases gracefully
6. **Documentation:** New developer can extend inversion code after reading guide for one day

---

## Next Action

**Week 1 Sprint:**
1. Task 1.1 (harmonics) – Start immediately; pair for code review
2. Task 1.2 (forward model stubs) – Start in parallel; design meeting on ADR geometry
3. Coordinate with David (data pipeline) on harmonic integration points

**Decision Needed:**
- Solver choice: empymod (Python, easy) vs. custom Hankel (fast but more work)
- Multi-start strategy: grid search vs. stochastic vs. hybrid

---

## Appendix: Reference Implementations

- **empymod:** https://empymod.emsig.info/ (1D EM layered media, Python)
- **SimPEG:** https://simpeg.xyz/ (Inversion framework, Python)
- **UDAR_Bench:** Halliburton-affiliated reference (1D forward + LM, in repo)
- **Bittar et al., 2009:** ADR tool physics (SPE REE 12(2))
- **US 9,239,403:** Quality gating and library-based inversion (Halliburton patent)
