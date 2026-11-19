# GPU inversion worker on Azure

The worker is the normal backend (`backend.app`) in a container with `RESIST_COMPUTE=jax` on an NVIDIA GPU. The
local backend forwards inversion jobs to it when `RESIST_WORKER_URL` is set (`backend/inversion/remote.py`); the
frontend is unchanged. On a GPU all slices of an interval are solved together through the lockstep batcher
(`backend/inversion/lockstep.py`).

Untested end to end so far: the laptop has no Docker, `az` CLI or WSL2. Replace the `<...>` values.

## 1. Build and push the image

Needs Docker; the build context is the repository root (`.dockerignore` keeps only `backend/`).

```bash
az login
az acr create -g <rg> -n <acr> --sku Basic
az acr build -r <acr> -t resist-gpu-worker:latest -f deploy/gpu-worker/Dockerfile .   # builds in Azure, no local Docker
```

## 2. Data in Blob storage

```bash
az storage account create -g <rg> -n <storage> --sku Standard_LRS
az storage container create --account-name <storage> -n dlis
az storage blob upload-batch --account-name <storage> -d dlis -s data --pattern "*.dlis"
```

## 3. GPU VM

Cheapest useful SKUs: `Standard_NC4as_T4_v3` (T4 16 GB) or `Standard_NV6ads_A10_v5` (A10 slice). Both are weak in
FP64, so also benchmark `RESIST_PRECISION=32` (passes the FP32 gate for phase and geosignals; attenuation
resistivity above ~30 ohm-m can shift ~1%).

```bash
az vm create -g <rg> -n resist-gpu --size Standard_NC4as_T4_v3 \
  --image microsoft-dsvm:ubuntu-hpc:2204:latest --admin-username azureuser --generate-ssh-keys \
  --nsg-rule SSH                      # only SSH is open; the API is reached through a tunnel
az vm auto-shutdown -g <rg> -n resist-gpu --time 1900   # UTC, daily
```

The `ubuntu-hpc` image has the NVIDIA driver and container toolkit; on a plain Ubuntu image install them first.
On the VM:

```bash
# Mount the DLIS container read-only at /mnt/dlis with blobfuse2 (https://learn.microsoft.com/azure/storage/blobs/blobfuse2-how-to-deploy)
sudo blobfuse2 mount /mnt/dlis --config-file=blobfuse2.yaml --read-only
az acr login -n <acr>
docker run -d --gpus all --restart unless-stopped -p 127.0.0.1:5000:5000 \
  -v /mnt/dlis:/data:ro -v resist-jax-cache:/cache \
  -e RESIST_PRECISION=64 <acr>.azurecr.io/resist-gpu-worker:latest
curl -s "localhost:5000/inversion/defaults?run=2_4-Z-20_18840-23791ft_RES_GEOSIGNAL" | grep -o '"device":"[^"]*"'
# expect "gpu: ... (JAX, FP64)"
```

## 4. Use it from the laptop

```powershell
ssh -N -L 5001:localhost:5000 azureuser@<vm-ip>        # keep open
$env:RESIST_WORKER_URL = "http://localhost:5001"
python -m backend.app                                    # local backend now forwards inversion jobs
```

The Inversion tab's settings card shows the worker's device. Plans, QC and data views stay local; jobs, job status,
the finished-job list and the 3D layer geometry come from the worker. 3D facet jobs (`/inversion3d`) stay local.

## 5. Benchmark and stop

```bash
docker exec <container> python -m backend.inversion.benchmark --md-max 20700        # 400 ft
docker exec -e RESIST_PRECISION=32 <container> python -m backend.inversion.benchmark --md-max 20700
az vm deallocate -g <rg> -n resist-gpu                                              # stop paying for the GPU
```

Tuning: `RESIST_BATCH` (max problems per compiled call, default 64 on GPU). The first run per shape compiles for
about a minute; compiled kernels persist in the `resist-jax-cache` volume.
