// Thin client for ComfyUI's HTTP + websocket API.

export const clientId = (() => {
  try { return sessionStorage.cs_client ||= crypto.randomUUID(); } catch { return crypto.randomUUID(); }
})();

async function req(path, opts = {}) {
  const r = await fetch(path, opts);
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const err = new Error(body?.error?.message || (typeof body === 'string' ? body : r.statusText));
    err.status = r.status; err.body = body;
    throw err;
  }
  return body;
}

export const get = path => req(path);
export const post = (path, data) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });
export const del = path => req(path, { method: 'DELETE' });

let infoCache = null;
export const objectInfo = (fresh = false) => (!fresh && infoCache) || (infoCache = get('/object_info').catch(e => { infoCache = null; throw e; }));

export const queuePrompt = (prompt, workflow) =>
  post('/prompt', { prompt, client_id: clientId, extra_data: { extra_pnginfo: { workflow } } });

export const interrupt = () => post('/interrupt');
export const freeMemory = () => post('/free', { unload_models: true, free_memory: true });
export const history = id => get(id ? `/history/${id}` : '/history?max_items=200');
export const queueState = () => get('/queue');

export async function upload(file) {
  const fd = new FormData();
  fd.append('image', file, file.name);
  fd.append('type', 'input');
  fd.append('overwrite', 'true');
  const r = await req('/upload/image', { method: 'POST', body: fd });
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

export const viewUrl = ({ filename, subfolder = '', type = 'output' }) =>
  `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;

export function inputUrl(value) {
  const i = value.lastIndexOf('/');
  return viewUrl({ filename: value.slice(i + 1), subfolder: i > 0 ? value.slice(0, i) : '', type: 'input' });
}

/** Flatten a history entry's outputs into [{filename, subfolder, type, kind}] */
export function outputFiles(entry) {
  const files = [];
  for (const out of Object.values(entry?.outputs || {})) {
    for (const [k, list] of Object.entries(out)) {
      if (!Array.isArray(list)) continue;
      for (const f of list) if (f && f.filename) files.push({ ...f, kind: kindOf(f.filename, k) });
    }
  }
  const saved = files.filter(f => f.type === 'output');
  return saved.length ? saved : files;
}

export function kindOf(name, key = '') {
  if (/\.(mp4|webm|mov|mkv|gif)$/i.test(name) || key === 'gifs' || key === 'video') return /\.gif$/i.test(name) ? 'image' : 'video';
  if (/\.(wav|flac|mp3|ogg|m4a|opus)$/i.test(name) || key === 'audio') return 'audio';
  if (/\.(png|jpe?g|webp|avif|bmp)$/i.test(name)) return 'image';
  return 'file';
}

/** Websocket with auto-reconnect. handlers: {open, close, message(type,data), preview(blobUrl)} */
export function connect(handlers) {
  let ws, timer;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?clientId=${clientId}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => handlers.open?.();
    ws.onclose = () => { handlers.close?.(); clearTimeout(timer); timer = setTimeout(open, 2000); };
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        handlers.message?.(m.type, m.data);
        return;
      }
      const view = new DataView(e.data);
      const event = view.getUint32(0);
      let offset = 8;
      if (event === 4) offset = 8 + view.getUint32(4); // preview with metadata: [type][metaLen][meta][image]
      else if (event !== 1) return;
      const blob = new Blob([e.data.slice(offset)]); // <img> sniffs png/jpeg/webp itself
      handlers.preview?.(URL.createObjectURL(blob));
    };
  };
  open();
  return () => ws?.close();
}
