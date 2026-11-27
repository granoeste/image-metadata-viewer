export interface ComfyUIMetadata {
  positivePrompt: string;
  negativePrompt: string;
  settings: Record<string, string>;
  rawPrompt: string;
  rawWorkflow: string;
  /** ノードグラフ解析結果（依存順に並ぶ） */
  nodes: ComfyUINodeInfo[];
}

/** ノードの入力リンク（他ノードの出力への参照） */
export interface ComfyUINodeLink {
  input: string;
  fromId: string;
  fromClassType: string;
  fromSlot: number;
}

/** 解析済みノード情報 */
export interface ComfyUINodeInfo {
  id: string;
  classType: string;
  title?: string;
  /** ウィジェット値（リンク以外の入力） */
  params: [string, string][];
  links: ComfyUINodeLink[];
}

interface ComfyUINode {
  inputs: Record<string, any>;
  class_type: string;
  _meta?: { title?: string };
}

type ComfyUIPrompt = Record<string, ComfyUINode>;

/**
 * Find nodes by class type in the ComfyUI prompt graph.
 */
function findNodes(prompt: ComfyUIPrompt, classType: string): [string, ComfyUINode][] {
  return Object.entries(prompt).filter(([, node]) => node.class_type === classType);
}

/**
 * Find nodes whose class_type contains the given substring.
 */
function findNodesContaining(prompt: ComfyUIPrompt, substring: string): [string, ComfyUINode][] {
  return Object.entries(prompt).filter(([, node]) =>
    node.class_type && node.class_type.includes(substring)
  );
}

const SAMPLER_TYPES = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'];

/** テキストを保持する入力名（優先順） */
const TEXT_INPUT_KEYS = ['text', 'prompt', 'value', 'string', 'text_g', 'text_l', 't5xxl', 'clip_l'];

/** 値をそのまま下流へ渡す（パススルー）系ノードの入力名 */
const PASSTHROUGH_INPUT_KEYS = ['source', 'input', 'any', 'anything', 'value', 'text', 'string'];

/** 探索の深さ上限（循環・異常に深いグラフ対策） */
const MAX_DEPTH = 32;

function isLinkRef(value: any): value is [string | number, number] {
  return Array.isArray(value) && value.length === 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number';
}

/**
 * Boolean 入力を解決する（直接値、または PrimitiveBoolean などへのリンク）。
 */
function resolveBoolean(prompt: ComfyUIPrompt, value: any, depth = 0): boolean | undefined {
  if (typeof value === 'boolean') { return value; }
  if (!isLinkRef(value) || depth > MAX_DEPTH) { return undefined; }
  const node = prompt[String(value[0])];
  if (!node) { return undefined; }
  for (const key of ['value', 'boolean']) {
    const v = resolveBoolean(prompt, node.inputs?.[key], depth + 1);
    if (v !== undefined) { return v; }
  }
  return undefined;
}

/**
 * 数値入力を解決する（直接値、または PrimitiveInt などへのリンク）。
 */
function resolveNumber(prompt: ComfyUIPrompt, value: any, depth = 0): number | undefined {
  if (typeof value === 'number') { return value; }
  if (!isLinkRef(value) || depth > MAX_DEPTH) { return undefined; }
  const node = prompt[String(value[0])];
  if (!node) { return undefined; }
  for (const key of ['value', 'int', 'float', 'number']) {
    const v = resolveNumber(prompt, node.inputs?.[key], depth + 1);
    if (v !== undefined) { return v; }
  }
  return undefined;
}

/**
 * テキスト入力を解決する。文字列ならそのまま、リンクならリンク先ノードをたどって文字列を求める。
 * - 条件分岐 (switch / on_true / on_false) は Boolean を評価して実際に使われた側のみたどる
 * - StringReplace / StringConcatenate は結果を計算する
 * - 解決できない場合（LLM 生成テキスト等）は undefined
 */
