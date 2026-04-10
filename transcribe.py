#!/usr/bin/env python3
"""Robust podcast transcription. Handles files of any size via Groq API with auto-splitting."""
import sys, os, json, subprocess, tempfile, math, time

audio_path = sys.argv[1]
output_path = sys.argv[2] if len(sys.argv) > 2 else None

GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
# Groq limit is 25MB. We target 20MB chunks for safety.
MAX_CHUNK_MB = 20

def log(step, message, pct=None):
    d = {"step": step, "message": message}
    if pct is not None: d["progress"] = pct
    print(json.dumps(d, ensure_ascii=False), flush=True)

def get_duration(path):
    """Get audio duration in seconds."""
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True
    )
    try:
        return float(r.stdout.strip())
    except:
        return 0

def compress_chunk(input_path, start_sec, duration_sec, output_path):
    """Extract and compress a chunk to mono 16kHz 24kbps MP3."""
    cmd = ["ffmpeg", "-i", input_path, "-ss", str(start_sec), "-t", str(duration_sec),
           "-ac", "1", "-ar", "16000", "-b:a", "24k", "-y", output_path]
    subprocess.run(cmd, capture_output=True)
    return os.path.exists(output_path) and os.path.getsize(output_path) > 0

def transcribe_with_groq(audio_path):
    """Transcribe using Groq API, auto-splitting long files."""
    from groq import Groq
    client = Groq(api_key=GROQ_KEY)

    duration = get_duration(audio_path)
    if duration == 0:
        raise Exception("Cannot read audio duration")

    log("preparing", f"音频时长: {int(duration//60)} 分 {int(duration%60)} 秒")

    # Calculate chunk duration: 24kbps mono = ~180KB/min, target 20MB = ~111 min per chunk
    # But be conservative: 20 min chunks for reliability
    chunk_minutes = 20
    n_chunks = max(1, math.ceil(duration / (chunk_minutes * 60)))

    log("preparing", f"分割为 {n_chunks} 段进行转录...")

    all_text = []
    tmp_dir = tempfile.mkdtemp()

    for i in range(n_chunks):
        start = i * chunk_minutes * 60
        chunk_dur = min(chunk_minutes * 60, duration - start)
        if chunk_dur <= 0:
            break

        chunk_path = os.path.join(tmp_dir, f"chunk_{i:03d}.mp3")
        pct = int((i / n_chunks) * 90)
        log("transcribing", f"Groq 转录第 {i+1}/{n_chunks} 段...", pct)

        # Compress chunk
        if not compress_chunk(audio_path, start, chunk_dur, chunk_path):
            log("warning", f"第 {i+1} 段压缩失败，跳过")
            continue

        chunk_size_mb = os.path.getsize(chunk_path) / (1024 * 1024)
        if chunk_size_mb > 24:
            # Re-compress with lower bitrate
            chunk_path2 = os.path.join(tmp_dir, f"chunk_{i:03d}_small.mp3")
            subprocess.run(["ffmpeg", "-i", chunk_path, "-ac", "1", "-ar", "16000", "-b:a", "16k", "-y", chunk_path2], capture_output=True)
            os.unlink(chunk_path)
            chunk_path = chunk_path2

        # Transcribe with retry
        max_retries = 3
        for attempt in range(max_retries):
            try:
                with open(chunk_path, "rb") as f:
                    result = client.audio.transcriptions.create(
                        file=(os.path.basename(chunk_path), f.read()),
                        model="whisper-large-v3",
                        language="zh",
                        response_format="text",
                    )
                all_text.append(result if isinstance(result, str) else str(result))
                break
            except Exception as e:
                err_msg = str(e)
                if attempt < max_retries - 1:
                    log("warning", f"第 {i+1} 段第 {attempt+1} 次失败，重试... ({err_msg[:80]})")
                    time.sleep(2 * (attempt + 1))
                else:
                    log("warning", f"第 {i+1} 段转录失败: {err_msg[:100]}")

        # Cleanup chunk
        try: os.unlink(chunk_path)
        except: pass

    # Cleanup tmp dir
    try:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
    except: pass

    if not all_text:
        raise Exception("所有分段转录均失败")

    return "\n".join(all_text)

def transcribe_with_mlx(audio_path):
    """Fallback: local mlx-whisper for Apple Silicon."""
    import mlx_whisper
    log("loading", "加载 mlx-whisper（Apple Silicon）...")
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo="mlx-community/whisper-small-mlx",
        language="zh",
        verbose=False,
    )
    return result["text"]

def transcribe_with_faster(audio_path):
    """Fallback: local faster-whisper on CPU."""
    from faster_whisper import WhisperModel
    log("loading", "加载 faster-whisper...")
    model = WhisperModel("tiny", device="cpu", compute_type="float32")
    segments, info = model.transcribe(audio_path, language="zh", beam_size=1, vad_filter=True)
    text = ""
    for seg in segments:
        text += seg.text + "\n"
        if info.duration > 0:
            pct = min(99, int((seg.end / info.duration) * 100))
            log("transcribing", f"本地转录... {pct}%", pct)
    return text

# --- Main ---
engines = []
if GROQ_KEY:
    engines.append(("Groq API", transcribe_with_groq))
engines.append(("mlx-whisper", transcribe_with_mlx))
engines.append(("faster-whisper", transcribe_with_faster))

text = None
for name, fn in engines:
    try:
        log("loading", f"使用 {name}...")
        text = fn(audio_path)
        log("done", f"{name} 转录完成", 100)
        break
    except ImportError:
        log("warning", f"{name} 未安装，跳过")
        continue
    except Exception as e:
        log("warning", f"{name} 失败: {str(e)[:200]}，尝试下一个引擎...")
        continue

if text is None:
    log("error", "所有转录引擎都失败了")
    sys.exit(1)

if output_path:
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(text)

print("===TRANSCRIPT_START===", flush=True)
print(text, flush=True)
print("===TRANSCRIPT_END===", flush=True)
