# UDAR compute core (vendored copy)

These files are byte-identical copies of `UDAR_Bench/source/src/*.js`. They entered the repo with commit `277dcd0` ("udar bench") and were copied on branch `feature/ove-platform-setup`, based on `f3f2865` (after merge `69949df`).

**Do not edit these files.** Change the originals in `UDAR_Bench/source/src/`, then resync:

    cd frontend
    npm run sync:udar     # copy from UDAR_Bench
    npm run check:udar    # fails if any file differs from UDAR_Bench

The files are plain scripts that declare globals. They are not ES modules. `../udarCore.js` imports them as text (`?raw`), joins them in the same order as `UDAR_Bench/source/build/build.js`, and evaluates the result:

- on the main thread with `new Function` for light helpers (trajectory, stations, presets, truth model);
- in Web Workers built from a Blob of the same text for the forward model and inversion (`../udarWorker.js`). `jobs.js` installs its own `onmessage` handler inside a worker.
