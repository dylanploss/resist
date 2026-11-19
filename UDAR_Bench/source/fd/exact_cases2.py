import numpy as np, json, sys
sys.path.insert(0, '.')
from t4 import emp_dip, dip_normal
cases = []
for rl, rr in [(20, 15), (20, 5), (20, 1), (20, 0.2), (20, 100), (20, 1000)]:
    cases.append(dict(f=6e3, L=30.0, mid=(0.0, 0.0), ang=0.0, x0=15.0, rl=rl, rr=rr))
for f in (1e3, 24e3, 100e3):
    cases.append(dict(f=f, L=30.0, mid=(0.0, 0.0), ang=0.0, x0=15.0, rl=20.0, rr=2.0))
out = []
for c in cases:
    a = np.radians(c['ang']); ax = np.array([np.sin(a), np.cos(a)])
    tx = np.array(c['mid']) - 0.5 * c['L'] * ax; rx = np.array(c['mid']) + 0.5 * c['L'] * ax
    n = dip_normal(90.0); zi = [n @ np.array([c['x0'], 0.0])]
    H2 = emp_dip(c['f'], tuple(tx), tuple(rx), [c['rr'], c['rl']], zi, [1.0, 1.0], 90.0); H1 = emp_dip(c['f'], tuple(tx), tuple(rx), [c['rl']], [], [1.0], 90.0)
    sc = 2 * np.pi * c['L'] ** 3
    c['delta'] = {k: [((H2[k] - H1[k]) * sc).real, ((H2[k] - H1[k]) * sc).imag] for k in H2}
    out.append(c)
json.dump(out, open('exact_cases2.json', 'w'))
print('ok', len(out))
