# CPU grid VM

One big Linux VM in `resist-hackathon-rg` (Sweden Central) for running inversion grids headless. Results go to the
shared Cosmos graph through the normal store, so the local backend (`GET /inversion/jobs?run=…`) sees them; the VM's
snapshot can be copied back and committed.

| | |
|---|---|
| VM | `resist-grid-vm`, Ubuntu 22.04, 128 GB Premium SSD, pay-as-you-go |
| Size | first available of `Standard_F72s_v2` → `F64s_v2` → `F48s_v2` → `F64as_v6` → `D64as_v5` (regional, then zones 1–3) |
| Cost | Linux PAYG, Sweden Central: F72s_v2 ≈ $3.49/h, F64as_v6 ≈ $4.67/h, D64as_v5 ≈ $2.94/h (+ disk/IP, small) |
| Auto-shutdown | 22:00 W. Europe (deallocates; compute billing stops) |
| Access | SSH only, NSG allows the creator's public IP; key `~/.ssh/resist_vm_ed25519` (never committed) |
| Identity | system-assigned, **Contributor on `resist-hackathon-rg` only** (for `az cosmosdb keys list`) |

## Use

```powershell
./infra/vm/create-vm.ps1              # idempotent; -AddMyIp adds your current IP to the SSH rule
./infra/vm/deploy.ps1                 # git bundle of HEAD -> /opt/resist, venv, az login --identity
./infra/vm/run-grid.ps1 infra/vm/grids/demo.json      # starts the grid with nohup on the VM
./infra/vm/run-grid.ps1 -Status       # tail the grid log
./infra/vm/fetch-results.ps1          # VM snapshot -> data/graph/inversions.json (review, then commit)
```

Only committed code is deployed (`deploy.ps1` bundles `HEAD`). On the VM, by hand:

```bash
cd /opt/resist && nohup .venv/bin/python -m backend.inversion.run_grid infra/vm/grids/demo.json > logs/grid.log 2>&1 &
```

## Grid spec

See `backend/inversion/run_grid.py`. `curves: "qc"` uses each run's QC auto-picks; `intervals: "auto"` tiles the
run's covered depth range in `auto_length_ft` windows; list-valued `layers` / `step_ft` / `quick` expand to a product.
Points already in the store (same fingerprint as `POST /inversion/jobs`) are skipped. `--dry-run` only lists them.

Parallelism: a single job only parallelises the n_earth + 1 forward models of a Jacobian, so ~10 workers per job is
the useful maximum. `--parallel auto` (default) runs several jobs at once with
`RESIST_INVERSION_WORKERS = (nproc - 2) / parallel`; `--parallel 1` runs one job at a time on nproc - 2 workers.

## Stop / delete

```powershell
az vm deallocate -g resist-hackathon-rg -n resist-grid-vm     # stop compute billing (disk still billed)
az vm start      -g resist-hackathon-rg -n resist-grid-vm     # public IP is static; re-run deploy if needed
# delete VM + its NIC, IP, disk, NSG, VNet (leaves Cosmos untouched):
az vm delete -g resist-hackathon-rg -n resist-grid-vm --yes
az resource delete -g resist-hackathon-rg --resource-type Microsoft.Network/networkInterfaces -n resist-grid-vmVMNic
az resource delete -g resist-hackathon-rg --resource-type Microsoft.Network/publicIPAddresses -n resist-grid-vmPublicIP
az resource delete -g resist-hackathon-rg --resource-type Microsoft.Network/virtualNetworks -n resist-grid-vmVNET
az resource delete -g resist-hackathon-rg --resource-type Microsoft.Network/networkSecurityGroups -n resist-grid-vm-nsg
az role assignment list --scope $(az group show -n resist-hackathon-rg --query id -o tsv) --role Contributor  # remove the VM identity's
```
