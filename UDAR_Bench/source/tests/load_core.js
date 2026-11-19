'use strict';
// loads the core sources exactly like the browser/worker does: concatenated text -> new Function
const fs = require('fs'), path = require('path');
const FILES = (process.env.CORE_FILES || 'filters.js,engine1d.js,model.js').split(',');
const EXPORTS = process.env.CORE_EXPORTS || 'Engine,HANKEL_FILTERS,buildTrajectory,trajAt,trajEnd,toolBasis,dipNormal,makeStation,orientVec,pairGeom,toFormation,chanFromT,prepChannels,evalStation,buildLocal1D,buildLocal2D,interpPL,horizonZ,layerAt2D,secX,stationList,forwardRange,forwardLocal,v3,D2R,R2D,MU0';
module.exports = function load(extraFiles, extraExports) {
  const files = FILES.concat(extraFiles || []);
  let src = '"use strict";\n';
  for (const f of files) src += fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8') + '\n';
  const names = EXPORTS.split(',').concat(extraExports || []);
  return new Function(src + '\nreturn {' + names.join(',') + '};')();
};