function resolveText(prompt: ComfyUIPrompt, value: any, depth = 0): string | undefined {
  if (typeof value === 'string') { return value; }
  if (!isLinkRef(value) || depth > MAX_DEPTH) { return undefined; }
  const node = prompt[String(value[0])];
  if (!node || !node.inputs) { return undefined; }
  const inputs = node.inputs;
  const next = (v: any) => resolveText(prompt, v, depth + 1);

  // 条件分岐ノード (ComfySwitchNode 等)
  if ('on_true' in inputs || 'on_false' in inputs) {
    const cond = resolveBoolean(prompt, inputs.switch ?? inputs.boolean ?? inputs.condition);
    if (cond !== undefined) {
      return next(cond ? inputs.on_true : inputs.on_false);
    }
    return next(inputs.on_true) ?? next(inputs.on_false);
  }

  // 文字列置換
  if ('find' in inputs && 'replace' in inputs && 'string' in inputs) {
    const str = next(inputs.string);
    const find = next(inputs.find);
    const replace = next(inputs.replace);
    if (str !== undefined && find !== undefined && replace !== undefined) {
      return find === '' ? str : str.split(find).join(replace);
    }
    return str;
  }

  // 文字列連結
  if ('string_a' in inputs && 'string_b' in inputs) {
    const a = next(inputs.string_a);
    const b = next(inputs.string_b);
    if (a === undefined && b === undefined) { return undefined; }
    const delimiter = typeof inputs.delimiter === 'string' ? inputs.delimiter : '';
    return [a, b].filter((t): t is string => t !== undefined).join(delimiter);
  }

  // テキスト系入力 → パススルー系入力の順に探す
  for (const key of [...TEXT_INPUT_KEYS, ...PASSTHROUGH_INPUT_KEYS]) {
    if (key in inputs) {
      const text = next(inputs[key]);
      if (text !== undefined) { return text; }
    }
  }
  return undefined;
}

/**
 * コンディショニングノードからプロンプトテキストを求める。
 * CLIPTextEncode 以外のエンコーダ（TextEncodeQwenImageEdit, MiniMaxH3ImageConditioning 等）や、
 * 中間ノード（ConditioningCombine, ControlNetApply 等）にも対応する。
 */
function findTextForConditioningChain(
  prompt: ComfyUIPrompt,
  nodeId: string | undefined,
  depth = 0,
  slot = 0,
): string {
  if (!nodeId || depth > MAX_DEPTH) { return ''; }
  const node = prompt[nodeId];
  if (!node || !node.inputs) { return ''; }

  // ゼロアウト（空のネガティブ）
  if (node.class_type === 'ConditioningZeroOut') { return ''; }

  const inputs = node.inputs;
  const walk = (ref: any) =>
    isLinkRef(ref) ? findTextForConditioningChain(prompt, String(ref[0]), depth + 1, ref[1]) : '';

  // positive / negative を両方受けて両方出力するノード（ControlNetApplyAdvanced 等）は
  // 出力スロット 0 = positive, 1 = negative として対応する側をたどる
  if (isLinkRef(inputs.positive) && isLinkRef(inputs.negative)) {
    return walk(slot === 1 ? inputs.negative : inputs.positive);
  }

  // 複数コンディショニングの結合
  const condKeys = Object.keys(inputs).filter(k => /^conditioning_/.test(k) || k === 'conditioning_to' || k === 'conditioning_from');
  if (condKeys.length >= 2) {
    return condKeys.map(k => walk(inputs[k])).filter(Boolean).join('\n');
  }

  // エンコーダ: テキスト系入力を持つノード
  const texts: string[] = [];
  for (const key of TEXT_INPUT_KEYS) {
    if (key in inputs) {
      const text = resolveText(prompt, inputs[key]);
      if (text !== undefined && text.trim() && !texts.includes(text.trim())) {
        texts.push(text.trim());
      }
    }
  }
  if (texts.length > 0) { return texts.join('\n'); }

  // 中間ノード: コンディショニング系入力をたどる
  for (const [key, value] of Object.entries(inputs)) {
    if (/conditioning|^positive$|^negative$|^cond/.test(key)) {
      const text = walk(value);
      if (text) { return text; }
    }
  }
  return '';
}

/**
 * サンプラー（または Guider）の positive / negative 入力のノード ID を求める。
 */
function findSamplerConditioning(
  prompt: ComfyUIPrompt,
): { positiveId?: string; negativeId?: string; positiveSlot: number; negativeSlot: number } {
  for (const type of SAMPLER_TYPES) {
    const nodes = findNodes(prompt, type);
    if (nodes.length === 0) { continue; }
    let inputs = nodes[0][1].inputs || {};
    // SamplerCustomAdvanced → guider (CFGGuider / BasicGuider)
    if (!('positive' in inputs) && isLinkRef(inputs.guider)) {
      inputs = prompt[String(inputs.guider[0])]?.inputs || {};
    }
    const pos = inputs.positive ?? inputs.conditioning;
    const neg = inputs.negative;
    return {
      positiveId: isLinkRef(pos) ? String(pos[0]) : undefined,
      negativeId: isLinkRef(neg) ? String(neg[0]) : undefined,
      positiveSlot: isLinkRef(pos) ? pos[1] : 0,
      negativeSlot: isLinkRef(neg) ? neg[1] : 0,
    };
  }
  return { positiveSlot: 0, negativeSlot: 0 };
}

