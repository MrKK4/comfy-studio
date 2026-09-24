"""Comfy Studio: a custom UI served by ComfyUI itself (one process, one port).

Routes live under /studio. The UI talks to ComfyUI's own API (/prompt, /ws, /object_info ...)
for everything else, so this file only adds what ComfyUI lacks: a workflow library,
missing-model scan, a downloader, settings and optional token auth.
"""
import hmac
import json
import os
import pathlib
import re
import threading
import time
import urllib.parse
import urllib.request
import uuid

from aiohttp import web

import folder_paths
from server import PromptServer

ROOT = pathlib.Path(__file__).parent
WEB = ROOT / "web"
BUILTIN = ROOT / "library"
USER = pathlib.Path(os.environ.get("STUDIO_USER_DIR") or ROOT / "user")
USER_LIB = USER / "library"
SETTINGS_FILE = USER / "settings.json"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = None


# ---------- settings ----------

def load_settings():
    s = {"model_root": os.environ.get("STUDIO_MODEL_ROOT", ""), "hf_token": "", "civitai_token": ""}
    if SETTINGS_FILE.exists():
        s.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    s["hf_token"] = s["hf_token"] or os.environ.get("HF_TOKEN", "")
    s["civitai_token"] = s["civitai_token"] or os.environ.get("CIVITAI_TOKEN", "")
    return s


def save_settings(s):
    USER.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(s, indent=2), encoding="utf-8")


def model_folders():
    return sorted(k for k in folder_paths.folder_names_and_paths if k != "custom_nodes")


def apply_model_root(root):
    """Make ComfyUI look in <root>/<folder> first for every model folder."""
    if not root:
        return
    for name in model_folders():
        folder_paths.add_model_folder_path(name, os.path.join(root, name), is_default=True)


def target_dir(directory):
    root = load_settings()["model_root"]
    if root:
        return pathlib.Path(root) / directory
    return pathlib.Path(folder_paths.get_folder_paths(directory)[0])


# ---------- library ----------

def read_json(p):
    return json.loads(p.read_text(encoding="utf-8"))


def model_ids():
    ids = set()
    for base in (BUILTIN, USER_LIB):
        if base.exists():
            ids |= {p.parent.name for p in base.glob("*/model.json")}
    return sorted(ids)


def load_model(mid):
    """Builtin manifest merged with the user's overrides (added/hidden workflows, default)."""
    b = BUILTIN / mid / "model.json"
    u = USER_LIB / mid / "model.json"
    base = read_json(b) if b.exists() else {"workflows": []}
    user = read_json(u) if u.exists() else {}
    hidden = set(user.get("hidden", []))
    wfs = {w["id"]: {**w, "user": False} for w in base["workflows"] if w["id"] not in hidden}
    for w in user.get("workflows", []):
        wfs[w["id"]] = {**w, "user": True}
    order = [w["id"] for w in base["workflows"]] + [w["id"] for w in user.get("workflows", [])]
    out = {k: v for k, v in base.items() if k != "workflows"}
    out.update({k: v for k, v in user.items() if k not in ("workflows", "hidden")})
    out["id"] = mid
    out["workflows"] = [wfs[i] for i in dict.fromkeys(order) if i in wfs]
    if out.get("default") not in wfs:
        out["default"] = out["workflows"][0]["id"] if out["workflows"] else None
    return out


def workflow_path(mid, wid):
    for base in (USER_LIB, BUILTIN):
        p = base / mid / "workflows" / f"{wid}.json"
        if p.exists():
            return p
    return None


def edit_user_model(mid, fn):
    p = USER_LIB / mid / "model.json"
    m = read_json(p) if p.exists() else {}
    fn(m)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(m, indent=2), encoding="utf-8")


def check_id(*ids):
    for i in ids:
        if not ID_RE.match(i or ""):
            raise web.HTTPBadRequest(text=f"bad id: {i!r}")


# ---------- missing models ----------

def iter_nodes(wf):
    yield from wf.get("nodes", [])
    for sg in wf.get("definitions", {}).get("subgraphs", []):
        yield from sg.get("nodes", [])


def expand(path):
    return os.path.expandvars(path.replace("{AUK_HOME}", os.environ.get("AUK_HOME", "")))


