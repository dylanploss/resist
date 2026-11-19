# UDAR Bench

UDAR Bench builds synthetic ultra-deep azimuthal resistivity (UDAR) logs. You set the tool's spacings, frequencies and Tx/Rx axis configurations, the geology (1D dipping layers or a 2D section), and the well. It computes the raw couplings, by an exact layered-earth solution in 1D or a 2.5D finite-difference solver in 2D. It then inverts them station by station with a 1D model, using configurable noise and channels.

## Open the app

Double-click `UDAR_Bench.html`. The whole app is in that one file and runs offline in the browser, with nothing to install.

- It was tested in Google Chrome, opened as a local file. Microsoft Edge uses the same engine but has not been tested; Firefox has not been tested either.
- The app remembers your last settings in the browser you use.
- Outside claude.ai, **Export** opens a box with the data and a **Copy to clipboard** button. Paste the data into a text file to save it.
- The online copy is at https://claude.ai/artifact/H7zid5Tv7ankTTAUNbvndE. It is private to you until you share it from that page.

## What is in this folder

| Path | Contents |
|---|---|
| `UDAR_Bench.html` | The complete app |
| `docs/` | Method and validation notes for the 2.5D solver |
| `source/src/` | Computational core: 1D layered-earth engine, 2.5D finite-difference solver, sparse direct solver, inversion, background-worker jobs |
| `source/app/` | User interface |
| `source/build/build.js` | Joins the source files into one HTML file |
| `source/ref/` | empymod reference data for the 1D engine tests |
| `source/tests/` | Node tests, Python scripts that made the reference data, Playwright browser tests (`ui_*.js`) |
| `source/fd/` | 2.5D validation: exact reference cases, the runner that compares the solver with them, and the Python prototype of the solver (`fd25d.py`) |

## Rebuild after editing the source

You need Node.js (tested with v22). In `source/`, run:

    node build/build.js

This writes `source/build/udar.html`.

## Run the tests

Run these from `source/`:

    node tests/test_engine1d.js         (1D engine against the reference engine and empymod data)
    node tests/test_ref_vs_empymod.js   (reference engine against empymod data)
    node tests/test_model.js            (whole-space solution, reciprocity, rotation invariance)
    node tests/test_invert.js           (inversion of synthetic data)
    node tests/test_fd_rot.js           (2.5D solver against an exact dipping-layer case; under a minute)
    node tests/test_fd_pipeline.js      (full 2.5D run along a well; 10 minutes or more)

**Browser tests.** Install Playwright first with `npm install playwright`, then run, for example, `node tests/ui_smoke.js`. By default the tests use Playwright's own Chromium, which you install with `npx playwright install chromium`. To use an installed Chrome instead, set `CHROME` to its path. The tests open `source/build/udar.html` when it exists, and `UDAR_Bench.html` otherwise.

**2.5D validation.** In `source/fd/`, run:

    node sweep.js "{}"

This compares the solver with the 8 cases in `exact_cases.json`. Set the environment variable `CASES` to `exact_cases2.json` or `exact_cases3.json` to run the other two sets. The `.py` scripts regenerate the reference cases. They need Python with numpy, scipy and empymod (tested with numpy 2.5.3, scipy 1.18.1 and empymod 2.6.1).