/**
 * Positive / Negative プロンプトを抽出する。
 * サンプラーの接続をたどって判定し、たどれない場合は CLIPTextEncode 系ノードから推定する。
 */
function extractPrompts(prompt: ComfyUIPrompt): { positive: string; negative: string } {
  const { positiveId, negativeId, positiveSlot, negativeSlot } = findSamplerConditioning(prompt);
  if (positiveId || negativeId) {
    const positive = findTextForConditioningChain(prompt, positiveId, 0, positiveSlot);
    const negative = findTextForConditioningChain(prompt, negativeId, 0, negativeSlot);
    if (positive || negative) {
      return { positive, negative };
    }
  }

  // Fallback: CLIPTextEncode 系ノードのテキスト
  const texts: { id: string; text: string }[] = [];
  for (const [id, node] of findNodesContaining(prompt, 'TextEncode')) {
    const text = findTextForConditioningChain(prompt, id);
    if (text) { texts.push({ id, text }); }
  }

  // ConditioningZeroOut に入るものはネガティブ扱い（Flux 等）
  const zeroOutInputIds = new Set<string>();
  for (const [, node] of findNodes(prompt, 'ConditioningZeroOut')) {
    const ref = node.inputs?.conditioning;
    if (isLinkRef(ref)) { zeroOutInputIds.add(String(ref[0])); }
  }

  return {
    positive: texts.filter(t => !zeroOutInputIds.has(t.id)).map(t => t.text).join('\n'),
    negative: texts.filter(t => zeroOutInputIds.has(t.id)).map(t => t.text).join('\n'),
  };
}

/**
 * Extract generation settings from the sampler and related nodes.
 */
function extractSettings(
  prompt: ComfyUIPrompt,
  imageSize?: { width: number; height: number },
): Record<string, string> {
  const settings: Record<string, string> = {};

  // Sampler settings
  for (const type of SAMPLER_TYPES) {
    const nodes = findNodes(prompt, type);
    if (nodes.length > 0) {
      const inputs = nodes[0][1].inputs;
      if (inputs.seed !== undefined) { settings['Seed'] = String(inputs.seed); }
      if (inputs.steps !== undefined) { settings['Steps'] = String(inputs.steps); }
      if (inputs.cfg !== undefined) { settings['CFG'] = String(inputs.cfg); }
      if (inputs.sampler_name !== undefined) { settings['Sampler'] = String(inputs.sampler_name); }
      if (inputs.scheduler !== undefined) { settings['Scheduler'] = String(inputs.scheduler); }
      if (inputs.denoise !== undefined && inputs.denoise !== 1) { settings['Denoise'] = String(inputs.denoise); }
      break;
    }
  }

  // Image dimensions: Empty*Latent* ノード（EmptyLatentImage, EmptySD3LatentImage 等）
  const latentNodes = Object.values(prompt).filter(node =>
    typeof node.class_type === 'string' && /^Empty.*Latent/.test(node.class_type)
  );
  for (const node of latentNodes) {
    const width = resolveNumber(prompt, node.inputs?.width);
    const height = resolveNumber(prompt, node.inputs?.height);
    if (width === undefined || height === undefined) { continue; }
    settings['Width'] = String(width);
    settings['Height'] = String(height);
    const batch = resolveNumber(prompt, node.inputs?.batch_size);
    if (batch !== undefined && batch > 1) {
      settings['Batch Size'] = String(batch);
    }
    break;
  }
  // 画像編集など潜在画像ノードがない場合は、画像ファイル自体のサイズを使う
  if (!settings['Width'] && imageSize) {
    settings['Width'] = String(imageSize.width);
    settings['Height'] = String(imageSize.height);
  }

  // Model / Checkpoint
  const checkpointNodes = [
    ...findNodes(prompt, 'CheckpointLoaderSimple'),
    ...findNodes(prompt, 'CheckpointLoader'),
    ...findNodes(prompt, 'UNETLoader'),
  ];
  if (checkpointNodes.length > 0) {
    const inputs = checkpointNodes[0][1].inputs;
    const name = inputs.ckpt_name || inputs.unet_name;
    if (name) { settings['Model'] = String(name); }
  }

  // VAE
  const vaeNodes = findNodes(prompt, 'VAELoader');
  if (vaeNodes.length > 0) {
    const name = vaeNodes[0][1].inputs.vae_name;
    if (name) { settings['VAE'] = String(name); }
  }

  // LoRA
  const loraNodes = findNodesContaining(prompt, 'LoraLoader');
  if (loraNodes.length > 0) {
    const loraNames = loraNodes.map(([, node]) => {
      const name = node.inputs.lora_name || '';
      const strength = node.inputs.strength_model;
      return strength !== undefined && strength !== 1
        ? `${name} (${strength})`
        : String(name);
    });
    settings['LoRA'] = loraNames.join(', ');
  }

  // CLIP loader
  const clipLoaders = [
    ...findNodes(prompt, 'CLIPLoader'),
    ...findNodes(prompt, 'DualCLIPLoader'),
  ];
  if (clipLoaders.length > 0) {
    const inputs = clipLoaders[0][1].inputs;
    const names: string[] = [];
    if (inputs.clip_name) { names.push(String(inputs.clip_name)); }
    if (inputs.clip_name1) { names.push(String(inputs.clip_name1)); }
    if (inputs.clip_name2) { names.push(String(inputs.clip_name2)); }
    if (names.length > 0) { settings['CLIP'] = names.join(', '); }
  }

  return settings;
}

