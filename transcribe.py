#!/usr/bin/env python3
"""Transcribe audio. Priority: Groq API (fastest) > mlx-whisper > faster-whisper."""
import sys, os, json, subprocess, tempfile, math

audio_path = sys.argv[1]
output_path = sys.argv[2] if len(sys.argv) > 2 else None

GROQ_KEY = os.environ.get("GROQ_API_KEY", "")

def progress(step, message, pct=None):
    d = {"step": step, "message": message}
    if pct is not None: d["progress"] = pct
    print(json.dumps(d, ensure_ascii=False), flush=True)

def compress_audio(input_path, max_mb=24):
    """Compress audio to mono 16kbps to fit Groq's 25MB limit."""
    size_mb = os.path.getsize(input_path) / (1024 * 1024)
    if size_mb <= max_mb:
        return input_path
    progress("compressing", f"压缩音频 ({size_mb:.0f}MB → <{max_mb}MB)...")
    out = tempfile.mktemp(suffix=".mp3")
    subprocess.run([
        "ffmpeg", "-i", input_path, "-ac", "1", "-ar", "16000",
        "-b:a", "16k", "-y", out
    ], capture_output=True)
    return out

def split_audio(input_path, chunk_minutes=20):
    """Split audio into chunks for Groq's 25MB limit."""
    # Get duration
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", input_path],
        capture_output=True, text=True
    )
    duration = float(r.stdout.strip() or "0")
    if duration == 0:
        return [input_path]

    chunks = []
    n = math.ceil(duration / (chunk_minutes * 60))
    if n <= 1:
        return [input_path]

    progress("splitting", f"分割为 {n} 段...")
    for i in range(n):
        start = i * chunk_minutes * 60
        out = tempfile.mktemp(suffix=f"_chunk{i}.mp3")
        subprocess.run([
            "ffmpeg", "-i", input_path, "-ss", str(start),
            "-t", str(chunk_minutes * 60), "-ac", "1", "-ar", "16000",
            "-b:a", "24k", "-y", out
        ], capture_output=True)
        chunks.append(out)
    return chunks

def try_groq(audio_path):
    from groq import Groq
    client = Groq(api_key=GROQ_KEY)

    # Compress or split
    compressed = compress_audio(audio_path)
    size_mb = os.path.getsize(compressed) / (1024 * 1024)

    if size_mb > 24:
        # Need to split
        chunks = split_audio(audio_path)
        all_text = []
        for i, chunk in enumerate(chunks):
            progress("transcribing", f"Groq 转录第 {i+1}/{len(chunks)} 段...", int((i / len(chunks)) * 90))
            with open(chunk, "rb") as f:
                result = client.audio.transcriptions.create(
                    file=(os.path.basename(chunk), f.read()),
                    model="whisper-large-v3",
                    language="zh",
                    response_format="text",
                )
            all_text.append(result)
            if chunk != audio_path:
                os.unlink(chunk)
        return "\n".join(all_text)
    else:
        progress("transcribing", "Groq Whisper 极速转录中...")
        with open(compressed, "rb") as f:
            result = client.audio.transcriptions.create(
                file=(os.path.basename(compressed), f.read()),
                model="whisper-large-v3",
                language="zh",
                response_format="text",
            )
        if compressed != audio_path:
            os.unlink(compressed)
        return result

def try_mlx_whisper(audio_path):
    import mlx_whisper
    progress("loading", "加载 mlx-whisper（Apple Silicon）...")
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo="mlx-community/whisper-small-mlx",
        language="zh",
        verbose=False,
    )
    return result["text"]

def try_faster_whisper(audio_path):
    from faster_whisper import WhisperModel
    progress("loading", "加载 faster-whisper...")
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, language="zh", beam_size=1, vad_filter=True)
    text = ""
    for seg in segments:
        text += seg.text + "\n"
        if info.duration > 0:
            pct = min(99, int((seg.end / info.duration) * 100))
            progress("transcribing", f"转录中... {pct}%", pct)
    return text

# Try engines in priority order
engines = []
if GROQ_KEY:
    engines.append(("Groq API", try_groq))
engines += [("mlx-whisper", try_mlx_whisper), ("faster-whisper", try_faster_whisper)]

text = None
for name, fn in engines:
    try:
        progress("loading", f"使用 {name}...")
        text = fn(audio_path)
        progress("done", f"{name} 转录完成", 100)
        break
    except ImportError:
        continue
    except Exception as e:
        progress("warning", f"{name} 失败: {str(e)[:200]}，尝试下一个...")
        continue

if text is None:
    progress("error", "所有转录引擎都不可用")
    sys.exit(1)

if output_path:
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(text)

print("===TRANSCRIPT_START===", flush=True)
print(text, flush=True)
print("===TRANSCRIPT_END===", flush=True)
