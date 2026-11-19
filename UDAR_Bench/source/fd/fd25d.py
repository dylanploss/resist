"""2.5D frequency-domain EM finite-difference prototype (magnetic dipole sources, TTI conductivity in the x-z plane).
   Yee grid, e^{-i w t}, d/dy -> i k.  Unknowns on a (nx+1) x (nz+1) lattice, 3 dofs per lattice node:
     Ex[i,j] at (xc_i, z_j)   valid i=0..nx-1, j=1..nz-1
     Ey[i,j] at (x_i , z_j)   valid i=1..nx-1, j=1..nz-1
     Ez[i,j] at (x_i , zc_j)  valid i=1..nx-1, j=0..nz-1
   PEC outer box (tangential E = 0).
"""
import numpy as np, scipy.sparse as sp, scipy.sparse.linalg as spla
MU0 = 4e-7 * np.pi

def graded_axis(c0, c1, h, W0, W1, stretch):
    n = max(1, int(np.ceil((c1 - c0) / h - 1e-9))); hh = (c1 - c0) / n
    core = c0 + hh * np.arange(n + 1)
    left = []; x = c0; s = hh
    while c0 - x < W0 - 1e-9: s *= stretch; x -= s; left.append(x)
    right = []; x = c1; s = hh
    while x - c1 < W1 - 1e-9: s *= stretch; x += s; right.append(x)
    return np.concatenate([np.array(left[::-1]), core, np.array(right)])

class Grid:
    def __init__(self, xn, zn):
        self.xn = np.asarray(xn, float); self.zn = np.asarray(zn, float)
        self.nx = len(xn) - 1; self.nz = len(zn) - 1; self.NX = self.nx + 1; self.NZ = self.nz + 1
        self.hx = np.diff(self.xn); self.hz = np.diff(self.zn)
        self.xc = 0.5 * (self.xn[:-1] + self.xn[1:]); self.zc = 0.5 * (self.zn[:-1] + self.zn[1:])
        self.hxc = np.zeros(self.NX); self.hxc[1:-1] = 0.5 * (self.hx[:-1] + self.hx[1:])   # around node i (1..nx-1)
        self.hzc = np.zeros(self.NZ); self.hzc[1:-1] = 0.5 * (self.hz[:-1] + self.hz[1:])
        self.ndof = 3 * self.NX * self.NZ
    def idx(self, comp, i, j): return comp * self.NX * self.NZ + np.asarray(i) * self.NZ + np.asarray(j)

def cell_tensors(grid, model, sub=3):
    """model(x,z) -> (sxx, syy, szz, sxz) arrays; cell averages from sub x sub samples"""
    nx, nz = grid.nx, grid.nz; out = np.zeros((4, nx, nz))
    for a in range(sub):
        fa = (a + 0.5) / sub
        for b in range(sub):
            fb = (b + 0.5) / sub
            X = grid.xn[:-1, None] + fa * grid.hx[:, None] + 0 * grid.zn[None, :-1]
            Z = grid.zn[None, :-1] + fb * grid.hz[None, :] + 0 * grid.xn[:-1, None]
            t = model(X, Z)
            for q in range(4): out[q] += t[q]
    return out / (sub * sub)

