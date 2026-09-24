import * as api from './comfy.js';
import {
  toApiPrompt, deriveFields, applyValues, notesOf, missingNodeTypes, declaredModels, missingModelFields,
} from './adapter.js';

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('cs_' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cs_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 9000 : 4000);
}

const fmtBytes = n => !n ? '0 B' : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
const fmtTime = s => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// ponytail: minimal markdown for workflow notes (headings, bold, code, links, paragraphs)
const md = s => esc(s)
  .replace(/^#{1,2} (.*)$/gm, '<h3>$1</h3>').replace(/^#{3,6} (.*)$/gm, '<h4>$1</h4>')
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  .split(/\n{2,}/).map(p => /^<h[34]>/.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

// ---------- state ----------
const S = {
  library: [], info: null, model: null, wfId: null,
  ui: null, prompt: null, fields: [], values: {}, layout: {}, notes: [], missingNodes: [],
  errorsByNode: {}, jobs: [], current: null, loading: false, runs: 1, connected: false,
};
const kindLabel = { video: 'Video', image: 'Image', audio: 'Audio' };

// ---------- tabs ----------
function showTab(tab) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === tab);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${tab}`;
  store.set('tab', tab);
  ({ library: renderLibrary, downloads: renderDownloads, settings: renderSettings })[tab]?.();
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- models rail ----------
function renderRail() {
  const box = $('#models');
  box.replaceChildren();
  for (const kind of ['video', 'image', 'audio', 'other']) {
    const ms = S.library.filter(m => (kindLabel[m.kind] ? m.kind : 'other') === kind);
    if (!ms.length) continue;
    box.append(h('div', { class: 'rail-kind' }, kindLabel[kind] || 'Other'));
    for (const m of ms) {
      box.append(h('button', {
        class: 'model-btn', 'aria-current': S.model?.id === m.id ? 'true' : 'false',
        onclick: () => selectModel(m.id),
      }, h('b', {}, m.name), h('small', {}, `${m.workflows.length} workflow${m.workflows.length === 1 ? '' : 's'}`)));
    }
  }
}

async function loadLibrary() {
  S.library = await api.get('/studio/api/library');
  renderRail();
}

async function selectModel(mid, wid) {
  const m = S.library.find(x => x.id === mid) || S.library[0];
  if (!m) return;
  S.model = m;
  store.set('model', m.id);
  renderRail();
  const want = wid || store.get(`wf_${m.id}`) || m.default;
  await selectWorkflow(m.workflows.some(w => w.id === want) ? want : m.default);
}

// ---------- workflow loading ----------
async function selectWorkflow(wid) {
  const m = S.model;
  S.wfId = wid;
  store.set(`wf_${m.id}`, wid);
  S.loading = true; S.fields = []; S.errorsByNode = {};
  renderPanel();
  try {
    const [ui, info, layout] = await Promise.all([
      api.get(`/studio/api/workflow/${m.id}/${wid}`), api.objectInfo(), api.get(`/studio/api/layout/${m.id}/${wid}`),
    ]);
    if (S.wfId !== wid) return;
    S.ui = ui; S.info = info; S.layout = layout || {};
    S.notes = notesOf(ui);
    S.missingNodes = missingNodeTypes(ui, info);
    S.prompt = await toApiPrompt(ui);
    if (S.wfId !== wid) return;
    rebuildFields();
  } catch (e) {
    S.loadError = e.message;
    console.error(e);
  } finally {
    if (S.wfId === wid) { S.loading = false; renderPanel(); }
  }
}

function rebuildFields() {
  S.fields = deriveFields(S.prompt, S.ui, S.info, S.layout);
  const draft = store.get(draftKey(), {});
  S.values = {};
  for (const f of S.fields) {
    S.values[f.key] = f.key in draft ? draft[f.key] : f.value;
    if (f.role === 'seed' && draft[`${f.key}#mode`]) f.control = draft[`${f.key}#mode`];
  }
  S.loadError = null;
}

const draftKey = () => `draft_${S.model.id}_${S.wfId}`;
function setValue(f, v) {
  S.values[f.key] = v;
  const d = store.get(draftKey(), {});
  d[f.key] = v;
  store.set(draftKey(), d);
}
function resetDraft() {
  store.set(draftKey(), {});
  rebuildFields();
  renderPanel();
  toast('Reset to the workflow’s own values');
}

// ---------- panel ----------
function renderPanel() {
  const m = S.model;
  const head = $('#panel-head'), body = $('#panel-body'), foot = $('#panel-foot');
  if (!m) { head.replaceChildren(); body.replaceChildren(h('p', { class: 'muted' }, 'No models in the library yet.')); return; }

  const sel = h('select', { 'aria-label': 'Workflow', onchange: e => selectWorkflow(e.target.value) },
    m.workflows.map(w => h('option', { value: w.id, selected: w.id === S.wfId }, w.title + (w.id === m.default ? '  (default)' : ''))));
  head.replaceChildren(
    h('h1', {}, m.name, h('small', {}, m.description || '')),
    h('div', { class: 'wf-row' }, sel, h('button', { class: 'icon-btn', title: 'Workflow options', 'aria-label': 'Workflow options', onclick: e => workflowMenu(e.currentTarget) }, '⋯')),
  );

  body.replaceChildren();
  if (S.loading) body.append(h('p', { class: 'muted', style: 'padding-top:16px' }, 'Reading workflow…'));
  else if (S.loadError) body.append(h('div', { class: 'callout warn' }, h('b', {}, 'This workflow could not be read. '), S.loadError));
  else body.append(...panelSections());

  renderFoot(foot);
}

