# Plan

## Principles
- The UI belongs to the model; workflows are plugins. Swapping a workflow never touches the UI.
- Never convert workflows ourselves — ComfyUI's frontend does it (`graphToPrompt` in a hidden iframe).
- No build step, no database: vanilla ES modules, JSON files.

## Done (v0.1)
- ComfyUI custom node serving `/studio/`, token auth for tunnels
- Library: builtin `library/` + user overrides (add / hide / default) in `STUDIO_USER_DIR`
- Adapter: UI workflow → API prompt → auto form (prompt / inputs / settings / models / advanced), notes, groups
- Field layout editing (pin / move / rename / hide), per-workflow drafts
- Generate: queue, runs ×N, live preview, progress, ETA, stop, node errors highlighted
- Missing models: declared links + uninstalled loader values; downloader (URL, HF repo), progress, cancel
- Library (history gallery), Settings (model root, tokens, free VRAM)
- Kaggle launcher: ComfyUI + node packs + AuK + cloudflared

## Next
1. Verify every builtin workflow on a Kaggle T4 box; add `COMFY_ARGS` notes per model (fp16, offload).
2. Per-model presets ("Faster ↔ Smarter" slider writing several inputs at once) — `model.json` `presets`.
3. Missing custom-node installer (registry `cnr_id` / git `aux_id`) + ComfyUI restart + reconnect.
4. Prompt Enhance (LLM rewrite; H3 prompt structure).
5. Storyboard: queue N shots, concat with ffmpeg.
6. Faster downloads (hf_transfer / aria2) if urllib is the bottleneck.