def assemble(grid, ten, omega, k):
    g = grid; NX, NZ, nx, nz = g.NX, g.NZ, g.nx, g.nz; q = 1j * omega * MU0
    sxx, syy, szz, sxz = ten
    rows = []; cols = []; vals = []
    valid = np.zeros(g.ndof, bool)
    def add(r, c, v, cvalid):
        # r, c: index arrays; v: values; cvalid: mask of valid columns
        m = cvalid & (np.abs(v) > 0 if np.iscomplexobj(v) else v != 0)
        rows.append(r[m]); cols.append(c[m]); vals.append(np.asarray(v)[m])
    ik = 1j * k
    # ---- Ex rows
    I, J = np.meshgrid(np.arange(0, nx), np.arange(1, nz), indexing='ij'); I = I.ravel(); J = J.ravel()
    r = g.idx(0, I, J); valid[r] = True
    hx = g.hx[I]; hzm = g.hz[J - 1]; hzp = g.hz[J]; hzc = g.hzc[J]; V = hx * hzc
    def vEx(i, j): return (i >= 0) & (i <= nx - 1) & (j >= 1) & (j <= nz - 1)
    def vEy(i, j): return (i >= 1) & (i <= nx - 1) & (j >= 1) & (j <= nz - 1)
    def vEz(i, j): return (i >= 1) & (i <= nx - 1) & (j >= 0) & (j <= nz - 1)
    # diag + z second difference + k^2
    add(r, r, (k * k * V + hx / hzp + hx / hzm).astype(complex), np.ones_like(r, bool))
    add(r, g.idx(0, I, J + 1), -hx / hzp, vEx(I, J + 1))
    add(r, g.idx(0, I, J - 1), -hx / hzm, vEx(I, J - 1))
    # Ey coupling: ik hzc (Ey[i+1,j] - Ey[i,j])
    add(r, g.idx(1, I + 1, J), ik * hzc, vEy(I + 1, J)); add(r, g.idx(1, I, J), -ik * hzc, vEy(I, J))
    # Ez coupling: (Ez[i+1,j]-Ez[i,j]) - (Ez[i+1,j-1]-Ez[i,j-1])
    add(r, g.idx(2, I + 1, J), np.ones(len(r), complex), vEz(I + 1, J)); add(r, g.idx(2, I, J), -np.ones(len(r), complex), vEz(I, J))
    add(r, g.idx(2, I + 1, J - 1), -np.ones(len(r), complex), vEz(I + 1, J - 1)); add(r, g.idx(2, I, J - 1), np.ones(len(r), complex), vEz(I, J - 1))
    # conductivity (lumped xx)
    vxx = hx * (hzm * sxx[I, J - 1] + hzp * sxx[I, J]) / 2
    add(r, r, -q * vxx, np.ones_like(r, bool))
    # ---- Ey rows
    I, J = np.meshgrid(np.arange(1, nx), np.arange(1, nz), indexing='ij'); I = I.ravel(); J = J.ravel()
    r = g.idx(1, I, J); valid[r] = True
    hxm = g.hx[I - 1]; hxp = g.hx[I]; hzm = g.hz[J - 1]; hzp = g.hz[J]; hxc = g.hxc[I]; hzc = g.hzc[J]; V = hxc * hzc
    add(r, r, (k * k * 0 + hxc / hzp + hxc / hzm + hzc / hxp + hzc / hxm).astype(complex), np.ones_like(r, bool))
    add(r, g.idx(1, I, J + 1), -hxc / hzp, vEy(I, J + 1)); add(r, g.idx(1, I, J - 1), -hxc / hzm, vEy(I, J - 1))
    add(r, g.idx(1, I + 1, J), -hzc / hxp, vEy(I + 1, J)); add(r, g.idx(1, I - 1, J), -hzc / hxm, vEy(I - 1, J))
    add(r, g.idx(2, I, J), ik * hxc, vEz(I, J)); add(r, g.idx(2, I, J - 1), -ik * hxc, vEz(I, J - 1))
    add(r, g.idx(0, I, J), ik * hzc, vEx(I, J)); add(r, g.idx(0, I - 1, J), -ik * hzc, vEx(I - 1, J))
    vyy = (hxm * hzm * syy[I - 1, J - 1] + hxp * hzm * syy[I, J - 1] + hxm * hzp * syy[I - 1, J] + hxp * hzp * syy[I, J]) / 4
    add(r, r, -q * vyy, np.ones_like(r, bool))
    # ---- Ez rows
    I, J = np.meshgrid(np.arange(1, nx), np.arange(0, nz), indexing='ij'); I = I.ravel(); J = J.ravel()
    r = g.idx(2, I, J); valid[r] = True
    hxm = g.hx[I - 1]; hxp = g.hx[I]; hz = g.hz[J]; hxc = g.hxc[I]; V = hxc * hz
    add(r, r, (k * k * V + hz / hxp + hz / hxm).astype(complex), np.ones_like(r, bool))
    add(r, g.idx(2, I + 1, J), -hz / hxp, vEz(I + 1, J)); add(r, g.idx(2, I - 1, J), -hz / hxm, vEz(I - 1, J))
    # Ex coupling: (Ex[i,j+1]-Ex[i,j]) - (Ex[i-1,j+1]-Ex[i-1,j])
    one = np.ones(len(r), complex)
    add(r, g.idx(0, I, J + 1), one, vEx(I, J + 1)); add(r, g.idx(0, I, J), -one, vEx(I, J))
    add(r, g.idx(0, I - 1, J + 1), -one, vEx(I - 1, J + 1)); add(r, g.idx(0, I - 1, J), one, vEx(I - 1, J))
    # Ey coupling: ik hxc (Ey[i,j+1]-Ey[i,j])
    add(r, g.idx(1, I, J + 1), ik * hxc, vEy(I, J + 1)); add(r, g.idx(1, I, J), -ik * hxc, vEy(I, J))
    vzz = hz * (hxm * szz[I - 1, J] + hxp * szz[I, J]) / 2
    add(r, r, -q * vzz, np.ones_like(r, bool))
    # ---- cross term sxz (consistent, per cell)
    I, J = np.meshgrid(np.arange(0, nx), np.arange(0, nz), indexing='ij'); I = I.ravel(); J = J.ravel()
    c = g.hx[I] * g.hz[J] * sxz[I, J] / 4
    for dj in (0, 1):
        for di in (0, 1):
            a = g.idx(0, I, J + dj); b = g.idx(2, I + di, J)
            m = vEx(I, J + dj) & vEz(I + di, J)
            add(a, b, -q * c, m); add(b, a, -q * c, m)
    # identity rows for invalid dofs
    inv = np.where(~valid)[0]
    rows.append(inv); cols.append(inv); vals.append(np.ones(len(inv), complex))
    A = sp.coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(g.ndof, g.ndof)).tocsc()
    return A, valid

