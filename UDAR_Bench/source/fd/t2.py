import numpy as np, time, sys
sys.path.insert(0, '.')
from fd25d import *
from t1 import emp_tensor, hom_model

def sinh_nodes(k0, kmax, n):
    xg, wg = np.polynomial.legendre.leggauss(n); umax = np.arcsinh(kmax / k0)
    u = 0.5 * umax * (xg + 1); w = 0.5 * umax * wg
    return k0 * np.sinh(u), w * k0 * np.cosh(u)

def run(g, ten, w, tx, rx, ks, wk):
    T = {c: 0j for c in ('xx', 'zz', 'xz', 'zx', 'yy')}
    cache = []
    for k, wt in zip(ks, wk):
        A, valid = assemble(g, ten, w, k); lu = spla.splu(A); R = receiver_functionals(g, w, k, rx)
        res = {}
        for s in range(3):
            m = [0, 0, 0]; m[s] = 1.0
            E = lu.solve(source_rhs(g, w, k, tx, m)); res[s] = R @ E
        cache.append(res)
        T['xx'] += wt / np.pi * res[0][0]; T['zx'] += wt / np.pi * res[0][2]
        T['zz'] += wt / np.pi * res[2][2]; T['xz'] += wt / np.pi * res[2][0]
        T['yy'] += wt / np.pi * res[1][1]
    return T, cache

if __name__ == '__main__':
    f = 20e3; rho = 10.0; w = 2 * np.pi * f
    tx = (0.0, 0.0); rx = (1.0, 5.0)
    h = 0.25; core = 8.0
    xn = graded_axis(-core, core, h, 40, 40, 1.25); zn = graded_axis(-core, core, h, 40, 40, 1.25)
    g = Grid(xn, zn); print('grid', g.nx, g.nz, 'unknowns', g.ndof)
    ten = cell_tensors(g, hom_model(rho), sub=1)
    ref = emp_tensor(f, tx, rx, [rho], [], [1.0])
    for n in (6, 10, 16):
        ks, wk = sinh_nodes(0.1, 6.0, n)
        T, _ = run(g, ten, w, tx, rx, ks, wk)
        print(n, {c: f'{abs(T[c]-ref[c])/abs(ref[c]):.2e}' for c in T}, ' |ref|', {c: f'{abs(ref[c]):.2e}' for c in T})
