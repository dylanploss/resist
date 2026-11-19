import numpy as np, time, sys
sys.path.insert(0, '.')
from fd25d import *
import empymod

def emp_tensor(f, tx, rx, res, depth, aniso):
    """reference H tensor (e^{-iwt}) with tx=(x,z), rx=(x,z) in the same y-plane. returns dict xx,yy,zz,xz,zx"""
    w = 2 * np.pi * f; out = {}
    abmap = dict(xx=44, yy=55, zz=66, xz=46, zx=64)
    for name, ab in abmap.items():
        e = empymod.dipole([tx[0], 0, tx[1]], [rx[0], 0, rx[1]], depth, res, f, ab=ab, aniso=aniso,
                           epermH=[0] * len(res), epermV=[0] * len(res), xdirect=False, ht='dlf',
                           htarg={'dlf': 'key_201_2012'}, verb=0)
        out[name] = np.conj(complex(e) * 1j * w * MU0)
    return out

def hom_model(rh, rv=None):
    sh = 1 / rh; sv = 1 / (rv if rv else rh)
    def m(X, Z): return (sh + 0 * X, sh + 0 * X, sv + 0 * X, 0 * X)   # sxx, syy, szz, sxz  (x,y horizontal=sh, z vertical = sv)
    return m

if __name__ == '__main__':
    f = 20e3; rho = 10.0; w = 2 * np.pi * f
    tx = (0.0, 0.0); rx = (0.0, 5.0)         # coaxial in z, 5 m
    h = 0.25; core = 8.0
    xn = graded_axis(-core, core, h, 40, 40, 1.25); zn = graded_axis(-core, core, h, 40, 40, 1.25)
    g = Grid(xn, zn); print('grid', g.nx, g.nz, 'unknowns', g.ndof)
    ten = cell_tensors(g, hom_model(rho), sub=1)
    ref = emp_tensor(f, tx, rx, [rho], [], [1.0])
    print('ref  ', {k: complex(np.round(v, 10)) for k, v in ref.items()})
    # integrand vs k
    for k in [1e-3, 1e-2, 0.03, 0.1, 0.3, 1.0, 3.0]:
        t0 = time.time(); A, valid = assemble(g, ten, w, k); lu = spla.splu(A); R = receiver_functionals(g, w, k, rx)
        b = source_rhs(g, w, k, tx, [0, 0, 1.0]); E = lu.solve(b); H = R @ E
        print(f'k={k:8.4f} Hzz-int={H[2]:.5e}  (t={time.time()-t0:.2f}s)')