def bilin(axis_pts, p):
    """index and weight for linear interpolation on sorted points axis_pts at p -> (i0, w0, w1)"""
    i = int(np.clip(np.searchsorted(axis_pts, p) - 1, 0, len(axis_pts) - 2)); t = (p - axis_pts[i]) / (axis_pts[i + 1] - axis_pts[i])
    return i, 1 - t, t

def source_rhs(grid, omega, k, pos, m):
    """RHS for a magnetic dipole m=(mx,my,mz) at pos=(x,z) (per unit moment in the k-domain)"""
    g = grid; q = 1j * omega * MU0; ik = 1j * k; NX, NZ, nx, nz = g.NX, g.NZ, g.nx, g.nz
    Mx = np.zeros((NX, NZ), complex); My = np.zeros((NX, NZ), complex); Mz = np.zeros((NX, NZ), complex)
    xs, zs = pos
    # Mx at (x_i, zc_j)  [i=0..nx, j=0..nz-1]; area hxc_i*hz_j  (end nodes: half cells)
    def dual(h): d = np.zeros(len(h) + 1); d[:-1] += h / 2; d[1:] += h / 2; return d
    dxn = dual(g.hx); dzn = dual(g.hz)     # dual widths at nodes (end nodes half cell)
    # Mx lattice: x at nodes, z at centers
    i0, a0, a1 = bilin(g.xn, xs); j0, b0, b1 = bilin(g.zc, zs)
    for (di, wi) in ((0, a0), (1, a1)):
        for (dj, wj) in ((0, b0), (1, b1)):
            i, j = i0 + di, j0 + dj; Mx[i, j] += m[0] * wi * wj / (dxn[i] * g.hz[j])
    # Mz lattice: x at centers, z at nodes
    i0, a0, a1 = bilin(g.xc, xs); j0, b0, b1 = bilin(g.zn, zs)
    for (di, wi) in ((0, a0), (1, a1)):
        for (dj, wj) in ((0, b0), (1, b1)):
            i, j = i0 + di, j0 + dj; Mz[i, j] += m[2] * wi * wj / (g.hx[i] * dzn[j])
    # My lattice: x at centers, z at centers
    i0, a0, a1 = bilin(g.xc, xs); j0, b0, b1 = bilin(g.zc, zs)
    for (di, wi) in ((0, a0), (1, a1)):
        for (dj, wj) in ((0, b0), (1, b1)):
            i, j = i0 + di, j0 + dj; My[i, j] += m[1] * wi * wj / (g.hx[i] * g.hz[j])
    b = np.zeros(g.ndof, complex)
    # Ex rows i=0..nx-1, j=1..nz-1: q[ ik hx hzc Mz[i,j] - hx (My[i,j]-My[i,j-1]) ]
    I, J = np.meshgrid(np.arange(0, nx), np.arange(1, nz), indexing='ij')
    b[g.idx(0, I, J)] = q * (ik * g.hx[I] * g.hzc[J] * Mz[I, J] - g.hx[I] * (My[I, J] - My[I, J - 1]))
    # Ey rows i=1..nx-1, j=1..nz-1: q[ hxc (Mx[i,j]-Mx[i,j-1]) - hzc (Mz[i,j]-Mz[i-1,j]) ]
    I, J = np.meshgrid(np.arange(1, nx), np.arange(1, nz), indexing='ij')
    b[g.idx(1, I, J)] = q * (g.hxc[I] * (Mx[I, J] - Mx[I, J - 1]) - g.hzc[J] * (Mz[I, J] - Mz[I - 1, J]))
    # Ez rows i=1..nx-1, j=0..nz-1: q[ hz (My[i,j]-My[i-1,j]) - ik hxc hz Mx[i,j] ]
    I, J = np.meshgrid(np.arange(1, nx), np.arange(0, nz), indexing='ij')
    b[g.idx(2, I, J)] = q * (g.hz[J] * (My[I, J] - My[I - 1, J]) - ik * g.hxc[I] * g.hz[J] * Mx[I, J])
    return b

