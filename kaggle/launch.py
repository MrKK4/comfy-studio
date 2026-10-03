"""Kaggle launcher: ComfyUI + Comfy Studio + node packs + cloudflared tunnel.

Notebook cell:

    !git clone -q https://github.com/MrKK4/comfy-studio /kaggle/temp/comfy-studio || git -C /kaggle/temp/comfy-studio pull -q
    %run /kaggle/temp/comfy-studio/kaggle/launch.py

Re-running the cell restarts ComfyUI and keeps downloads. Knobs are the env vars below.
"""
import os
import pathlib
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.request

TEMP = pathlib.Path(os.environ.get("STUDIO_TEMP", "/kaggle/temp"))
WORK = pathlib.Path(os.environ.get("STUDIO_WORK", "/kaggle/working"))
COMFY = TEMP / "ComfyUI"
STUDIO = pathlib.Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("STUDIO_PORT", "8188"))
COMFY_REF = os.environ.get("COMFY_REF", "")  # pin a ComfyUI commit/tag; empty = latest
INSTALL_AUK = os.environ.get("INSTALL_AUK", "1") == "1"
EXTRA_ARGS = os.environ.get("COMFY_ARGS", "").split()


def sh(cmd, **kw):
    print("$", cmd if isinstance(cmd, str) else " ".join(map(str, cmd)))
    subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kw)


def secret(name):
    if os.environ.get(name):
        return os.environ[name]
    try:
        from kaggle_secrets import UserSecretsClient
        return UserSecretsClient().get_secret(name)
    except Exception:
        return ""


def clone(url, dest, ref=""):
    if (dest / ".git").exists():
        sh(["git", "-C", dest, "pull", "-q", "--ff-only"])
    else:
        sh(["git", "clone", "-q", *([] if ref else ["--depth", "1"]), url, dest])
    if ref:
        sh(["git", "-C", dest, "checkout", "-q", ref])


def pip_req(path):
    if path.exists():
        sh([sys.executable, "-m", "pip", "install", "-q", "-r", path])


# 1. ComfyUI
clone("https://github.com/comfyanonymous/ComfyUI", COMFY, COMFY_REF)
pip_req(COMFY / "requirements.txt")

# 2. Studio + node packs the library's workflows use
nodes = COMFY / "custom_nodes"
link = nodes / "comfy-studio"
if not link.exists():
    link.symlink_to(STUDIO, target_is_directory=True)
for line in (STUDIO / "kaggle" / "nodes.txt").read_text().splitlines():
    url = line.split("#")[0].strip()
    if url:
        dest = nodes / url.rstrip("/").split("/")[-1].removesuffix(".git")
        clone(url, dest)
        pip_req(dest / "requirements.txt")

# 3. Tencent AuK (its own pip package + node)
env = dict(os.environ)
if INSTALL_AUK:
    auk = TEMP / "AuK"
    clone("https://github.com/Tencent-Hunyuan/AuK", auk)
    # --no-deps: AuK pins torch<2.8, which would downgrade Kaggle's torch and break ComfyUI.
    # These are its runtime deps minus the torch family and the optional ASR/prompt-enhancer stack.
    sh([sys.executable, "-m", "pip", "install", "-q", "--no-deps", "-e", auk])
    sh([sys.executable, "-m", "pip", "install", "-q", "transformers>=4.52,<5", "qwen-omni-utils",
        "omegaconf", "torchdiffeq", "x_transformers>=1.31.14", "accelerate>=0.33", "pyloudnorm", "PyYAML"])
    if not (nodes / "ComfyUI-AuK").exists():
        (nodes / "ComfyUI-AuK").symlink_to(auk / "comfyui" / "ComfyUI-AuK", target_is_directory=True)
    env["AUK_HOME"] = str(auk)

# 4. Environment for the studio
token = os.environ.get("STUDIO_TOKEN") or secrets.token_urlsafe(18)
env.update(
    STUDIO_TOKEN=token,
    STUDIO_MODEL_ROOT=str(TEMP / "models"),
    STUDIO_USER_DIR=str(WORK / "studio"),  # layouts, added workflows, settings survive "Save Version"
    HF_TOKEN=secret("HF_TOKEN"),
    CIVITAI_TOKEN=secret("CIVITAI_TOKEN"),
    PYTHONUNBUFFERED="1",
)
(WORK / "outputs").mkdir(parents=True, exist_ok=True)

# 5. (Re)start ComfyUI
subprocess.run(["pkill", "-f", f"main.py.*--port {PORT}"])
subprocess.run(["pkill", "-f", "cloudflared tunnel"])
log = open(TEMP / "comfyui.log", "w")
comfy = subprocess.Popen(
    [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(PORT),
     "--output-directory", str(WORK / "outputs"), "--disable-auto-launch", *EXTRA_ARGS],
    cwd=COMFY, env=env, stdout=log, stderr=subprocess.STDOUT)
print(f"ComfyUI starting (log: {TEMP / 'comfyui.log'})", end="", flush=True)
for _ in range(600):
    if comfy.poll() is not None:
        print("\n" + (TEMP / "comfyui.log").read_text()[-4000:])
        raise SystemExit("ComfyUI exited during startup — see the log above")
    try:
        urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/system_stats", headers={"X-Studio-Token": token}), timeout=2)
        break
    except Exception:
        print(".", end="", flush=True)
        time.sleep(2)
print(" up")

# 6. Tunnel
cf = TEMP / "cloudflared"
if not cf.exists():
    urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", cf)
    cf.chmod(0o755)
tunnel = subprocess.Popen([cf, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for line in tunnel.stdout:
    m = re.search(r"https://[\w-]+\.trycloudflare\.com", line)
    if m:
        print(f"\nComfy Studio:  {m.group(0)}/studio/?token={token}")
        print(f"ComfyUI graph: {m.group(0)}/?token={token}")
        print("Keep this link private — anyone with it can run code on this machine.")
        break
# keep draining cloudflared's output, or its pipe fills up and the tunnel stalls
threading.Thread(target=lambda: [None for _ in tunnel.stdout], daemon=True).start()
