import numpy as np, empymod, json
mu0 = 4e-7*np.pi
cases = json.load(open('ref/layered_cases.json'))
abmap = dict(xx=44, yy=55, zz=66, xz=46, zx=64)
for c in cases:
    w = 2*np.pi*c['f']; out = {}
    for name, ab in abmap.items():
        e = empymod.dipole([0,0,c['zs']],[c['rho'],0,c['zr']],c['depth'],c['res'],c['f'],ab=ab,aniso=c['aniso'],epermH=[0]*len(c['res']),epermV=[0]*len(c['res']),xdirect=False,ht='dlf',htarg={'dlf':'key_201_2012'},verb=0)
        out[name] = np.conj(complex(e)*1j*w*mu0)
    c['Hdlf'] = {k:[v.real, v.imag] for k,v in out.items()}
json.dump(cases, open('ref/layered_cases.json','w'))
print('ok')
