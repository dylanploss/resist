# CPU grid VM / inversion server

One big Linux VM in `resist-hackathon-rg` (Sweden Central). It runs the backend as the **inversion server**
(`resist-backend` systemd service on `:8000`, used by the "run on the server" option, `backend/inversion_server.json`)
and headless inversion **grids**. Results go to the shared Cosmos graph through the normal store, so every backend
(`GET /inversion/jobs?run=…`) sees them.

| | |
|---|---|
| VM | `resist-grid-vm`, `Standard_F64as_v6` (64 vCPU, zone 1), Ubuntu 22.04, 128 GB Premium SSD, pay-as-you-go |
| Size order | `F72s_v2` → `F64s_v2` → `F48s_v2` → `F64as_v6` → `D64as_v5`, each regional then zones 1–3 (FSv2 had no capacity in Sweden Central on 2026-11-20) |
| Cost | F64as_v6 ≈ $4.67/h Linux PAYG (F72s_v2 ≈ $3.49/h, D64as_v5 ≈ $2.94/h) + disk/IP |
| Auto-shutdown | 22:00 W. Europe (deallocates; compute billing stops) |
| Access | NSG: SSH (22) and the server (8000) only from allow-listed IPs; key `~/.ssh/resist_vm_ed25519` (never committed) |
| Identity | system-assigned; `create-vm.ps1` grants it Contributor on `resist-hackathon-rg` only, for `az cosmosdb keys list`. That needs Owner / User Access Administrator. Without it: `update-server.ps1 -KeyFromMyLogin` stores the key root-only in `/etc/resist/backend.env`, and `run-grid.ps1` passes it to the grid over SSH stdin. Keys are never printed or committed |

## Inversion server

```powershell
./infra/vm/open-port.ps1 -AddMyIp     # teammates: allow your IP on TCP 8000 (no args: list allowed IPs)
./infra/vm/update-server.ps1          # after each merge: bundle HEAD -> /opt/resist, pip install,
                                      # systemctl restart resist-backend, wait for /health
curl http://<vm-ip>:8000/health       # {"status":"ok","cosmos":"ok","inversion_workers":62,...}
```

The service runs `python -m backend.app` with `RESIST_BACKEND_HOST=0.0.0.0`, `RESIST_BACKEND_PORT=8000`, and
`RESIST_INVERSION_WORKERS = nproc - 2` (`infra/vm/resist-backend.service`), with `Restart=always`, enabled at boot. CORS only
restricts browsers; backend-to-backend calls send no `Origin` and are not blocked. Only committed code is deployed.
`update-server.ps1` refuses to run while a grid is running (it would swap the code under it; `-Force` overrides).
Logs: `ssh … sudo journalctl -u resist-backend -f`.

## Grids

```powershell
./infra/vm/create-vm.ps1              # idempotent; -AddMyIp adds your current IP to the SSH rule
./infra/vm/deploy.ps1                 # code + venv + service unit, without restarting the server
./infra/vm/run-grid.ps1 infra/vm/grids/demo.json      # nohup on the VM; Ctrl+C after the log tail is safe
./infra/vm/run-grid.ps1 -Status       # running processes + tail of logs/grid.log
./infra/vm/fetch-results.ps1          # VM snapshot -> data/graph/inversions.json (review, then commit)
```

Grid spec: see `backend/inversion/run_grid.py`. `curves: "qc"` uses each run's QC auto-picks; `intervals: "auto"`
tiles the covered depth range in `auto_length_ft` windows; list-valued `layers` / `step_ft` / `quick` expand to a
product. Points already in the store (same fingerprint as `POST /inversion/jobs`) are skipped; `--dry-run` lists them.

Parallelism: one job only parallelises the n_earth + 1 forward models of a Jacobian, so more than about 10 workers per job
sit idle. `--parallel auto` (default) runs several jobs at once with `RESIST_INVERSION_WORKERS = (nproc - 2) / parallel`;
`--parallel 1` runs one job at a time on nproc - 2 workers.

## Stop / delete

```powershell
az vm deallocate -g resist-hackathon-rg -n resist-grid-vm     # stop compute billing (disk still billed)
az vm start      -g resist-hackathon-rg -n resist-grid-vm     # public IP is static; the service starts on boot
# delete everything the scripts created (Cosmos untouched):
$disk = az vm show -g resist-hackathon-rg -n resist-grid-vm --query storageProfile.osDisk.managedDisk.id -o tsv
az vm delete -g resist-hackathon-rg -n resist-grid-vm --yes
az disk delete --ids $disk --yes
az network nic delete       -g resist-hackathon-rg -n resist-grid-vmVMNic
az network public-ip delete -g resist-hackathon-rg -n resist-grid-vmPublicIP
az network vnet delete      -g resist-hackathon-rg -n resist-grid-vmVNET
az network nsg delete       -g resist-hackathon-rg -n resist-grid-vm-nsg
```