function panelSections() {
  const out = [];
  const byRole = r => S.fields.filter(f => f.role === r && !f.hidden);

  if (S.model.notes) out.push(h('div', { class: 'callout' }, S.model.notes));
  if (S.missingNodes.length) {
    out.push(h('div', { class: 'callout warn' },
      h('b', {}, 'Missing custom nodes. '), 'Install these node packs, then restart ComfyUI:',
      h('ul', {}, [...new Set(S.missingNodes.map(n => n.pack || n.type))].map(p => h('li', {}, p)))));
  }
  const missing = missingModelFields(S.fields, declaredModels(S.ui));
  if (missing.length) {
    out.push(h('div', { class: 'callout warn' },
      h('b', {}, `${missing.length} model file${missing.length > 1 ? 's' : ''} not installed. `),
      'Generation will fail until they are downloaded. ',
      h('button', { class: 'btn sm', onclick: () => downloadAll(missing) }, missing.some(x => x.declared?.url) ? 'Download missing' : 'Open downloads')));
  }
  if (S.notes.length) {
    out.push(h('details', { class: 'sec', open: store.get('notes_open', false), ontoggle: e => store.set('notes_open', e.target.open) },
      h('summary', {}, `Workflow notes (${S.notes.length})`),
      h('div', { class: 'notes' }, S.notes.map(n => h('div', { html: md(n) })))));
  }

  const prompts = byRole('prompt');
  if (prompts.length) out.push(h('div', { class: 'sec' }, h('h2', {}, prompts.length > 1 ? 'Prompts' : 'Prompt'), prompts.map(fieldEl)));
  const media = byRole('media');
  if (media.length) out.push(h('div', { class: 'sec' }, h('h2', {}, 'Inputs'), media.map(fieldEl)));
  const settings = [...byRole('seed'), ...byRole('setting')];
  if (settings.length) out.push(h('div', { class: 'sec' }, h('h2', {}, 'Settings'), grid(settings)));
  const models = byRole('model');
  if (models.length) {
    out.push(h('details', { class: 'sec', open: missing.length > 0 || store.get('models_open', false), ontoggle: e => store.set('models_open', e.target.open) },
      h('summary', {}, 'Models', missing.length ? h('span', { class: 'badge bad' }, `${missing.length} missing`) : h('span', { class: 'badge ok' }, 'ready')),
      models.map(fieldEl)));
  }
  const adv = byRole('advanced');
  if (adv.length) {
    const groups = new Map();
    for (const f of adv) {
      const k = f.node;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    out.push(h('details', { class: 'sec' }, h('summary', {}, `Advanced (${adv.length})`),
      [...groups.values()].map(fs => h('details', { class: 'node-group' },
        h('summary', {}, h('span', {}, fs[0].nodeLabel), h('code', {}, fs[0].group || `#${fs[0].node}`)),
        h('div', {}, fs.map(fieldEl))))));
  }
  const hidden = S.fields.filter(f => f.hidden);
  if (hidden.length) {
    out.push(h('details', { class: 'sec' }, h('summary', {}, `Hidden (${hidden.length})`),
      hidden.map(f => h('div', { class: 'missing-line' }, h('span', { class: 'spacer' }, `${f.label} · ${f.nodeLabel}`),
        h('button', { class: 'ghost sm', onclick: () => editLayout(f, { hide: false }) }, 'Show')))));
  }
  out.push(h('div', { class: 'sec' }, h('button', { class: 'ghost sm', onclick: resetDraft }, 'Reset to workflow values')));
  return out;
}

// numbers/toggles pair up two per row; wide things take a full row
function grid(fields) {
  const out = [];
  let pair = [];
  const flush = () => { if (pair.length) out.push(pair.length === 2 ? h('div', { class: 'row2' }, pair) : pair[0]); pair = []; };
  for (const f of fields) {
    const small = ['INT', 'FLOAT', 'BOOLEAN'].includes(f.type) && f.role !== 'seed' && !hasSlider(f) || f.type === 'COMBO' && f.options.length < 12;
    const el = fieldEl(f);
    if (small) { pair.push(el); if (pair.length === 2) flush(); } else { flush(); out.push(el); }
  }
  flush();
  return out;
}

const hasSlider = f => ['INT', 'FLOAT'].includes(f.type) && f.opts.min != null && f.opts.max != null && f.opts.max - f.opts.min <= 4096 && f.opts.display !== 'number';

function fieldEl(f) {
  const id = `f-${f.key.replace(/[^\w-]/g, '_')}`;
  const wrap = h('div', { class: `field${S.errorsByNode[f.node] ? ' err' : ''}`, 'data-node': f.node });
  const hint = f.role !== 'advanced' && f.role !== 'prompt' && f.nodeLabel !== f.label ? f.nodeLabel : '';
  wrap.append(h('div', { class: 'field-top' },
    h('label', { for: id, title: `${f.nodeLabel} · ${f.input}` }, f.label, hint && h('span', { class: 'hint' }, hint)),
    h('button', { class: 'field-menu', 'aria-label': `Options for ${f.label}`, onclick: e => fieldMenu(e.currentTarget, f) }, '⋯')));
  wrap.append(h('div', { class: 'control' }, control(f, id)));
  return wrap;
}

function control(f, id) {
  const v = S.values[f.key];
  if (f.role === 'media') return mediaControl(f, id);
  if (f.role === 'seed') {
    const input = h('input', { id, type: 'number', value: v, oninput: e => setValue(f, Number(e.target.value)) });
    const mode = f.control === 'fixed' ? 'fixed' : 'randomize';
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Seed mode' },
      ['randomize', 'fixed'].map(m => h('button', {
        'aria-pressed': mode === m ? 'true' : 'false',
        onclick: () => { f.control = m; const d = store.get(draftKey(), {}); d[`${f.key}#mode`] = m; store.set(draftKey(), d); renderPanel(); },
      }, m === 'randomize' ? 'Random' : 'Fixed')));
    const dice = h('button', { class: 'icon-btn', title: 'New seed', 'aria-label': 'New seed', onclick: () => { const s = newSeed(f); input.value = s; setValue(f, s); } }, '⟳');
    return h('div', { class: 'seed' }, input, seg, dice);
  }
  if (f.type === 'BOOLEAN') {
    return h('label', { class: 'toggle' }, h('input', { id, type: 'checkbox', checked: !!v, onchange: e => setValue(f, e.target.checked) }), v ? 'On' : 'Off');
  }
  if (f.type === 'COMBO') {
    const opts = f.options.includes(v) ? f.options : [v, ...f.options];
    const s = h('select', { id, onchange: e => { setValue(f, e.target.value); if (f.role === 'model') renderPanel(); } },
      opts.map(o => h('option', { value: o, selected: o === v }, String(o) + (f.role === 'model' && !f.options.includes(o) ? '  — not installed' : ''))));
    if (f.role !== 'model') return s;
    const missing = !f.options.includes(v);
    return h('div', { class: 'model-field' }, s, missing && h('div', { class: 'missing-line' },
      h('span', { class: 'badge bad' }, 'Not installed'),
      h('button', { class: 'ghost sm', onclick: () => downloadAll(missingModelFields([f], declaredModels(S.ui))) }, declaredModels(S.ui)[v]?.url ? 'Download' : 'Find a download')));
  }
  if (f.type === 'INT' || f.type === 'FLOAT') {
    const step = f.opts.step ?? (f.type === 'INT' ? 1 : 0.01);
    const num = h('input', { id, type: 'number', value: v, step, min: f.opts.min, max: f.opts.max, oninput: e => { setValue(f, Number(e.target.value)); if (range) range.value = e.target.value; } });
    const range = hasSlider(f) ? h('input', { type: 'range', min: f.opts.min, max: f.opts.max, step, value: v, 'aria-label': f.label, oninput: e => { setValue(f, Number(e.target.value)); num.value = e.target.value; } }) : null;
    return range ? h('div', { class: 'num' }, range, num) : num;
  }
  if (f.role === 'prompt' || f.opts.multiline) {
    const ta = h('textarea', { id, class: f.negative ? 'negative' : f.role === 'prompt' ? 'prompt' : '', value: v ?? '', spellcheck: true, oninput: e => { setValue(f, e.target.value); autosize(e.target); } });
    requestAnimationFrame(() => autosize(ta));
    return ta;
  }
  return h('input', { id, type: 'text', value: v ?? '', oninput: e => setValue(f, e.target.value) });
}

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px'; }
const newSeed = f => Math.floor(Math.random() * Math.min(f.opts.max ?? 2 ** 50, 2 ** 50));