def scan_missing(mid, wid=None):
    """Models declared in workflow node properties (+ model.json 'requires') that aren't on disk."""
    model = load_model(mid)
    found = {}
    for w in model["workflows"]:
        if wid and w["id"] != wid:
            continue
        p = workflow_path(mid, w["id"])
        if not p:
            continue
        for n in iter_nodes(read_json(p)):
            for m in (n.get("properties") or {}).get("models") or []:
                if m.get("name") and m.get("directory"):
                    found.setdefault((m["directory"], m["name"]), m.get("url", ""))
    out = []
    for (d, name), url in sorted(found.items()):
        try:
            present = folder_paths.get_full_path(d, name) is not None
        except KeyError:
            present = False
        if not present:
            out.append({"directory": d, "name": name, "url": url})
    for r in model.get("requires", []):
        path = expand(r["path"])
        if not (os.path.isdir(path) and os.listdir(path)):
            out.append({"hf_repo": r["hf_repo"], "path": path, "name": r["hf_repo"]})
    return out


# ---------- downloads ----------

JOBS = {}


def _hf_snapshot(job):
    from huggingface_hub import snapshot_download
    tok = load_settings()["hf_token"] or None
    snapshot_download(job["hf_repo"], local_dir=job["path"], token=tok)


def _http(job):
    s = load_settings()
    url = job["url"]
    headers = {"User-Agent": "comfy-studio"}
    host = urllib.parse.urlparse(url).hostname or ""
    if host.endswith("huggingface.co") and s["hf_token"]:
        headers["Authorization"] = f"Bearer {s['hf_token']}"
    if host.endswith("civitai.com") and s["civitai_token"]:
        url += ("&" if "?" in url else "?") + "token=" + urllib.parse.quote(s["civitai_token"])
    # ponytail: single-stream urllib; switch to hf_transfer/aria2 if Kaggle speeds disappoint
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
        if not job["name"]:
            cd = r.headers.get("Content-Disposition", "")
            m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)', cd)
            job["name"] = os.path.basename(urllib.parse.unquote(m.group(1) if m else urllib.parse.urlparse(url).path))
        job["total"] = int(r.headers.get("Content-Length") or 0)
        dest = target_dir(job["directory"]) / job["name"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        with open(part, "wb") as f:
            while chunk := r.read(8 << 20):
                if job["cancel"]:
                    raise RuntimeError("cancelled")
                f.write(chunk)
                job["done"] += len(chunk)
        part.replace(dest)
        job["dest"] = str(dest)


def _run(job):
    try:
        (_hf_snapshot if job.get("hf_repo") else _http)(job)
        job["state"] = "done"
    except Exception as e:  # surfaced in the UI
        job["state"] = "error"
        job["error"] = str(e)
        if job.get("name") and job.get("directory"):
            part = target_dir(job["directory"]) / (job["name"] + ".part")
            part.unlink(missing_ok=True)
    job["ended"] = time.time()


def start_download(body):
    job = {"id": uuid.uuid4().hex[:8], "state": "running", "done": 0, "total": 0,
           "cancel": False, "started": time.time(), "error": None}
    if body.get("hf_repo"):
        repo = body["hf_repo"]
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise web.HTTPBadRequest(text="hf_repo must look like owner/name")
        job.update(hf_repo=repo, path=expand(body["path"]), name=repo)
    else:
        url, directory = body.get("url", ""), body.get("directory", "")
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            raise web.HTTPBadRequest(text="url must be http(s)")
        if directory not in model_folders():
            raise web.HTTPBadRequest(text=f"unknown model folder: {directory}")
        name = os.path.basename(body.get("name") or "")
        if name in (".", ".."):
            raise web.HTTPBadRequest(text="bad file name")
        job.update(url=url, directory=directory, name=name)
    JOBS[job["id"]] = job
    threading.Thread(target=_run, args=(job,), daemon=True).start()
    return job


# ---------- routes ----------

routes = PromptServer.instance.routes


def ok(data):
    return web.json_response(data)


@routes.get("/studio")
async def studio_redirect(request):
    raise web.HTTPFound("/studio/")


@routes.get("/studio/")
async def studio_index(request):
    return web.FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


@routes.get("/studio/api/library")
async def library(request):
    return ok([load_model(m) for m in model_ids()])


@routes.get("/studio/api/workflow/{mid}/{wid}")
async def get_workflow(request):
    mid, wid = request.match_info["mid"], request.match_info["wid"]
    check_id(mid, wid)
    p = workflow_path(mid, wid)
    if not p:
        raise web.HTTPNotFound()
    return web.FileResponse(p, headers={"Cache-Control": "no-cache"})


@routes.post("/studio/api/workflow/{mid}")
async def add_workflow(request):
    """Body: {id, title, workflow, model?: {name, kind, description}} -> saved in the user library."""
    mid = request.match_info["mid"]
    body = await request.json()
    wid = body.get("id")
    check_id(mid, wid)
    if not isinstance(body.get("workflow"), dict) or "nodes" not in body["workflow"]:
        raise web.HTTPBadRequest(text="workflow must be a ComfyUI UI-format workflow (has 'nodes')")
    p = USER_LIB / mid / "workflows" / f"{wid}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(body["workflow"]), encoding="utf-8")

    def upd(m):
        if body.get("model"):
            for k in ("name", "kind", "description"):
                m.setdefault(k, body["model"].get(k))
        m["workflows"] = [w for w in m.get("workflows", []) if w["id"] != wid]
        m["workflows"].append({"id": wid, "title": body.get("title") or wid})
        m["hidden"] = [h for h in m.get("hidden", []) if h != wid]
        if body.get("default"):
            m["default"] = wid
    edit_user_model(mid, upd)
    return ok(load_model(mid))


@routes.delete("/studio/api/workflow/{mid}/{wid}")
async def remove_workflow(request):
    mid, wid = request.match_info["mid"], request.match_info["wid"]
    check_id(mid, wid)
    (USER_LIB / mid / "workflows" / f"{wid}.json").unlink(missing_ok=True)

    def upd(m):
        m["workflows"] = [w for w in m.get("workflows", []) if w["id"] != wid]
        if (BUILTIN / mid / "workflows" / f"{wid}.json").exists():
            m["hidden"] = sorted(set(m.get("hidden", [])) | {wid})
    edit_user_model(mid, upd)
    return ok(load_model(mid))


@routes.post("/studio/api/model/{mid}/default")
async def set_default(request):
    mid = request.match_info["mid"]
    wid = (await request.json()).get("id")
    check_id(mid, wid)
    edit_user_model(mid, lambda m: m.update(default=wid))
    return ok(load_model(mid))


@routes.get("/studio/api/layout/{mid}/{wid}")
async def get_layout(request):
    mid, wid = request.match_info["mid"], request.match_info["wid"]
    check_id(mid, wid)
    p = USER_LIB / mid / "layouts" / f"{wid}.json"
    q = BUILTIN / mid / "layouts" / f"{wid}.json"
    return ok(read_json(p) if p.exists() else read_json(q) if q.exists() else {})


@routes.post("/studio/api/layout/{mid}/{wid}")
async def save_layout(request):
    mid, wid = request.match_info["mid"], request.match_info["wid"]
    check_id(mid, wid)
    p = USER_LIB / mid / "layouts" / f"{wid}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(await request.json(), indent=2), encoding="utf-8")
    return ok({"saved": True})


@routes.get("/studio/api/missing")
async def missing(request):
    mid, wid = request.query.get("model"), request.query.get("workflow")
    mids = [mid] if mid else model_ids()
    return ok({m: scan_missing(m, wid) for m in mids})


@routes.get("/studio/api/folders")
async def folders(request):
    return ok({"folders": model_folders(), "model_root": load_settings()["model_root"]})


@routes.post("/studio/api/download")
async def download(request):
    return ok(start_download(await request.json()))


@routes.get("/studio/api/downloads")
async def downloads(request):
    return ok(sorted(JOBS.values(), key=lambda j: -j["started"]))


@routes.post("/studio/api/downloads/{jid}/cancel")
async def cancel(request):
    job = JOBS.get(request.match_info["jid"])
    if job:
        job["cancel"] = True
    return ok({"ok": bool(job)})


@routes.get("/studio/api/settings")
async def get_settings(request):
    s = load_settings()
    # never echo secrets back to the browser
    return ok({**s, "hf_token": bool(s["hf_token"]), "civitai_token": bool(s["civitai_token"])})


@routes.post("/studio/api/settings")
async def post_settings(request):
    body = await request.json()
    s = load_settings()
    if "model_root" in body:
        s["model_root"] = body["model_root"].strip()
    for k in ("hf_token", "civitai_token"):
        if body.get(k):
            s[k] = body[k].strip()
    save_settings(s)
    apply_model_root(s["model_root"])
    return ok({"saved": True})


# ---------- auth: set STUDIO_TOKEN to protect everything (ComfyUI included) ----------

@web.middleware
async def token_auth(request, handler):
    token = os.environ.get("STUDIO_TOKEN")
    if not token:
        return await handler(request)
    sent = request.cookies.get("studio_token") or request.headers.get("X-Studio-Token") or ""
    if hmac.compare_digest(sent.encode(), token.encode()):
        return await handler(request)
    if hmac.compare_digest(request.query.get("token", "").encode(), token.encode()):
        resp = web.Response(status=302, headers={"Location": request.path})
        resp.set_cookie("studio_token", token, max_age=30 * 86400, httponly=True, samesite="Lax", secure=request.secure)
        return resp
    return web.Response(status=401, text="Unauthorized: open the link that includes ?token=...")


PromptServer.instance.app.middlewares.append(token_auth)
PromptServer.instance.app.add_routes([web.static("/studio/web", WEB)])
apply_model_root(load_settings()["model_root"])
