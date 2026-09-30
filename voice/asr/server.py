"""Speech-to-text service: Qwen3-ASR behind an OpenAI-compatible API.

POST /v1/audio/transcriptions   (multipart: file=<audio>)  ->  {"text": ..., "language": ...}
GET  /health
"""

import os
import subprocess
import threading

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from qwen_asr import Qwen3ASRModel

MODEL_ID = os.environ.get("ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
SAMPLE_RATE = 16_000

torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "8")))

# Loaded once at startup (downloaded from Hugging Face on first run, then cached in HF_HOME).
# CPU + float32: this container leaves the GPU to the chat model.
model = Qwen3ASRModel.from_pretrained(
    MODEL_ID,
    dtype=torch.float32,
    device_map="cpu",
    max_inference_batch_size=1,
    max_new_tokens=512,
)
lock = threading.Lock()  # one transcription at a time; the model isn't built for concurrent calls

app = FastAPI(title="seyl-ai ASR")


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
    with lock:
        return model.transcribe(audio=(samples, SAMPLE_RATE), language=None)[0]


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID}


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...)):
    samples = decode(await file.read())
    if samples.size < SAMPLE_RATE // 4:
        return {"text": "", "language": None}  # under a quarter second: nothing to transcribe
    result = await run_in_threadpool(transcribe, samples)
    return {"text": result.text.strip(), "language": result.language}