function mediaControl(f, id) {
  const v = S.values[f.key];
  const file = h('input', { id, type: 'file', accept: `${f.upload}/*`, onchange: e => e.target.files[0] && put(e.target.files[0]) });
  const preview = () => {
    if (!v) return h('span', {}, `Drop ${f.upload === 'image' ? 'an image' : `a ${f.upload} file`} or click to choose`);
    const url = api.inputUrl(v);
    const el = f.upload === 'image' ? h('img', { src: url, alt: v, onerror: e => e.target.replaceWith(h('span', {}, 'File not on this server yet')) })
      : f.upload === 'video' ? h('video', { src: url, muted: true, loop: true, autoplay: true, playsInline: true })
        : h('audio', { src: url, controls: true });
    return h('div', {}, el, h('div', { class: 'name' }, v));
  };
  const drop = h('div', {
    class: 'drop', tabIndex: 0, role: 'button', 'aria-label': `${f.label}: choose file`,
    onclick: e => { if (!(e.target instanceof HTMLAudioElement)) file.click(); },
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } },
    ondragover: e => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && put(e.dataTransfer.files[0]); },
  }, preview(), file);
  async function put(fileObj) {
    drop.replaceChildren(h('span', {}, `Uploading ${fileObj.name}…`));
    try {
      const name = await api.upload(fileObj);
      setValue(f, name);
      if (!f.options.includes(name)) f.options.push(name);
    } catch (e) { toast(`Upload failed: ${e.message}`, 'bad'); }
    renderPanel();
  }
  const pick = f.options.length > 1 && h('select', { class: 'pick', 'aria-label': `Existing ${f.upload} files`, onchange: e => { setValue(f, e.target.value); renderPanel(); } },
    h('option', { value: '' }, 'Or pick an uploaded file…'), f.options.map(o => h('option', { value: o, selected: o === v }, o)));
  return h('div', {}, drop, pick);
}

// ---------- menus ----------
function openMenu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map(([label, fn]) =>
    h('button', { role: 'menuitem', onclick: () => { menu.remove(); fn(); } }, label)));
  document.body.append(menu);
  const w = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  menu.style.top = Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8) + 'px';
  menu.querySelector('button')?.focus();
  const close = e => { if (!menu.contains(e.target)) { menu.remove(); removeEventListener('pointerdown', close, true); } };
  addEventListener('pointerdown', close, true);
  menu.addEventListener('keydown', e => { if (e.key === 'Escape') { menu.remove(); anchor.focus(); } });
}

function fieldMenu(anchor, f) {
  openMenu(anchor, [
    f.role === 'advanced' ? ['Show in main settings', () => editLayout(f, { pin: true })] : f.role !== 'model' && ['Move to Advanced', () => editLayout(f, { pin: false })],
    ['Rename…', () => { const l = prompt('Label for this field', f.label); if (l) editLayout(f, { label: l.trim() }); }],
    ['Hide', () => editLayout(f, { hide: true })],
    ['Reset to workflow value', () => { setValue(f, f.value); renderPanel(); }],
  ]);
}

