"""Voice transcription via faster-whisper (CPU-friendly).

Carrega o modelo lazily na primeira chamada (model="base" por padrão, ~140MB).
Override via JARVIS_WHISPER_MODEL=small|medium|large-v3 etc.
"""
import asyncio
import os
import tempfile
from pathlib import Path

_MODEL = None
_MODEL_NAME = os.environ.get("JARVIS_WHISPER_MODEL", "base")
_LOAD_LOCK = asyncio.Lock()


async def _ensure_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    async with _LOAD_LOCK:
        if _MODEL is not None:
            return _MODEL
        from faster_whisper import WhisperModel
        # CPU mode com int8 quantization é leve e razoavelmente rápido
        loop = asyncio.get_running_loop()
        _MODEL = await loop.run_in_executor(
            None,
            lambda: WhisperModel(_MODEL_NAME, device="cpu", compute_type="int8"),
        )
        print(f"[voice] model loaded: {_MODEL_NAME}", flush=True)
        return _MODEL


async def transcribe(audio_bytes: bytes, language: str = "pt") -> dict:
    """Transcribe audio bytes (any format ffmpeg can read) to text."""
    if not audio_bytes:
        return {"ok": False, "error": "audio vazio"}
    model = await _ensure_model()
    # Salva em arquivo temp pra faster-whisper ler (suporta webm/opus/mp3/wav)
    suffix = ".webm"  # MediaRecorder default no Chrome
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        path = f.name
    try:
        loop = asyncio.get_running_loop()
        def _run():
            segments, info = model.transcribe(path, language=language, vad_filter=True)
            text = " ".join(s.text.strip() for s in segments).strip()
            return {
                "text": text,
                "language": info.language,
                "languageProbability": round(info.language_probability, 2),
                "duration": round(info.duration, 2),
            }
        result = await loop.run_in_executor(None, _run)
        return {"ok": True, **result}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


def is_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False
