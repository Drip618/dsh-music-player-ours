#!/usr/bin/env python3
"""下载 Kokoro 中文 TTS 模型到 ~/.dsh/music-tts-models/kokoro-int8-multi-lang-v1_1/。
可断点续传；自动探测 Clash 代理（7897/7890），开了就走快线，否则直连 hf-mirror。
用法：python3 download-model.py [模型名]  默认 kokoro-int8-multi-lang-v1_1
"""
import json, os, sys, time, urllib.request, urllib.parse, socket

MODEL = sys.argv[1] if len(sys.argv) > 1 else "kokoro-int8-multi-lang-v1_1"
REPO = f"csukuangfj/{MODEL}"
DEST = os.path.expanduser(f"~/.dsh/music-tts-models/{MODEL}")
MIRROR = "https://hf-mirror.com"

def proxy_opener():
    for port in (7897, 7890):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1.5); s.close()
            print(f"[proxy] 走 Clash 127.0.0.1:{port}（直连 HF 满速）", flush=True)
            op = urllib.request.build_opener(urllib.request.ProxyHandler({
                "http": f"http://127.0.0.1:{port}", "https": f"http://127.0.0.1:{port}"}))
            return op, True
        except OSError:
            continue
    print("[proxy] 未开代理，直连 hf-mirror（较慢）", flush=True)
    return urllib.request.build_opener(urllib.request.ProxyHandler({})), False

def main():
    os.makedirs(DEST, exist_ok=True)
    opener, proxied = proxy_opener()
    # 有代理直连 HF；无代理时 API 仍走 HF（镜像不代理 API），文件走 hf-mirror
    file_base = "https://huggingface.co" if proxied else MIRROR
    with opener.open(f"https://huggingface.co/api/models/{REPO}/tree/main?recursive=1", timeout=40) as r:
        tree = json.load(r)
    files = [x for x in tree if x.get("type") == "file"]
    total = sum(x.get("size", 0) for x in files)
    print(f"[plan] {len(files)} 个文件，共 {total/1e6:.1f} MB → {DEST}", flush=True)
    done_bytes = 0
    for i, x in enumerate(files):
        rel = x["path"]; size = x.get("size", 0)
        out = os.path.join(DEST, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if os.path.exists(out) and os.path.getsize(out) == size:
            done_bytes += size; continue
        url = f"{file_base}/{REPO}/resolve/main/{urllib.parse.quote(rel, safe='/')}"
        for attempt in range(5):
            try:
                req = urllib.request.Request(url)
                start = 0
                tmp = out + ".part"
                if os.path.exists(tmp):
                    start = os.path.getsize(tmp)
                    if start > 0: req.add_header("Range", f"bytes={start}-")
                with opener.open(req, timeout=60) as r, open(tmp, "ab" if start else "wb") as f:
                    while True:
                        chunk = r.read(1 << 16)
                        if not chunk: break
                        f.write(chunk)
                if os.path.getsize(tmp) == size or size == 0:
                    os.replace(tmp, out); done_bytes += size
                    print(f"[{i+1}/{len(files)}] {rel} ({size/1e6:.2f}MB) ok", flush=True)
                    break
                else:
                    print(f"[retry] {rel} 尺寸不符 {os.path.getsize(tmp)}/{size}", flush=True)
            except Exception as e:
                print(f"[retry {attempt+1}] {rel}: {e}", flush=True)
                time.sleep(2 * (attempt + 1))
        else:
            print(f"[FAIL] {rel} 放弃", flush=True)
    print(f"[done] {done_bytes/1e6:.1f} MB 落盘 → {DEST}", flush=True)

if __name__ == "__main__":
    main()