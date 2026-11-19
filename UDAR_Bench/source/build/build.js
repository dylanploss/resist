// Concatenate the core (worker-safe) scripts and the app scripts into one self-contained HTML file.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const core = ['src/filters.js', 'src/engine1d.js', 'src/model.js', 'src/fdsolve.js', 'src/fd25d.js', 'src/fdorch.js', 'src/invert.js', 'src/jobs.js'];
const app = ['app/util.js', 'app/chart.js', 'app/state.js', 'app/runner.js', 'app/fdrun.js', 'app/views_common.js', 'app/views_a.js', 'app/views_b.js', 'app/main.js'];
const join = (files) => files.map(f => '// ---- ' + f + ' ----\n' + rd(f)).join('\n');
const coreSrc = join(core), appSrc = join(app), css = rd('app/style.css');
for (const [n, s] of [['core', coreSrc], ['app', appSrc]]) if (/<\/script/i.test(s)) throw new Error('"</script" found in ' + n + ' sources');
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UDAR Bench</title>
<style>
${css}
</style>
</head>
<body>
<noscript>UDAR Bench needs JavaScript.</noscript>
<script id="core-src">
${coreSrc}
</script>
<script>
${appSrc}
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(__dirname, 'udar.html'), html);
console.log('wrote build/udar.html', (html.length / 1024).toFixed(0) + ' kB');
