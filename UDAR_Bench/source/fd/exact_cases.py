import numpy as np, json, sys
sys.path.insert(0, '.')
from t4 import emp_dip, dip_normal
from fd25d import MU0
# lateral contrast = vertical planar interface x = x0 between isotropic half-spaces (exact 1D solution in the rotated frame)
cases = [
  dict(f=20e3, L=5.0, mid=(0.0, 2.5), ang=0.0, x0=4.0, rl=20.0, rr=60.0),
  dict(f=6e3, L=30.0, mid=(0.0, 0.0), ang=0.0, x0=15.0, rl=20.0, rr=1.0),
  dict(f=100e3, L=8.0, mid=(0.0, 0.0), ang=0.0, x0=3.0, rl=5.0, rr=100.0),
  dict(f=24e3, L=16.0, mid=(0.0, 0.0), ang=0.0, x0=8.0, rl=50.0, rr=2.0),
  dict(f=2e3, L=40.0, mid=(0.0, 0.0), ang=0.0, x0=20.0, rl=10.0, rr=200.0),
  dict(f=24e3, L=16.0, mid=(1.0, 0.0), ang=90.0, x0=12.0, rl=50.0, rr=3.0),      # horizontal tool (axis along x) approaching the contact
  dict(f=24e3, L=16.0, mid=(1.0, 0.0), ang=90.0, x0=20.0, rl=50.0, rr=3.0),
  dict(f=6e3, L=30.0, mid=(0.0, 0.0), ang=60.0, x0=14.0, rl=30.0, rr=3.0),       # inclined tool
]
out = []
for c in cases:
    a = np.radians(c['ang']); ax = np.array([np.sin(a), np.cos(a)])           # tool axis (x,z), ang measured from +z toward +x
    tx = np.array(c['mid']) - 0.5 * c['L'] * ax; rx = np.array(c['mid']) + 0.5 * c['L'] * ax
    n = dip_normal(90.0); zi = [n @ np.array([c['x0'], 0.0])]
    # layers along the normal n=(-1,0): n.r = -x ;  layer 0: -x < -x0  <=> x > x0 (right) ; layer 1: x < x0 (left)
    H2 = emp_dip(c['f'], tuple(tx), tuple(rx), [c['rr'], c['rl']], zi, [1.0, 1.0], 90.0)
    H1 = emp_dip(c['f'], tuple(tx), tuple(rx), [c['rl']], [], [1.0], 90.0)
    sc = 2 * np.pi * c['L'] ** 3
    c['delta'] = {k: [((H2[k] - H1[k]) * sc).real, ((H2[k] - H1[k]) * sc).imag] for k in H2}
    c['H1'] = {k: [(H1[k] * sc).real, (H1[k] * sc).imag] for k in H1}
    out.append(c)
    print(c['f'], c['L'], c['x0'], {k: f"{abs(complex(*v)):.2e}" for k, v in c['delta'].items()}, ' |H1|', {k: f"{abs(complex(*v)):.2e}" for k, v in c['H1'].items()})
json.dump(out, open('exact_cases.json', 'w'))
