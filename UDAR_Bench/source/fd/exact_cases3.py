import numpy as np, json, sys
sys.path.insert(0, '.')
from t4 import emp_dip, dip_normal
# tool straddling a vertical contrast: one antenna on each side (baseline = homogeneous medium of the midpoint side)
cases = [dict(f=24e3, L=16.0, mid=(0.0, 0.0), ang=90.0, x0=4.0, rl=50.0, rr=3.0),
         dict(f=6e3, L=30.0, mid=(0.0, 0.0), ang=90.0, x0=8.0, rl=20.0, rr=2.0),
         dict(f=6e3, L=30.0, mid=(0.0, 0.0), ang=90.0, x0=8.0, rl=2.0, rr=20.0),
         dict(f=24e3, L=16.0, mid=(0.0, 0.0), ang=60.0, x0=2.0, rl=20.0, rr=60.0),
         dict(f=100e3, L=8.0, mid=(0.0, 0.0), ang=90.0, x0=2.0, rl=5.0, rr=50.0),
         dict(f=6e3, L=30.0, mid=(0.0, 0.0), ang=88.0, x0=12.0, rl=20.0, rr=60.0)]
out = []
for c in cases:
    a = np.radians(c['ang']); ax = np.array([np.sin(a), np.cos(a)])
    tx = np.array(c['mid']) - 0.5 * c['L'] * ax; rx = np.array(c['mid']) + 0.5 * c['L'] * ax
    n = dip_normal(90.0); zi = [n @ np.array([c['x0'], 0.0])]
    H2 = emp_dip(c['f'], tuple(tx), tuple(rx), [c['rr'], c['rl']], zi, [1.0, 1.0], 90.0); H1 = emp_dip(c['f'], tuple(tx), tuple(rx), [c['rl']], [], [1.0], 90.0)
    sc = 2 * np.pi * c['L'] ** 3
    c['delta'] = {k: [((H2[k] - H1[k]) * sc).real, ((H2[k] - H1[k]) * sc).imag] for k in H2}
    c['h1'] = {k: [(H1[k] * sc).real, (H1[k] * sc).imag] for k in H1}
    out.append(c)
json.dump(out, open('exact_cases3.json', 'w'))
for c in out: print(c['f'], c['L'], c['x0'], c['rl'], c['rr'], 'max|delta| %.4g' % max(abs(complex(*v)) for v in c['delta'].values()))