async function editLayout(f, change) {
  const fields = { ...(S.layout.fields || {}) };
  fields[f.key] = { ...(fields[f.key] || {}), ...change };
  for (const [k, v] of Object.entries(fields[f.key])) if (v === undefined || v === false && k === 'hide') delete fields[f.key][k];
  S.layout = { ...S.layout, fields };
  await api.post(`/studio/api/layout/${S.model.id}/${S.wfId}`, S.layout);
  const vals = S.values;
  S.fields = deriveFields(S.prompt, S.ui, S.info, S.layout);
  S.values = vals;
  renderPanel();
}

function workflowMenu(anchor) {
  const m = S.model, w = m.workflows.find(x => x.id === S.wfId);
  openMenu(anchor, [
    ['Add workflow…', () => addWorkflowDialog(m.id)],
    w && w.id !== m.default && ['Make this the default', async () => { replaceModel(await api.post(`/studio/api/model/${m.id}/default`, { id: w.id })); toast(`${w.title} is now the default`); }],
    ['Open graph in ComfyUI', () => openInComfy()],
    ['Download workflow file', () => downloadJson(S.ui, `${m.id}-${S.wfId}.json`)],
    w && ['Remove from this model', () => removeWorkflow(w)],
  ]);
}

function replaceModel(m) {
  S.library = S.library.map(x => x.id === m.id ? m : x);
  if (!S.library.some(x => x.id === m.id)) S.library.push(m);
  if (S.model?.id === m.id) S.model = m;
  renderRail();
  renderPanel();
}

async function removeWorkflow(w) {
  if (!confirm(`Remove “${w.title}” from ${S.model.name}?${w.user ? ' The uploaded file is deleted.' : ' The built-in copy stays in the repo and can be restored by adding it again.'}`)) return;
  const m = await api.del(`/studio/api/workflow/${S.model.id}/${w.id}`);
  replaceModel(m);
  if (m.workflows.length) selectWorkflow(m.default); else loadLibrary();
  toast(`Removed ${w.title}`);
}

