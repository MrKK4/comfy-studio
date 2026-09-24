// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFields, applyValues, missingModelFields, missingNodeTypes, notesOf, specOf } from '../web/adapter.js';

const info = {
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  KSampler: { input: { required: { seed: ['INT', { min: 0, max: 2 ** 53 }], steps: ['INT', { min: 1, max: 100 }], cfg: ['FLOAT', { min: 0, max: 30, step: 0.1 }], sampler_name: [['euler', 'er_sde']], model: ['MODEL'] } } },
  UNETLoader: { input: { required: { unet_name: [['a.safetensors']], weight_dtype: [['default', 'fp8']] } } },
  LoadImage: { input: { required: { image: [['cat.png'], { image_upload: true }] } } },
  PrimitiveInt: { input: { required: { value: ['INT', { min: 1, max: 20 }] } } },
  NewCombo: { input: { required: { mode: ['COMBO', { options: ['x', 'y'] }] } } },
};

const prompt = {
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a red fox', clip: ['4', 1] }, _meta: { title: 'Positive' } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] }, _meta: { title: 'Negative Prompt' } },
  3: { class_type: 'KSampler', inputs: { seed: 5, steps: 8, cfg: 1, sampler_name: 'er_sde', model: ['1', 0] }, _meta: { title: 'KSampler' } },
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'missing.safetensors', weight_dtype: 'default' }, _meta: { title: 'Load Diffusion Model' } },
  10: { class_type: 'LoadImage', inputs: { image: 'cat.png' }, _meta: { title: 'Load Image' } },
  '20:5': { class_type: 'PrimitiveInt', inputs: { value: 5 }, _meta: { title: 'Duration (s)' } },
};
const ui = {
  nodes: [
    { id: 3, type: 'KSampler', pos: [0, 0], widgets_values: [5, 'fixed', 8, 1, 'er_sde'] },
    { id: 20, type: 'sub-1', pos: [0, 0], title: 'Video settings' },
    { id: 50, type: 'MarkdownNote', pos: [0, 10], widgets_values: ['## Set mask to 1.0'] },
    { id: 51, type: 'Note', pos: [0, 5], widgets_values: ['first'] },
    { id: 60, type: 'SetNode', pos: [0, 0] },
    { id: 61, type: 'MVEx_SubjectCrop', pos: [0, 0], properties: { aux_id: 'drozbay/MaskVidExperiments' } },
  ],
  definitions: { subgraphs: [{ id: 'sub-1', name: 'Settings', nodes: [] }] },
};

test('specOf handles legacy and COMBO-v3 combos', () => {
  assert.deepEqual(specOf(info, 'KSampler', 'sampler_name').options, ['euler', 'er_sde']);
  assert.deepEqual(specOf(info, 'NewCombo', 'mode').options, ['x', 'y']);
  assert.equal(specOf(info, 'Nope', 'x'), null);
});

test('roles are assigned sensibly', () => {
  const f = Object.fromEntries(deriveFields(prompt, ui, info).map(x => [x.key, x]));
  assert.equal(f['6.text'].role, 'prompt');
  assert.equal(f['7.text'].negative, true);
  assert.equal(f['3.seed'].role, 'seed');
  assert.equal(f['3.seed'].control, 'fixed');
  assert.equal(f['3.steps'].role, 'setting');
  assert.equal(f['3.sampler_name'].role, 'advanced');
  assert.equal(f['1.unet_name'].role, 'model');
  assert.equal(f['10.image'].role, 'media');
  assert.equal(f['10.image'].upload, 'image');
  assert.equal(f['20:5.value'].role, 'setting');
  assert.equal(f['20:5.value'].label, 'Duration (s)');
  assert.equal(f['20:5.value'].nodeLabel, 'Video settings › Duration (s)');
  assert.ok(!('6.clip' in f), 'linked inputs are not fields');
});

test('positive prompt sorts before negative', () => {
  const ps = deriveFields(prompt, ui, info).filter(x => x.role === 'prompt');
  assert.deepEqual(ps.map(x => x.key), ['6.text', '7.text']);
});

test('layout overrides pin, hide and rename', () => {
  const layout = { fields: { '3.sampler_name': { pin: true, label: 'Sampler' }, '3.steps': { hide: true } } };
  const f = Object.fromEntries(deriveFields(prompt, ui, info, layout).map(x => [x.key, x]));
  assert.equal(f['3.sampler_name'].role, 'setting');
  assert.equal(f['3.sampler_name'].label, 'Sampler');
  assert.equal(f['3.steps'].hidden, true);
});

test('missing models, missing nodes, notes', () => {
  const miss = missingModelFields(deriveFields(prompt, ui, info), { 'missing.safetensors': { url: 'https://x/y' } });
  assert.deepEqual(miss.map(x => x.key), ['1.unet_name']);
  assert.equal(miss[0].declared.url, 'https://x/y');
  assert.deepEqual(missingNodeTypes(ui, info), [
    { type: 'MVEx_SubjectCrop', pack: 'drozbay/MaskVidExperiments' },
  ]);
  assert.deepEqual(notesOf(ui), ['first', '## Set mask to 1.0']);
});

test('applyValues writes into a copy, including subgraph ids', () => {
  const out = applyValues(prompt, { '6.text': 'a blue fox', '20:5.value': 9 });
  assert.equal(out[6].inputs.text, 'a blue fox');
  assert.equal(out['20:5'].inputs.value, 9);
  assert.equal(prompt[6].inputs.text, 'a red fox');
  assert.deepEqual(out[6].inputs.clip, ['4', 1]);
});
