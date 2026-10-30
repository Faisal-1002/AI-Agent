# Ai-Agent speech-to-text: Qwen3-ASR on the CPU.
FROM python:3.12-slim

# ffmpeg decodes whatever the browser records (webm/opus, ogg, mp4, wav).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg sox libsndfile1 \
 && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch first (~200 MB instead of the ~2 GB CUDA build),
# so qwen-asr's dependencies find torch already installed.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir qwen-asr==0.0.6 fastapi uvicorn python-multipart

# Model weights are downloaded on first start into HF_HOME — mount a volume there to keep them.
ENV HF_HOME=/models PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 1000 app && mkdir -p /models && chown app:app /models
USER app
WORKDIR /srv
COPY lazy_model.py asr/server.py ./

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
