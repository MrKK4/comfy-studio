# Comfy Studio

A clean, focused web UI with ComfyUI as the backend. Each model gets its own page; each page can
hold any number of workflows, and swapping a workflow never touches the UI.

It is a ComfyUI custom node: it serves the UI at `/studio/` from ComfyUI's own server, so there is
one process, one port and one tunnel.

## What it does

- **Generate** — pick a model, pick one of its workflows, and get a form built from the workflow
  itself: prompts, input images/video/audio, seed, steps, sizes, model files, and every other
  setting under Advanced. Live preview, progress, queue, stop, multiple runs, time estimates.
- **Any workflow** — drop in a normal saved ComfyUI workflow (subgraphs, Set/Get nodes, reroutes
  and custom nodes included). ComfyUI's own frontend converts it (hidden iframe), so what runs is
  exactly what ComfyUI would run.
- **Tune the form** — every field has a ⋯ menu: show in main settings, move to Advanced, rename,
  hide. Saved per workflow. Your last values are kept as a draft.
- **Missing models** — detected from the model links embedded in workflows and from loader values
  that aren't installed. One click downloads them; files without a link get a paste-a-link box.
- **Downloads** — any URL (Hugging Face, Civitai, direct) into any model folder, or a whole
  Hugging Face repo into a folder. Progress, speed, cancel.
- **Library** — everything ComfyUI saved, filterable by video / image / audio.
- **Settings** — model folder (e.g. `/kaggle/temp/models`), HF token, Civitai key.

## Built-in models

| Model | Workflows |
|---|---|
| MiniMax H3 | Text to Video, **Uncrop + Audio (custom)**, Image to Video, Reference to Video, Multiframe Reference, I2V Continuation, Pose ControlNet, FastH3 T2V / I2V |
| LTX-2.5 | Text to Video, Image to Video, First/Last Frame |
| Krea 2 | Text to Image, Text to Image (int8), Style Reference |
| Qwen Image 2.1 | Text to Image, Image Edit, Background Removal |
| YuE2 | Text to Music, Music Cover |
| Tencent AuK | Generate / Edit Speech |
| MiniMax Music 3 | Text to Music |

Workflows come from [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates)
and [Tencent-Hunyuan/AuK](https://github.com/Tencent-Hunyuan/AuK).

## Run on Kaggle

1. Add Kaggle secrets: `GITHUB_TOKEN` (repo read access), optionally `HF_TOKEN`, `CIVITAI_TOKEN`.
2. One cell:

```python
from kaggle_secrets import UserSecretsClient
tok = UserSecretsClient().get_secret("GITHUB_TOKEN")
!git clone -q https://{tok}@github.com/MrKK4/comfy-studio /kaggle/temp/comfy-studio || git -C /kaggle/temp/comfy-studio pull -q
%run /kaggle/temp/comfy-studio/kaggle/launch.py
```

It installs ComfyUI, the node packs in `kaggle/nodes.txt` and AuK, starts ComfyUI with models in
`/kaggle/temp/models` and outputs in `/kaggle/working/outputs`, and prints a private
`trycloudflare.com` link with an access token. **Anyone with that link can run code on the
machine — don't share it.**

Options (set before `%run`): `os.environ["COMFY_ARGS"] = "--lowvram"`, `COMFY_REF` (pin a ComfyUI
commit), `INSTALL_AUK="0"`, `STUDIO_TOKEN` (fixed token).

Things you add in the UI (workflows, field layouts, settings) are saved in `/kaggle/working/studio`,
which survives *Save Version*. To make them permanent, copy them into `library/` and commit.

## Run locally

```bash
cd ComfyUI/custom_nodes && git clone https://github.com/MrKK4/comfy-studio
cd .. && python main.py
# open http://127.0.0.1:8188/studio/
```

## Add or swap workflows

In the UI: **Add workflow** (left rail) or the ⋯ menu next to the workflow picker (make default,
remove, open in ComfyUI). In the repo:

```
library/<model-id>/model.json          # name, kind (video|image|audio), description, workflow list
library/<model-id>/workflows/<id>.json # normal saved ComfyUI workflow, unedited
library/<model-id>/layouts/<id>.json   # optional: field pins/labels/hides (export from the UI)
```

`model.json` may also list `requires` (whole HF repos a node needs, like AuK's checkpoints) and
`notes` (shown on the page).

## Tests

```bash
npm test        # adapter: workflow -> form fields
```