function downloadJson(obj, name) {
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

function openInComfy() {
  // ponytail: hand the graph over via the file; ComfyUI opens it on drop / Workflow > Open
  downloadJson(S.ui, `${S.model.id}-${S.wfId}.json`);
  window.open('/', '_blank', 'noopener');
  toast('Workflow file downloaded — drop it onto the ComfyUI tab to edit the graph');
}

// ---------- add workflow ----------
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workflow';

function addWorkflowDialog(defaultModel) {
  const dlg = $('#dialog');
  dlg.className = '';
  let parsed = null;
  const status = h('p', { class: 'muted' }, 'Use a normal saved workflow (Workflow › Save), not “Export (API)”, so notes and model links come along.');
  const title = h('input', { type: 'text', required: true, placeholder: 'e.g. Uncrop with audio' });
  const modelSel = h('select', {}, S.library.map(m => h('option', { value: m.id, selected: m.id === (defaultModel || S.model?.id) }, m.name)), h('option', { value: '__new' }, 'New model…'));
  const newName = h('input', { type: 'text', placeholder: 'Model name, e.g. Wan 2.2' });
  const newKind = h('select', {}, ['video', 'image', 'audio'].map(k => h('option', { value: k }, kindLabel[k])));
  const newBox = h('div', { class: 'row2', hidden: true }, h('label', {}, 'Name', newName), h('label', {}, 'Output', newKind));
  modelSel.onchange = () => { newBox.hidden = modelSel.value !== '__new'; };
  const makeDefault = h('input', { type: 'checkbox' });
  const file = h('input', {
    type: 'file', accept: '.json,application/json', onchange: async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        parsed = JSON.parse(await f.text());
        if (!parsed.nodes) throw new Error('This looks like an API export. Save the workflow normally and try again.');
        status.textContent = `${parsed.nodes.length} nodes, ${parsed.definitions?.subgraphs?.length || 0} subgraphs.`;
        if (!title.value) title.value = f.name.replace(/\.json$/i, '').replace(/[_-]+/g, ' ');
      } catch (err) { parsed = null; status.textContent = err.message; }
    },
  });
  const form = h('form', { method: 'dialog', onsubmit: async e => {
    e.preventDefault();
    if (!parsed) { status.textContent = 'Choose a workflow file first.'; return; }
    const isNew = modelSel.value === '__new';
    if (isNew && !newName.value.trim()) { newName.focus(); return; }
    const mid = isNew ? slug(newName.value) : modelSel.value;
    try {
      const m = await api.post(`/studio/api/workflow/${mid}`, {
        id: slug(title.value), title: title.value.trim(), workflow: parsed, default: makeDefault.checked,
        model: isNew ? { name: newName.value.trim(), kind: newKind.value, description: '' } : null,
      });
      replaceModel(m);
      dlg.close();
      await selectModel(mid, slug(title.value));
      showTab('generate');
      toast(`Added ${title.value.trim()}`, 'good');
    } catch (err) { status.textContent = err.message; }
  } },
  h('h2', {}, 'Add a workflow'),
  h('div', { class: 'stack' },
    h('label', {}, 'Workflow file', file), status,
    h('label', {}, 'Title', title),
    h('label', {}, 'Model', modelSel), newBox,
    h('label', { class: 'toggle' }, makeDefault, 'Make it the default for this model')),
  h('div', { class: 'actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'go', type: 'submit' }, 'Add workflow')));
  dlg.replaceChildren(form);
  dlg.showModal();
}
$('#add-workflow').addEventListener('click', () => addWorkflowDialog());

// ---------- generate ----------
function etaFor(mid, wid) {
  const xs = store.get(`eta_${mid}_${wid}`, []);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function renderFoot(foot = $('#panel-foot')) {
  if (!S.model) { foot.replaceChildren(); return; }
  const running = S.jobs.filter(j => j.status === 'queued' || j.status === 'running');
  const eta = etaFor(S.model.id, S.wfId);
  foot.replaceChildren(
    h('div', { class: 'eta' }, running.length ? `${running.length} in queue` : eta ? `Usually about ${fmtTime(eta)}` : 'Time estimate appears after the first run'),
    running.length ? h('button', { class: 'btn stop', onclick: cancelRun }, 'Stop') : null,
    h('div', { class: 'runs', title: 'Number of runs' },
      h('button', { 'aria-label': 'Fewer runs', onclick: () => { S.runs = Math.max(1, S.runs - 1); renderFoot(); } }, '−'),
      h('span', {}, S.runs),
      h('button', { 'aria-label': 'More runs', onclick: () => { S.runs = Math.min(16, S.runs + 1); renderFoot(); } }, '+')),
    h('button', { class: 'go', disabled: S.loading || !S.prompt || !!S.loadError, onclick: generate }, 'Generate'),
  );
}

async function generate() {
  const m = S.model, w = m.workflows.find(x => x.id === S.wfId);
  S.errorsByNode = {};
  for (let i = 0; i < S.runs; i++) {
    for (const f of S.fields) if (f.role === 'seed' && f.control !== 'fixed') setValue(f, newSeed(f));
    const prompt = applyValues(S.prompt, S.values);
    try {
      const r = await api.queuePrompt(prompt, S.ui);
      const job = { id: r.prompt_id, model: m.id, wf: S.wfId, label: `${m.name} · ${w?.title}`, status: 'queued', total: Object.keys(prompt).length, done: new Set(), pct: 0, files: [], added: Date.now() };
      S.jobs.unshift(job);
      S.current = job.id;
    } catch (e) {
      const ne = e.body?.node_errors || {};
      S.errorsByNode = Object.fromEntries(Object.keys(ne).map(k => [k, true]));
      const lines = Object.entries(ne).map(([id, v]) => `${v.class_type} #${id}: ${v.errors.map(x => x.details || x.message).join('; ')}`);
      toast(h('div', {}, h('b', {}, e.message), lines.length ? h('div', { class: 'muted' }, lines.slice(0, 4).join('\n')) : null), 'bad');
      break;
    }
  }
  renderPanel();
  renderStage();
}

async function cancelRun() {
  const running = S.jobs.find(j => j.status === 'running');
  const queued = S.jobs.filter(j => j.status === 'queued').map(j => j.id);
  if (queued.length) await api.post('/queue', { delete: queued });
  for (const j of S.jobs) if (queued.includes(j.id)) j.status = 'cancelled';
  if (running) await api.interrupt();
  renderStage(); renderFoot();
}

// ---------- websocket ----------
let previewUrl = null;
api.connect({
  open() { S.connected = true; setStatus(); },
  close() { S.connected = false; setStatus(); },
  preview(url) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    const img = document.querySelector('#monitor img.live');
    if (img) img.src = url; else renderStage();
  },
  message(type, d) {
    if (type === 'status') { S.queueRemaining = d?.status?.exec_info?.queue_remaining ?? 0; setStatus(); return; }
    const job = d?.prompt_id && S.jobs.find(j => j.id === d.prompt_id);
    if (!job) return;
    if (type === 'execution_start') { job.status = 'running'; job.started = Date.now(); }
    else if (type === 'execution_cached') for (const n of d.nodes || []) job.done.add(n);
    else if (type === 'executing') {
      if (d.node == null) return finish(job);
      job.done.add(d.node);
      job.node = S.prompt?.[d.node]?._meta?.title || d.node;
      job.step = null;
    } else if (type === 'progress') job.step = [d.value, d.max];
    else if (type === 'executed') job.done.add(d.node);
    else if (type === 'execution_success') return finish(job);
    else if (type === 'execution_error') {
      job.status = 'failed';
      job.error = { message: d.exception_message, node: `${d.node_type} #${d.node_id}`, trace: (d.traceback || []).join('') };
    } else if (type === 'execution_interrupted') job.status = 'cancelled';
    job.pct = Math.min(0.99, (job.done.size - 1 + (job.step ? job.step[0] / job.step[1] : 0)) / job.total);
    renderStage();
    if (['failed', 'cancelled'].includes(job.status)) renderFoot();
  },
});

async function finish(job) {
  if (job.status === 'done' || job.finishing) return;
  job.finishing = true;
  try {
    const hist = await api.history(job.id);
    job.files = api.outputFiles(hist[job.id]);
  } catch { job.files = []; }
  job.status = 'done';
  job.pct = 1;
  if (job.started) {
    const k = `eta_${job.model}_${job.wf}`;
    store.set(k, [...store.get(k, []), (Date.now() - job.started) / 1000].slice(-5));
  }
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  renderStage(); renderFoot();
}

function setStatus() {
  const el = $('#status');
  const busy = S.jobs.some(j => j.status === 'running');
  el.className = `status ${!S.connected ? 'off' : busy ? 'busy' : 'on'}`;
  el.querySelector('.label').textContent = !S.connected ? 'Offline' : busy ? `Working${S.queueRemaining > 1 ? ` · ${S.queueRemaining} queued` : ''}` : 'Ready';
}

// ---------- stage ----------
function mediaEl(f, big = true) {
  const url = api.viewUrl(f);
  if (f.kind === 'video') return h('video', { src: url, controls: big, autoplay: true, loop: true, muted: !big, playsInline: true });
  if (f.kind === 'audio') return big ? h('audio', { src: url, controls: true }) : h('span', {}, '♪ audio');
  if (f.kind === 'image') return h('img', { src: url, alt: f.filename, loading: 'lazy' });
  return h('span', {}, f.filename);
}

function renderStage() {
  setStatus();
  const mon = $('#monitor'), glow = $('#glow');
  const job = S.jobs.find(j => j.id === S.current);
  const running = job && (job.status === 'running' || job.status === 'queued');
  glow.classList.toggle('on', !!running);
  glow.querySelector('i').style.width = running ? `${Math.max(2, job.pct * 100)}%` : '0';

  if (!job) {
    mon.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Nothing generated yet'),
      S.model ? `Pick a workflow, fill in the prompt and press Generate. Results from ${S.model.name} appear here.` : 'Pick a model on the left to start.'));
  } else if (running) {
    const eta = etaFor(job.model, job.wf);
    const left = eta && job.started ? Math.max(0, eta - (Date.now() - job.started) / 1000) : null;
    mon.replaceChildren(
      previewUrl ? h('img', { class: 'live', src: previewUrl, alt: 'Live preview' }) : h('div', { class: 'empty' }, h('b', {}, job.status === 'queued' ? 'Waiting in queue' : 'Generating'), job.label),
      h('div', { class: 'run-state' },
        h('span', {}, h('b', {}, job.node || (job.status === 'queued' ? 'Queued' : 'Starting')), job.step ? `  step ${job.step[0]}/${job.step[1]}` : ''),
        h('span', {}, `${Math.round(job.pct * 100)}%${left != null ? ` · about ${fmtTime(left)} left` : ''}`)));
  } else if (job.status === 'failed') {
    mon.replaceChildren(h('div', { class: 'error-box', role: 'alert' }, h('b', {}, 'Generation failed'), `${job.error?.node}: ${job.error?.message}`,
      job.error?.trace && h('details', {}, h('summary', {}, 'Traceback'), h('pre', {}, job.error.trace))));
  } else if (job.status === 'cancelled') {
    mon.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Stopped'), 'This run was cancelled.'));
  } else {
    const f = job.files[job.shown || 0];
    mon.replaceChildren(f ? mediaEl(f) : h('div', { class: 'empty' }, h('b', {}, 'Finished with no saved output'), 'The workflow ran, but no node saved a file.'),
      f && h('div', { class: 'out-actions' },
        job.files.length > 1 && h('button', { onclick: () => { job.shown = ((job.shown || 0) + 1) % job.files.length; renderStage(); } }, `${(job.shown || 0) + 1} / ${job.files.length}`),
        h('a', { href: api.viewUrl(f), download: f.filename }, 'Download')));
  }
  renderStrip();
}

