# seyl-ai text-to-speech: Qwen3-TTS on the CPU.
# Separate from the ASR image on purpose: qwen-tts and qwen-asr pin different
# transformers versions, so they can't share one Python environment.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends sox libsndfile1 \
 && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch + torchaudio (matching versions) before qwen-tts.
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir qwen-tts==0.1.1 fastapi uvicorn

ENV HF_HOME=/models PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 1000 app && mkdir -p /models && chown app:app /models
USER app
WORKDIR /srv
COPY server.py .

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
