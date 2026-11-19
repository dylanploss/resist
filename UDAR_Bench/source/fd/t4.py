import numpy as np, time, sys
sys.path.insert(0, '.')
from fd25d import *
from t1 import emp_tensor
from t2 import sinh_nodes, run

def dip_normal(dip_deg):
    d = np.radians(dip_deg); return np.array([-np.sin(d), np.cos(d)])    # (nx,nz): plane deepens toward +x for dip>0

def tti_model(zi, rhs, lams, dip_deg):
    n = dip_normal(dip_deg); zi = np.asarray(zi, float); rhs = np.asarray(rhs, float); lams = np.asarray(lams, float)
    def m(X, Z):
        zn = n[0] * X + n[1] * Z; idx = np.searchsorted(zi, zn)
        sh = 1 / rhs[idx]; sv = 1 / (rhs[idx] * lams[idx] ** 2); dd = sv - sh
        return (sh + dd * n[0] ** 2, sh + 0 * X, sh + dd * n[1] ** 2, dd * n[0] * n[1])
    return m

def emp_dip(f, tx, rx, rhs, zi, lams, dip_deg):
    """reference tensor in the section (x,y,z) frame for planar dipping TIV layers. zi: interface coordinates along the normal"""
    n = dip_normal(dip_deg); xp = np.array([n[1], -n[0]])
    d = np.array(rx) - np.array(tx)
    zt = n @ np.array(tx); zr = n @ np.array(rx); xo = d @ xp
    T = emp_tensor(f, (0.0, zt), (xo, zr), rhs, list(zi), lams)
    # formation tensor matrix [x', y', z'] ; xp, z' = (components in section x,z); y' = y
    Tp = np.array([[T['xx'], 0, T['xz']], [0, T['yy'], 0], [T['zx'], 0, T['zz']]])
    Q = np.zeros((3, 3)); Q[:, 0] = [xp[0], 0, xp[1]]; Q[:, 1] = [0, 1, 0]; Q[:, 2] = [n[0], 0, n[1]]
    H = Q @ Tp @ Q.T
    return {'xx': H[0, 0], 'yy': H[1, 1], 'zz': H[2, 2], 'xz': H[0, 2], 'zx': H[2, 0]}

if __name__ == '__main__':
    f = 20e3; w = 2 * np.pi * f
    rhs = [2.0, 20.0, 5.0]; lams = [1.5, 1.2, 1.3]
    tx = (0.0, 0.0); rx = (0.0, 5.0)
    h = float(sys.argv[1]) if len(sys.argv) > 1 else 0.5
    core = 10.0
    xn = graded_axis(-core, core, h, 40, 40, 1.3); zn = graded_axis(-core, core, h, 40, 40, 1.3)
    g = Grid(xn, zn); print('grid', g.nx, g.nz, 'unk', g.ndof)
    ks, wk = sinh_nodes(0.1, 6.0, 8)
    for dip in (0, 30, 60, 85):
        n = dip_normal(dip)
        zi = [n @ np.array([0.0, 2.3]), n @ np.array([0.0, 6.9])]   # interfaces through (0,2.3) and (0,6.9)
        ref = emp_dip(f, tx, rx, rhs, zi, lams, dip)
        refB = emp_dip(f, tx, rx, [rhs[0]], [], [lams[0]], dip)
        t0 = time.time()
        TL, _ = run(g, cell_tensors(g, tti_model(zi, rhs, lams, dip), sub=4), w, tx, rx, ks, wk)
        TB, _ = run(g, cell_tensors(g, tti_model([], [rhs[0]], [lams[0]], dip), sub=4), w, tx, rx, ks, wk)
        sc = 1 / (2 * np.pi * 5.0 ** 3)
        s = f'dip={dip:2d} t={time.time()-t0:.1f}s '
        for c in ('xx', 'zz', 'xz', 'zx', 'yy'):
            secR = ref[c] - refB[c]; secF = TL[c] - TB[c]
            s += f'| {c}: tot {abs(TL[c]-ref[c])/sc:.1e} sec {abs(secF-secR)/sc:.1e} (|sec| {abs(secR)/sc:.2e}, |tot| {abs(ref[c])/sc:.2e})'
        print(s)