function renderStrip() {
  const strip = $('#strip');
  strip.replaceChildren(...S.jobs.slice(0, 30).map(j => {
    const f = j.files?.[0];
    const b = h('button', {
      class: `thumb${j.status === 'failed' ? ' failed' : ''}`, 'aria-current': j.id === S.current ? 'true' : 'false', title: j.label,
      onclick: () => { S.current = j.id; renderStage(); },
    }, f && f.kind !== 'audio' ? mediaEl(f, false) : j.status === 'done' ? (f ? '♪' : '—') : j.status === 'failed' ? 'failed' : `${Math.round(j.pct * 100)}%`);
    if (j.status === 'running' || j.status === 'queued') b.append(h('i', { class: 'pct', style: `transform:scaleX(${j.pct})` }));
    return b;
  }));
}

// ---------- library (ComfyUI history) ----------
async function renderLibrary() {
  const view = $('#view-library');
  const filter = store.get('lib_filter', 'all');
  view.replaceChildren(h('div', { class: 'page-inner' }, h('h1', {}, 'Library'), h('p', { class: 'lede' }, 'Everything ComfyUI has saved in this session, newest first.'), h('p', { class: 'muted' }, 'Loading…')));
  let items = [];
  try {
    const hist = await api.history();
    items = Object.entries(hist)
      .sort((a, b) => (b[1].status?.messages?.at(-1)?.[1]?.timestamp ?? 0) - (a[1].status?.messages?.at(-1)?.[1]?.timestamp ?? 0))
      .flatMap(([id, e]) => api.outputFiles(e).filter(f => f.type === 'output').map(f => ({ ...f, id })));
  } catch (e) { toast(`Could not read history: ${e.message}`, 'bad'); }
  const shown = items.filter(f => filter === 'all' || f.kind === filter);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' },
    [['all', 'All'], ['video', 'Video'], ['image', 'Images'], ['audio', 'Audio']].map(([k, l]) =>
      h('button', { 'aria-pressed': filter === k ? 'true' : 'false', onclick: () => { store.set('lib_filter', k); renderLibrary(); } }, l)));
  view.replaceChildren(h('div', { class: 'page-inner' },
    h('h1', {}, 'Library'), h('p', { class: 'lede' }, 'Everything ComfyUI has saved in this session, newest first. Files live in ComfyUI’s output folder.'),
    h('div', { class: 'filters' }, seg, h('span', { class: 'muted' }, `${shown.length} file${shown.length === 1 ? '' : 's'}`)),
    shown.length ? h('div', { class: 'gallery' }, shown.map(f => h('button', { class: 'tile', onclick: () => viewFile(f) },
      h('div', { class: 'media' }, f.kind === 'audio' ? h('span', { class: 'muted' }, '♪') : mediaEl(f, false)),
      h('div', { class: 'cap' }, f.filename))))
      : h('div', { class: 'card empty' }, h('b', {}, 'No saved outputs yet'), 'Generate something and it shows up here.')));
}

