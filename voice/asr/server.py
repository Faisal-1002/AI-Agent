"""Speech-to-text service: Qwen3-ASR behind an OpenAI-compatible API.

POST /v1/audio/transcriptions   (multipart: file=<audio>)  ->  {"text": ..., "language": ...}
GET  /health
"""

import os
import subprocess

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from qwen_asr import Qwen3ASRModel

from lazy_model import LazyModel

MODEL_ID = os.environ.get("ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
SAMPLE_RATE = 16_000

torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "8")))

# Loaded on first use, unloaded after UNLOAD_AFTER_SECONDS idle (0 = keep it) — see lazy_model.py.
# Downloaded from Hugging Face the first time, then cached in HF_HOME.
# CPU + float32: this container leaves the GPU to the chat model.
model = LazyModel(
    lambda: Qwen3ASRModel.from_pretrained(
        MODEL_ID,
        dtype=torch.float32,
        device_map="cpu",
        max_inference_batch_size=1,
        max_new_tokens=512,
    ),
    idle_seconds=float(os.environ.get("UNLOAD_AFTER_SECONDS", "900")),
)

app = FastAPI(title="Ai-Agent ASR")


def decode(audio: bytes) -> np.ndarray:
    """Any format the browser records (webm/opus, ogg, wav, mp4) -> 16 kHz mono float32, via ffmpeg."""
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0",
         "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "pipe:1"],
        input=audio,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise HTTPException(400, f"Could not decode audio: {result.stderr.decode()[:200]}")
    return np.frombuffer(result.stdout, dtype=np.float32)


def transcribe(samples: np.ndarray):
    return model.run(lambda m: m.transcribe(audio=(samples, SAMPLE_RATE), language=None)[0])


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "loaded": model.loaded}


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...)):
    samples = decode(await file.read())
    if samples.size < SAMPLE_RATE // 4:
        return {"text": "", "language": None}  # under a quarter second: nothing to transcribe
    result = await run_in_threadpool(transcribe, samples)
    return {"text": result.text.strip(), "language": result.language}
