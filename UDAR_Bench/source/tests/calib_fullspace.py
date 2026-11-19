import numpy as np, empymod
mu0 = 4e-7*np.pi

def direct_tiv(f, rho_h, aniso, rho, dz):
    """my closed-form TIV full-space magnetic-dipole tensor, e^{-i w t}, per unit moment.
    returns dict xx,yy,zz,xz,zx"""
    w = 2*np.pi*f
    sh = 1.0/rho_h
    kap = aniso                      # kappa = sqrt(sigma_h/sigma_v) = sqrt(rho_v/rho_h)
    sv = sh/kap**2
    kh = np.sqrt(1j*w*mu0*sh)
    kv = np.sqrt(1j*w*mu0*sv)
    R  = np.sqrt(rho**2 + dz**2)
    Rv = np.sqrt(rho**2 + (kap*dz)**2)
    phi = np.exp(1j*kh*R)/R
    f1  = (1j*kh - 1.0/R)*phi
    f1p = phi*(-kh**2 - 2j*kh/R + 2.0/R**2)
    d2z  = f1*(1.0/R - dz**2/R**3) + (dz**2/R**2)*f1p
    drdz = (rho*dz/R**2)*(f1p - f1/R)
    psi = np.exp(1j*kv*Rv)/Rv
    zz = (d2z + kh**2*phi)/(4*np.pi)
    xz = drdz/(4*np.pi)
    xx = -(d2z + f1/R)/(4*np.pi) + 1j*kh/(4*np.pi*rho**2)*(np.exp(1j*kh*R) - np.exp(1j*kv*Rv))
    yy = (f1/R + kap*kv**2*psi)/(4*np.pi) + 1j*kh/(4*np.pi*rho**2)*(np.exp(1j*kv*Rv) - np.exp(1j*kh*R))
    return dict(xx=xx, yy=yy, zz=zz, xz=xz, zx=xz)

f = 12000.0
for (rh, an) in [(10.0, 1.0), (10.0, 1.7), (3.0, 2.5)]:
    for (rho, dz) in [(10.0, 4.0), (6.0, -9.0), (20.0, 0.5), (2.0, 15.0)]:
        mine = direct_tiv(f, rh, an, rho, dz)
        res = {}
        for name, ab in dict(xx=44, yy=55, zz=66, xz=46, zx=64).items():
            res[name] = empymod.dipole([0, 0, 0], [rho, 0, dz], [], [rh], f, ab=ab, aniso=[an], verb=0)
        print("rh=%g aniso=%g rho=%g dz=%g" % (rh, an, rho, dz))
        for k in ['xx','yy','zz','xz','zx']:
            e = complex(res[k])
            m = mine[k]
            print("  %s  emp=% .6e%+.6ej   mine=% .6e%+.6ej   emp/mine=%s  emp/conj(mine)=%s" % (k, e.real, e.imag, m.real, m.imag, np.round(e/m,6), np.round(e/np.conj(m),6)))
