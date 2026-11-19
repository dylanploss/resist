import numpy as np, json, mpmath as mp, empymod
mp.mp.dps = 30
mu0 = mp.mpf(4e-7)*mp.pi
cases = json.load(open('ref/layered_cases.json'))
c = cases[75]
print({k:c[k] for k in ['res','aniso','f','zs','zr','rho']})
rh = c['res'][0]; an = c['aniso'][0]; f = c['f']; zs=c['zs']; zr=c['zr']; rho=mp.mpf(c['rho']); dz = mp.mpf(zr-zs)
w = 2*mp.pi*f
sh = mp.mpf(1)/rh; kap = mp.mpf(an); sv = sh/kap**2
kh2 = 1j*w*mu0*sh
def u(lam): return mp.sqrt(lam**2 - kh2)
def v(lam): return mp.sqrt(kap**2*lam**2 - kh2)
# primary kernels (TE: Ge_zs = -u e^{-u|dz|}/2 ; TM: k^2 Gm = kh2 e^{-v|dz|}/(2v))
Gzs = lambda lam: -u(lam)*mp.e**(-u(lam)*abs(dz))/2
k2Gm = lambda lam: kh2*mp.e**(-v(lam)*abs(dz))/(2*v(lam))
J0 = lambda x: mp.besselj(0,x); J1 = lambda x: mp.besselj(1,x)
def hank(fn, order):
    # integrate with a moderately long path using quadosc-like splitting
    return mp.quadosc(lambda lam: fn(lam)*mp.besselj(order, lam*rho), [0, mp.inf], omega=rho)
Hxx = (hank(lambda l: l*Gzs(l), 0) + (1/rho)*hank(lambda l: k2Gm(l)-Gzs(l), 1))/(2*mp.pi)
Hyy = (hank(lambda l: l*k2Gm(l), 0) + (1/rho)*hank(lambda l: Gzs(l)-k2Gm(l), 1))/(2*mp.pi)
print('numeric Hankel (spectral derivation):  Hxx =', mp.nstr(Hxx,10), ' Hyy =', mp.nstr(Hyy,10))
