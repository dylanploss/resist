import filtersSrc from './udar/filters.js?raw'
import engine1dSrc from './udar/engine1d.js?raw'
import modelSrc from './udar/model.js?raw'
import fdsolveSrc from './udar/fdsolve.js?raw'
import fd25dSrc from './udar/fd25d.js?raw'
import fdorchSrc from './udar/fdorch.js?raw'
import invertSrc from './udar/invert.js?raw'
import jobsSrc from './udar/jobs.js?raw'

// Same order as the core list in UDAR_Bench/source/build/build.js.
const CORE_FILES = [
  ['src/filters.js', filtersSrc],
  ['src/engine1d.js', engine1dSrc],
  ['src/model.js', modelSrc],
  ['src/fdsolve.js', fdsolveSrc],
  ['src/fd25d.js', fd25dSrc],
  ['src/fdorch.js', fdorchSrc],
  ['src/invert.js', invertSrc],
  ['src/jobs.js', jobsSrc],
]

export const CORE_SRC = CORE_FILES.map(([name, src]) => `// ---- ${name} ----\n${src}`).join('\n')

const MAIN_THREAD_EXPORTS = [
  'Engine', 'HANKEL_FILTERS', 'MU0', 'D2R', 'R2D', 'v3',
  'buildTrajectory', 'trajEnd', 'trajAt', 'makeStation', 'stationList', 'buildLocal1D', 'dipNormal',
  'forwardRange', 'addNoise', 'truthAt', 'handleJob',
]

let core = null

export function getCore() {
  if (!core) {
    core = new Function(`"use strict";\n${CORE_SRC}\nreturn {${MAIN_THREAD_EXPORTS.join(',')}};`)()
  }
  return core
}