function isLink(value: any): value is [string | number, number] {
  return Array.isArray(value) && value.length === 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number';
}

function formatParamValue(value: any): string {
  if (typeof value === 'string') { return value; }
  if (value === null || value === undefined) { return String(value); }
  if (typeof value === 'object') { return JSON.stringify(value); }
  return String(value);
}

/**
 * UI 形式 workflow からノードタイトルを取得（id → title）。
 */
function extractWorkflowTitles(rawWorkflow: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!rawWorkflow) { return titles; }
  try {
    const workflow = JSON.parse(rawWorkflow);
    if (Array.isArray(workflow?.nodes)) {
      for (const node of workflow.nodes) {
        if (node && node.id !== undefined && typeof node.title === 'string') {
          titles.set(String(node.id), node.title);
        }
      }
    }
  } catch {
    // ignore
  }
  return titles;
}

/**
 * ノードグラフを解析し、依存関係順（入力元が先）に並べたノード一覧を返す。
 */
export function analyzeComfyUINodes(prompt: ComfyUIPrompt, rawWorkflow: string = ''): ComfyUINodeInfo[] {
  const workflowTitles = extractWorkflowTitles(rawWorkflow);
  const ids = Object.keys(prompt).filter(id => prompt[id] && typeof prompt[id] === 'object');

  // トポロジカルソート (DFS)。ID 数値順で安定させる
  const byNumericId = (a: string, b: string) => {
    const na = Number(a), nb = Number(b);
    return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
  };
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string) => {
    if (state.has(id) || !prompt[id]) { return; }
    state.set(id, 'visiting');
    for (const value of Object.values(prompt[id].inputs || {})) {
      if (isLink(value)) { visit(String(value[0])); }
    }
    state.set(id, 'done');
    ordered.push(id);
  };
  [...ids].sort(byNumericId).forEach(visit);

  return ordered.map(id => {
    const node = prompt[id];
    const params: [string, string][] = [];
    const links: ComfyUINodeLink[] = [];
    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (isLink(value)) {
        const fromId = String(value[0]);
        links.push({
          input: key,
          fromId,
          fromClassType: prompt[fromId]?.class_type || '(missing)',
          fromSlot: value[1],
        });
      } else {
        params.push([key, formatParamValue(value)]);
      }
    }
    const title = node._meta?.title || workflowTitles.get(id);
    return {
      id,
      classType: String(node.class_type || '(unknown)'),
      title: title && title !== node.class_type ? title : undefined,
      params,
      links,
    };
  });
}

/**
 * @param imageSize 画像ファイル自体のサイズ（グラフからサイズが求まらない場合に使う）
 */
export function parseComfyUIPrompt(
  rawPrompt: string,
  rawWorkflow: string = '',
  imageSize?: { width: number; height: number },
): ComfyUIMetadata {
  let prompt: ComfyUIPrompt;
  try {
    prompt = JSON.parse(rawPrompt);
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) { throw new Error('invalid'); }
  } catch {
    return {
      positivePrompt: '',
      negativePrompt: '',
      settings: imageSize
        ? { Width: String(imageSize.width), Height: String(imageSize.height) }
        : {},
      rawPrompt,
      rawWorkflow,
      nodes: [],
    };
  }

  const { positive, negative } = extractPrompts(prompt);
  const settings = extractSettings(prompt, imageSize);
  const nodes = analyzeComfyUINodes(prompt, rawWorkflow);

  return {
    positivePrompt: positive,
    negativePrompt: negative,
    settings,
    rawPrompt,
    rawWorkflow,
    nodes,
  };
}
