"""Load a model on first use; unload it after it sits idle — the idea behind Ollama's keep_alive.

Each voice model takes ~4 GB of RAM on the CPU, and most of the time nobody is speaking.
Loading from the local cache takes a few seconds, paid by the first request after a break.
"""

import ctypes
import gc
import threading
import time
from typing import Callable, Generic, TypeVar

M = TypeVar("M")
R = TypeVar("R")


class LazyModel(Generic[M]):
    def __init__(self, load: Callable[[], M], idle_seconds: float):
        self._load = load
        self._idle = idle_seconds
        self._model: M | None = None
        # One job at a time (these models aren't built for concurrent calls). The same lock
        # guarantees a model is never unloaded in the middle of a job.
        self._lock = threading.Lock()
        self._last_used = time.monotonic()
        if idle_seconds > 0:
            threading.Thread(target=self._unload_when_idle, daemon=True).start()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def run(self, job: Callable[[M], R]) -> R:
        with self._lock:
            if self._model is None:
                started = time.monotonic()
                self._model = self._load()
                print(f"model loaded in {time.monotonic() - started:.1f}s", flush=True)
            try:
                return job(self._model)
            finally:
                self._last_used = time.monotonic()

    def _unload_when_idle(self):
        while True:
            time.sleep(30)
            if self._model is None or time.monotonic() - self._last_used < self._idle:
                continue
            with self._lock:
                if self._model is None or time.monotonic() - self._last_used < self._idle:
                    continue
                self._model = None
            gc.collect()
            # Python keeps freed memory for reuse; ask the C allocator to give it back to the OS.
            try:
                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except OSError:
                pass
            print(f"model unloaded after {self._idle:.0f}s idle", flush=True)