def receiver_functionals(grid, omega, k, pos):
    """rows (sparse vectors over dofs) giving H' = (Hx', Hy', Hz') at pos from E"""
    g = grid; q = 1j * omega * MU0; ik = 1j * k; xs, zs = pos
    out = []
    # Hx' = Qx/q at (x_i, zc_j): Qx = ik Ez[i,j] - (Ey[i,j+1]-Ey[i,j])/hz[j]
    i0, a0, a1 = bilin(g.xn, xs); j0, b0, b1 = bilin(g.zc, zs); d = {}
    for di, wi in ((0, a0), (1, a1)):
        for dj, wj in ((0, b0), (1, b1)):
            i, j = i0 + di, j0 + dj; w = wi * wj / q
            for key, val in ((g.idx(2, i, j), ik * w), (g.idx(1, i, j + 1), -w / g.hz[j]), (g.idx(1, i, j), w / g.hz[j])): d[int(key)] = d.get(int(key), 0) + val
    out.append(d)
    # Hy' = Qy/q at (xc_i, zc_j): Qy = (Ex[i,j+1]-Ex[i,j])/hz[j] - (Ez[i+1,j]-Ez[i,j])/hx[i]
    i0, a0, a1 = bilin(g.xc, xs); j0, b0, b1 = bilin(g.zc, zs); d = {}
    for di, wi in ((0, a0), (1, a1)):
        for dj, wj in ((0, b0), (1, b1)):
            i, j = i0 + di, j0 + dj; w = wi * wj / q
            for key, val in ((g.idx(0, i, j + 1), w / g.hz[j]), (g.idx(0, i, j), -w / g.hz[j]), (g.idx(2, i + 1, j), -w / g.hx[i]), (g.idx(2, i, j), w / g.hx[i])): d[int(key)] = d.get(int(key), 0) + val
    out.append(d)
    # Hz' = Qz/q at (xc_i, z_j): Qz = (Ey[i+1,j]-Ey[i,j])/hx[i] - ik Ex[i,j]
    i0, a0, a1 = bilin(g.xc, xs); j0, b0, b1 = bilin(g.zn, zs); d = {}
    for di, wi in ((0, a0), (1, a1)):
        for dj, wj in ((0, b0), (1, b1)):
            i, j = i0 + di, j0 + dj; w = wi * wj / q
            for key, val in ((g.idx(1, i + 1, j), w / g.hx[i]), (g.idx(1, i, j), -w / g.hx[i]), (g.idx(0, i, j), -ik * w)): d[int(key)] = d.get(int(key), 0) + val
    out.append(d)
    mats = []
    for d in out:
        keys = np.array(list(d.keys())); v = np.array([d[kk] for kk in d.keys()])
        mats.append(sp.csr_matrix((v, (np.zeros(len(keys), int), keys)), shape=(1, g.ndof)))
    return sp.vstack(mats).tocsr()      # 3 x ndof : rows Hx', Hy', Hz'

# ---------------------------------------------------------------------------------------------------------------
def gauss_log_nodes(kmin, kmax, n):
    xg, wg = np.polynomial.legendre.leggauss(n); u0, u1 = np.log(kmin), np.log(kmax)
    u = 0.5 * (u1 - u0) * xg + 0.5 * (u1 + u0); w = 0.5 * (u1 - u0) * wg; k = np.exp(u)
    return k, w * k                      # integral f(k) dk ~ sum wk f(k)

def tensor_at(grid, ten, omega, tx, rx, ks, wk):
    """H tensor at rx from unit dipoles at tx; returns dict with xx,zz,xz,zx,yy  (H_comp from source comp) integrated over k"""
    T = {c: 0j for c in ('xx', 'zz', 'xz', 'zx', 'yy')}
    for k, w in zip(ks, wk):
        A, valid = assemble(grid, ten, omega, k); lu = spla.splu(A)
        R = receiver_functionals(grid, omega, k, rx)
        for s, name in ((0, 'x'), (1, 'y'), (2, 'z')):
            m = [0, 0, 0]; m[s] = 1.0
            b = source_rhs(grid, omega, k, tx, m); E = lu.solve(b); H = R @ E       # H' (smeared M absent at rx)
            Hx, Hy, Hz = H
            if name == 'x': T['xx'] += w / np.pi * Hx; T['zx'] += w / np.pi * Hz      # 'zx' = Hz from x source
            if name == 'z': T['zz'] += w / np.pi * Hz; T['xz'] += w / np.pi * Hx      # 'xz' = Hx from z source
            if name == 'y': T['yy'] += w / np.pi * Hy
    return T
