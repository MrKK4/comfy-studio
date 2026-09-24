// Workflow adapter: UI-format workflow -> API prompt (via ComfyUI's own frontend) -> form fields.

// ---------- conversion ----------
// ComfyUI's frontend already knows how to flatten subgraphs, resolve Set/Get, reroutes and
// widget order. We load it once in a hidden same-origin iframe and borrow graphToPrompt().
let framePromise = null;

function comfyFrame() {
  if (framePromise) return framePromise;
  framePromise = new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.src = '/';
    f.style.cssText = 'position:fixed;width:1280px;height:800px;left:-99999px;top:0;opacity:0;pointer-events:none';
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    document.body.appendChild(f);
    const t0 = Date.now();
    const poll = setInterval(() => {
      const app = f.contentWindow?.app;
      if (app?.graphToPrompt && app?.rootGraph) { clearInterval(poll); resolve(app); }
      else if (Date.now() - t0 > 120000) { clearInterval(poll); framePromise = null; f.remove(); reject(new Error('ComfyUI frontend did not load in 120s')); }
    }, 250);
  });
  return framePromise;
}

let queue = Promise.resolve();
export function toApiPrompt(workflow) {
  // serialize: the iframe has one graph, conversions must not interleave
  const run = queue.then(async () => {
    const app = await comfyFrame();
    await app.loadGraphData(structuredClone(workflow), true, false, null,
      { deferWarnings: true, skipAssetScans: true, silentAssetErrors: true });
    const { output } = await app.graphToPrompt();
    return output;
  });
  queue = run.catch(() => {});
  return run;
}

// ---------- helpers ----------
const MODEL_EXT = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx)$/i;
const SEED = /^(seed|noise_seed)$/;
const SETTING = /^(width|height|length|frames|num_frames|frame_count|duration|duration_sec|seconds|fps|frame_rate|steps|cfg|batch_size|shift)$/i;
const PRIMITIVE = /^Primitive(Int|Float|String|StringMultiline|Boolean|Node)?$/;
const FRONTEND_ONLY = new Set(['Reroute', 'Note', 'MarkdownNote', 'PrimitiveNode', 'SetNode', 'GetNode']);

/** Normalise an /object_info input spec to {type, options, opts}. */
export function specOf(info, cls, name) {
  const def = info?.[cls]?.input;
  const raw = def?.required?.[name] ?? def?.optional?.[name];
  if (!raw) return null;
  const [t, opts = {}] = raw;
  if (Array.isArray(t)) return { type: 'COMBO', options: t, opts };
  if (t === 'COMBO') return { type: 'COMBO', options: opts.options || [], opts };
  return { type: t, options: null, opts };
}

function uploadKind(spec, cls) {
  const o = spec?.opts || {};
  if (o.image_upload || /^LoadImage/.test(cls)) return 'image';
  if (o.video_upload || /LoadVideo/.test(cls)) return 'video';
  if (o.audio_upload || /LoadAudio/.test(cls)) return 'audio';
  return null;
}

/** Map every node id (including subgraph-interior "outer:inner" ids) to UI node metadata. */
function uiIndex(ui) {
  const top = new Map((ui?.nodes || []).map(n => [String(n.id), n]));
  const groups = (ui?.groups || []).map(g => ({ title: g.title, b: g.bounding }));
  const groupOf = n => {
    if (!n?.pos) return null;
    const [x, y] = Array.isArray(n.pos) ? n.pos : [n.pos[0], n.pos[1]];
    const g = groups.find(g => x >= g.b[0] && y >= g.b[1] && x <= g.b[0] + g.b[2] && y <= g.b[1] + g.b[3]);
    return g?.title || null;
  };
  const subgraphs = new Map((ui?.definitions?.subgraphs || []).map(s => [s.id, s]));
  return id => {
    const outer = top.get(String(id).split(':')[0]);
    return {
      group: groupOf(outer),
      outerTitle: outer ? (outer.title || subgraphs.get(outer.type)?.name || outer.type) : null,
      control: outer?.widgets_values && Array.isArray(outer.widgets_values)
        ? outer.widgets_values.find(v => ['fixed', 'increment', 'decrement', 'randomize'].includes(v)) : null,
    };
  };
}

/** Notes (Note/MarkdownNote) from the UI workflow, in reading order. */
export function notesOf(ui) {
  return (ui?.nodes || [])
    .filter(n => n.type === 'Note' || n.type === 'MarkdownNote')
    .sort((a, b) => (a.pos?.[1] ?? 0) - (b.pos?.[1] ?? 0) || (a.pos?.[0] ?? 0) - (b.pos?.[0] ?? 0))
    .map(n => String(n.widgets_values?.[0] ?? '').trim())
    .filter(Boolean);
}

