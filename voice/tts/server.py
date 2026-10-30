"""Text-to-speech service: Qwen3-TTS behind an OpenAI-compatible API.

POST /v1/audio/speech   {"input": "...", "voice": "Aiden", "instructions": "", "language": "Auto"}  ->  audio/wav
GET  /v1/voices
GET  /health
"""

import io
import os

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from qwen_tts import Qwen3TTSModel

from lazy_model import LazyModel

MODEL_ID = os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "1000"))

# The built-in voices of the CustomVoice models (name -> description).
VOICES = {
    "Aiden": "Sunny American male (English)",
    "Ryan": "Dynamic, rhythmic male (English)",
    "Vivian": "Bright young female (Chinese)",
    "Serena": "Warm, gentle young female (Chinese)",
    "Uncle_Fu": "Low, mellow male (Chinese)",
    "Dylan": "Beijing male (Chinese)",
    "Eric": "Chengdu male (Chinese)",
    "Ono_Anna": "Playful female (Japanese)",
    "Sohee": "Warm female (Korean)",
}

# Measured on an i7-14700K: 4 threads ≈ 12 threads, 20 is 2x slower. TTS generates audio
# step by step, so it is limited by per-step latency, not by the number of cores.
torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "4")))

# Loaded on first use, unloaded after UNLOAD_AFTER_SECONDS idle (0 = keep it) — see lazy_model.py.
# CPU + float32: this container leaves the GPU to the chat model.
model = LazyModel(
    lambda: Qwen3TTSModel.from_pretrained(MODEL_ID, device_map="cpu", dtype=torch.float32),
    idle_seconds=float(os.environ.get("UNLOAD_AFTER_SECONDS", "900")),
)

app = FastAPI(title="Ai-Agent TTS")


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1)
    voice: str = "Aiden"
    instructions: str = ""  # e.g. "Speak calmly." — Qwen3-TTS follows style instructions
    language: str = "Auto"


def max_frames(text: str) -> int:
    """Cap generation to ~2x the expected speech length.

    The model emits 12 audio frames per second and speech is ~15 characters per second.
    The default cap (2048 frames ≈ 170 s) let a run-away generation grow memory until
    Kubernetes OOM-killed the pod.
    """
    return min(2048, 60 + int(len(text) * 1.6))


def synthesize(req: SpeechRequest) -> bytes:
    text = req.input[:MAX_CHARS]
    wavs, sample_rate = model.run(
        lambda m: m.generate_custom_voice(
            text=text,
            language=req.language,
            speaker=req.voice,
            instruct=req.instructions,
            max_new_tokens=max_frames(text),
        )
    )
    buffer = io.BytesIO()
    sf.write(buffer, wavs[0], sample_rate, format="WAV")
    return buffer.getvalue()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "loaded": model.loaded}


@app.get("/v1/voices")
def voices():
    return [{"id": name, "description": description} for name, description in VOICES.items()]


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if req.voice not in VOICES:
        raise HTTPException(400, f"Unknown voice '{req.voice}'. Try one of: {', '.join(VOICES)}")
    audio = await run_in_threadpool(synthesize, req)
    return Response(audio, media_type="audio/wav")
