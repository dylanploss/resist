"""Generate layered-TIV reference cases with empymod (high-accuracy QWE) in MY convention.
   H_mine = conj(H_emp * i*w*mu0)  (empymod: e^{+iwt}, unit magnetic *current* dipole)
   z positive downwards, layer 0 = top half-space."""
import numpy as np, empymod, json, sys
mu0 = 4e-7*np.pi
rng = np.random.default_rng(12345)
cases = []
abmap = dict(xx=44, yy=55, zz=66, xz=46, zx=64)   # first digit receiver, second digit source

def run(depth, res, aniso, f, zs, zr, rho, how='qwe'):
    out = {}
    for name, ab in abmap.items():
        if how == 'qwe':
            e = empymod.dipole([0,0,zs],[rho,0,zr],depth,res,f,ab=ab,aniso=aniso,epermH=[0]*len(res),epermV=[0]*len(res),xdirect=False,ht='qwe',htarg={'rtol':1e-10,'atol':1e-40,'maxint':400,'nquad':51},verb=0)
        else:
            e = empymod.dipole([0,0,zs],[rho,0,zr],depth,res,f,ab=ab,aniso=aniso,epermH=[0]*len(res),epermV=[0]*len(res),xdirect=False,verb=0)
        e = complex(e)
        w = 2*np.pi*f
        out[name] = np.conj(e*1j*w*mu0)
    return out

ncase = int(sys.argv[1]) if len(sys.argv)>1 else 60
for ic in range(ncase):
    N = int(rng.integers(1, 7))          # layers incl. half-spaces
    depth = np.sort(rng.uniform(-30, 60, N-1)).tolist() if N>1 else []
    # enforce min thickness 1.5 m
    for k in range(1, len(depth)):
        if depth[k]-depth[k-1] < 1.5: depth[k] = depth[k-1] + 1.5 + rng.uniform(0,3)
    res = (10**rng.uniform(-0.5, 2.5, N)).tolist()
    aniso = rng.uniform(1.0, 2.5, N).tolist()
    f = float(rng.choice([400., 2000., 6000., 12000., 24000., 100000.]))
    # place source in a random layer, receiver in same/other layer
    def pick_z(layer):
        top = depth[layer-1] if layer>0 else (depth[0]-40 if depth else -40)
        bot = depth[layer] if layer<N-1 else (depth[-1]+40 if depth else 40)
        return float(rng.uniform(top+0.2, bot-0.2)) if bot-top>0.5 else float(0.5*(top+bot))
    ls = int(rng.integers(0, N)); zs = pick_z(ls)
    mode = rng.choice(['same','any'])
    lr = ls if mode=='same' and rng.random()<0.8 else int(rng.integers(0, N))
    zr = pick_z(lr)
    if rng.random() < 0.15 and lr == ls: zr = zs + 0.3
    rho = float(rng.uniform(2, 50))
    try:
        h = run(depth, res, aniso, f, zs, zr, rho)
    except Exception as ex:
        print("skip", ic, ex); continue
    cases.append(dict(depth=depth, res=res, aniso=aniso, f=f, zs=zs, zr=zr, rho=rho,
        H={k:[v.real, v.imag] for k,v in h.items()}))
json.dump(cases, open('ref/layered_cases.json','w'))
print(len(cases), "cases written")