/** Node types in the UI workflow that this ComfyUI doesn't have. */
export function missingNodeTypes(ui, info) {
  const sub = new Set((ui?.definitions?.subgraphs || []).map(s => s.id));
  const all = [...(ui?.nodes || []), ...(ui?.definitions?.subgraphs || []).flatMap(s => s.nodes || [])];
  const out = new Map();
  for (const n of all) {
    if (info[n.type] || sub.has(n.type) || FRONTEND_ONLY.has(n.type)) continue;
    const p = n.properties || {};
    out.set(n.type, p.aux_id || p.cnr_id || null);
  }
  return [...out].map(([type, pack]) => ({ type, pack }));
}

/** Declared model downloads keyed by file name, from node properties.models. */
export function declaredModels(ui) {
  const all = [...(ui?.nodes || []), ...(ui?.definitions?.subgraphs || []).flatMap(s => s.nodes || [])];
  const out = {};
  for (const n of all) for (const m of n.properties?.models || []) out[m.name] = m;
  return out;
}

// ---------- fields ----------
/**
 * Build form fields from an API prompt.
 * field = {key, node, input, cls, label, nodeLabel, type, options, opts, value, role, section, group}
 * role: prompt | seed | media | setting | model | advanced
 */
export function deriveFields(prompt, ui, info, layout = {}) {
  const meta = uiIndex(ui);
  const fields = [];
  for (const [id, node] of Object.entries(prompt)) {
    const cls = node.class_type;
    const title = node._meta?.title || cls;
    const m = meta(id);
    const nodeLabel = m.outerTitle && m.outerTitle !== title && String(id).includes(':') ? `${m.outerTitle} › ${title}` : title;
    for (const [input, value] of Object.entries(node.inputs || {})) {
      if (Array.isArray(value)) continue; // linked from another node
      const spec = specOf(info, cls, input) || { type: typeof value === 'number' ? 'FLOAT' : typeof value === 'boolean' ? 'BOOLEAN' : 'STRING', options: null, opts: {} };
      if (input === 'control_after_generate') continue;
      const key = `${id}.${input}`;
      const up = spec.type === 'COMBO' ? uploadKind(spec, cls) : null;
      let role = 'advanced';
      const titled = title !== cls && !/^(Int|Float|String|Boolean)$/.test(title);
      if (up) role = 'media';
      else if (SEED.test(input)) role = 'seed';
      else if (spec.type === 'COMBO' && (MODEL_EXT.test(String(value)) || spec.options.some(o => MODEL_EXT.test(String(o))))) role = 'model';
      else if (spec.type === 'STRING' && (spec.opts.multiline || PRIMITIVE.test(cls) && String(value).length > 40)) role = 'prompt';
      else if (SETTING.test(input)) role = 'setting';
      else if (PRIMITIVE.test(cls) && titled) role = 'setting';
      const label = PRIMITIVE.test(cls) || role === 'prompt' && titled ? title : humanize(input);
      const f = {
        key, node: id, input, cls, label, nodeLabel, type: spec.type, options: spec.options, opts: spec.opts,
        value, role, upload: up, group: m.group, control: role === 'seed' ? (m.control || 'randomize') : null,
      };
      if (role === 'prompt' && /neg/i.test(title + ' ' + input)) f.negative = true;
      const o = layout.fields?.[key];
      if (o?.label) f.label = o.label;
      if (o?.hide) f.hidden = true;
      if (o?.pin === true && f.role === 'advanced') f.role = 'setting';
      if (o?.pin === false && f.role !== 'model') f.role = 'advanced';
      fields.push(f);
    }
  }
  // prompts: positive first, longer first
  const rank = f => (f.negative ? 1 : 0);
  fields.sort((a, b) => (a.role === 'prompt' && b.role === 'prompt') ? rank(a) - rank(b) : 0);
  return fields;
}

/** Model-loader fields whose current value isn't installed. */
export function missingModelFields(fields, declared) {
  return fields.filter(f => f.role === 'model' && !f.options.includes(f.value))
    .map(f => ({ ...f, declared: declared[f.value] || null }));
}

/** Copy of the prompt with form values applied. */
export function applyValues(prompt, values) {
  const p = structuredClone(prompt);
  for (const [key, v] of Object.entries(values)) {
    const i = key.lastIndexOf('.');
    const node = p[key.slice(0, i)];
    if (node) node.inputs[key.slice(i + 1)] = v;
  }
  return p;
}

export function humanize(s) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bCfg\b/, 'CFG').replace(/\bFps\b/, 'FPS');
}