function viewFile(f) {
  const dlg = $('#dialog');
  dlg.className = 'wide';
  dlg.replaceChildren(h('div', { class: 'viewer' }, mediaEl(f)),
    h('div', { class: 'actions' }, h('span', { class: 'muted spacer' }, f.filename),
      h('a', { class: 'btn', href: api.viewUrl(f), download: f.filename }, 'Download'),
      h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Close')));
  dlg.showModal();
}

// ---------- downloads ----------
let dlTimer = null;
let prefill = null;

async function downloadAll(list) {
  const withUrl = list.filter(x => x.declared?.url || x.url);
  for (const x of withUrl) {
    const d = x.declared || x;
    await startDownload({ url: d.url, directory: d.directory, name: d.name });
  }
  const noUrl = list.filter(x => !(x.declared?.url || x.url));
  if (noUrl.length) {
    prefill = { name: noUrl[0].value, directory: folderFor(noUrl[0]) };
    toast(`${noUrl.length} file${noUrl.length > 1 ? 's have' : ' has'} no download link in the workflow — paste one in Downloads`);
  }
  showTab('downloads');
}

// loader class -> folder, for files without a declared directory
function folderFor(f) {
  const c = `${f.cls} ${f.input}`.toLowerCase();
  if (/lora/.test(c)) return 'loras';
  if (/vae/.test(c)) return 'vae';
  if (/clip|text_encoder|t5/.test(c)) return 'text_encoders';
  if (/unet|diffusion/.test(c)) return 'diffusion_models';
  if (/upscale/.test(c)) return 'upscale_models';
  return 'checkpoints';
}

async function startDownload(body) {
  try {
    await api.post('/studio/api/download', body);
    pollDownloads();
  } catch (e) { toast(`Download not started: ${e.message}`, 'bad'); }
}

async function pollDownloads() {
  clearTimeout(dlTimer);
  let jobs = [];
  try { jobs = await api.get('/studio/api/downloads'); } catch { /* server restarting */ }
  const running = jobs.filter(j => j.state === 'running');
  const c = $('#dl-count');
  c.hidden = !running.length; c.textContent = running.length;
  const box = document.getElementById('dl-jobs');
  if (box) box.replaceChildren(jobsTable(jobs));
  if (running.length) dlTimer = setTimeout(pollDownloads, 1000);
  const finished = jobs.filter(j => j.state === 'done' && !seenDone.has(j.id));
  finished.forEach(j => seenDone.add(j.id));
  if (finished.length && polledOnce) {
    toast(`Downloaded ${finished.map(j => j.name).join(', ')}`, 'good');
    S.info = await api.objectInfo(true);
    if (S.ui) { const vals = S.values; S.fields = deriveFields(S.prompt, S.ui, S.info, S.layout); S.values = vals; renderPanel(); }
    if (!$('#view-downloads').hidden) renderMissing();
  }
  polledOnce = true;
}
const seenDone = new Set();
let polledOnce = false;

function jobsTable(jobs) {
  if (!jobs.length) return h('p', { class: 'muted' }, 'No downloads yet.');
  return h('table', { class: 'list' }, h('tbody', {}, jobs.map(j => {
    const pct = j.total ? j.done / j.total : 0;
    const secs = ((j.ended || Date.now() / 1000) - j.started);
    return h('tr', {},
      h('td', {}, h('div', { class: 'file' }, j.name || j.url), h('div', { class: 'sub' }, j.directory || j.path || '')),
      h('td', { style: 'width:34%' }, j.state === 'running'
        ? h('div', {}, h('div', { class: `bar${j.total ? '' : ' indet'}` }, h('i', { style: j.total ? `width:${pct * 100}%` : '' })),
          h('div', { class: 'sub' }, `${fmtBytes(j.done)}${j.total ? ` of ${fmtBytes(j.total)}` : ''} · ${fmtBytes(j.done / Math.max(secs, 1))}/s`))
        : j.state === 'done' ? h('span', { class: 'badge ok' }, `Done · ${fmtTime(secs)}`) : h('span', { class: 'badge bad', title: j.error }, j.error === 'cancelled' ? 'Cancelled' : `Failed: ${j.error}`)),
      h('td', { style: 'width:80px;text-align:right' }, j.state === 'running' && h('button', { class: 'ghost sm', onclick: async () => { await api.post(`/studio/api/downloads/${j.id}/cancel`); pollDownloads(); } }, 'Cancel')));
  })));
}

async function renderDownloads() {
  const view = $('#view-downloads');
  const { folders, model_root } = await api.get('/studio/api/folders');
  const url = h('input', { type: 'url', placeholder: 'https://huggingface.co/…/resolve/main/model.safetensors', required: true });
  const folder = h('select', {}, folders.map(f => h('option', { value: f, selected: f === (prefill?.directory || 'diffusion_models') }, f)));
  const name = h('input', { type: 'text', placeholder: 'Keep the link’s name', value: prefill?.name || '' });
  prefill = null;
  const repo = h('input', { type: 'text', placeholder: 'owner/name, e.g. tencent/AuK', required: true });
  const repoPath = h('input', { type: 'text', placeholder: '/kaggle/temp/AuK/ckpts/AuK', required: true });

  view.replaceChildren(h('div', { class: 'page-inner' },
    h('h1', {}, 'Downloads'),
    h('p', { class: 'lede' }, 'Files go to ', h('b', {}, model_root || 'ComfyUI’s models folder'), ', in the subfolder you pick. Change the location in Settings.'),
    h('h2', {}, 'Missing models'),
    h('div', { class: 'card', id: 'dl-missing' }, h('p', { class: 'muted' }, 'Scanning your library…')),
    h('h2', {}, 'Download a file'),
    h('form', { class: 'card form-grid', onsubmit: e => { e.preventDefault(); startDownload({ url: url.value.trim(), directory: folder.value, name: name.value.trim() }); url.value = ''; name.value = ''; } },
      h('label', {}, 'Link', url), h('label', {}, 'Folder', folder), h('label', {}, 'Save as', name), h('button', { class: 'go', type: 'submit' }, 'Download')),
    h('h2', {}, 'Download a Hugging Face repo'),
    h('form', { class: 'card form-grid', style: 'grid-template-columns: 1fr 2fr auto', onsubmit: e => { e.preventDefault(); startDownload({ hf_repo: repo.value.trim(), path: repoPath.value.trim() }); } },
      h('label', {}, 'Repo', repo), h('label', {}, 'Into folder', repoPath), h('button', { class: 'go', type: 'submit' }, 'Download')),
    h('h2', {}, 'Activity'),
    h('div', { class: 'card', id: 'dl-jobs' }, h('p', { class: 'muted' }, 'Loading…'))));
  pollDownloads();
  renderMissing();
}

async function renderMissing() {
  const box = document.getElementById('dl-missing');
  if (!box) return;
  let data = {};
  try { data = await api.get('/studio/api/missing'); } catch (e) { box.replaceChildren(h('p', { class: 'muted' }, e.message)); return; }
  // plus: files the current workflow points at that have no declared link (custom quants, LoRAs)
  const extra = S.ui ? missingModelFields(S.fields, declaredModels(S.ui)).filter(f => !f.declared) : [];
  const rows = [];
  for (const [mid, list] of Object.entries(data)) {
    const m = S.library.find(x => x.id === mid);
    for (const x of list) rows.push({ ...x, model: m?.name || mid });
  }
  for (const f of extra) rows.push({ name: f.value, directory: folderFor(f), url: '', model: `${S.model.name} (current workflow)` });
  const seen = new Set();
  const uniq = rows.filter(r => { const k = `${r.directory || r.path}/${r.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!uniq.length) { box.replaceChildren(h('p', {}, h('span', { class: 'badge ok' }, 'All set'), '  Every model your workflows point at is installed.')); return; }
  const withUrl = uniq.filter(r => r.url || r.hf_repo);
  box.replaceChildren(
    h('div', { class: 'filters' }, h('span', { class: 'muted spacer' }, `${uniq.length} missing across your library`),
      withUrl.length > 1 && h('button', { class: 'btn sm', onclick: () => withUrl.forEach(r => startDownload(r.hf_repo ? { hf_repo: r.hf_repo, path: r.path } : { url: r.url, directory: r.directory, name: r.name })) }, `Download all ${withUrl.length}`)),
    h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Used by'), h('th', {}, ''))),
      h('tbody', {}, uniq.map(r => {
        const link = h('input', { type: 'url', placeholder: 'Paste a download link', 'aria-label': `Link for ${r.name}` });
        return h('tr', {},
          h('td', {}, h('div', { class: 'file' }, r.name), h('div', { class: 'sub' }, r.directory || r.path)),
          h('td', { class: 'sub' }, r.model),
          h('td', { style: 'text-align:right;width:40%' }, r.url || r.hf_repo
            ? h('button', { class: 'btn sm', onclick: () => startDownload(r.hf_repo ? { hf_repo: r.hf_repo, path: r.path } : { url: r.url, directory: r.directory, name: r.name }) }, 'Download')
            : h('div', { style: 'display:flex;gap:6px' }, link, h('button', { class: 'btn sm', onclick: () => link.value && startDownload({ url: link.value.trim(), directory: r.directory, name: r.name }) }, 'Download'))));
      }))));
}

// ---------- settings ----------
async function renderSettings() {
  const view = $('#view-settings');
  const s = await api.get('/studio/api/settings');
  const root = h('input', { type: 'text', value: s.model_root, placeholder: '/kaggle/temp/models' });
  const hf = h('input', { type: 'password', placeholder: s.hf_token ? 'Saved — type to replace' : 'hf_…', autocomplete: 'off' });
  const civ = h('input', { type: 'password', placeholder: s.civitai_token ? 'Saved — type to replace' : 'Civitai API key', autocomplete: 'off' });
  view.replaceChildren(h('div', { class: 'page-inner' },
    h('h1', {}, 'Settings'), h('p', { class: 'lede' }, 'Stored on the server running ComfyUI. Tokens are never sent back to the browser.'),
    h('form', { class: 'card stack', onsubmit: async e => {
      e.preventDefault();
      await api.post('/studio/api/settings', { model_root: root.value, hf_token: hf.value, civitai_token: civ.value });
      await api.objectInfo(true);
      toast('Settings saved', 'good');
      renderSettings();
    } },
    h('label', {}, 'Model folder', root, h('span', { class: 'muted' }, 'ComfyUI looks here first, in subfolders like diffusion_models, vae, loras. Downloads land here too.')),
    h('label', {}, 'Hugging Face token', hf, h('span', { class: 'muted' }, 'Needed for gated repos. HF_TOKEN from the environment also works.')),
    h('label', {}, 'Civitai API key', civ),
    h('div', {}, h('button', { class: 'go', type: 'submit' }, 'Save settings'))),
    h('h2', {}, 'ComfyUI'),
    h('div', { class: 'card', style: 'display:flex;gap:8px;flex-wrap:wrap' },
      h('button', { class: 'btn', onclick: async () => { await api.freeMemory(); toast('Models unloaded and memory freed', 'good'); } }, 'Free GPU memory'),
      h('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener' }, 'Open ComfyUI graph editor'),
      h('button', { class: 'btn', onclick: async () => { await api.objectInfo(true); toast('Node and model lists refreshed'); if (S.model) selectWorkflow(S.wfId); } }, 'Refresh model lists'))));
}

// ---------- boot ----------
(async function boot() {
  try {
    await loadLibrary();
    await selectModel(store.get('model'));
  } catch (e) {
    $('#panel-body').replaceChildren(h('div', { class: 'callout warn' }, h('b', {}, 'Could not reach ComfyUI. '), e.message));
  }
  renderStage();
  const tab = store.get('tab', 'generate');
  if (tab !== 'generate') showTab(tab);
  pollDownloads();
})();
