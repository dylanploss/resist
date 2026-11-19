# Resist GPU inversion worker: the normal backend API with JAX on an NVIDIA GPU.
# Build from the repository root:  docker build -f deploy/gpu-worker/Dockerfile -t resist-gpu-worker .
# The jax[cuda12] wheels bundle CUDA and cuDNN; the host only needs the NVIDIA driver and container toolkit.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    RESIST_COMPUTE=jax \
    RESIST_JAX_CACHE=/cache/jax \
    DATA_DIR=/data

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt \
    && pip install "jax[cuda12]"

COPY backend backend

# /data: DLIS files (Blob container mounted with blobfuse2); /cache: compiled XLA kernels, keep across restarts
VOLUME ["/data", "/cache"]
EXPOSE 5000
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "5000"]
