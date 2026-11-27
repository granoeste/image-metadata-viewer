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

/**
 * Resolve a ComfyUI input reference. If the value is a string, return it directly.
 * If it's a link [nodeId, outputIndex], try to resolve the text from the linked node.
 */
function resolveTextInput(prompt: ComfyUIPrompt, value: any): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

/**
 * Extract positive prompt text from CLIPTextEncode nodes.
 * Tries to identify which is positive vs negative by tracing connections to the sampler.
 */
function extractPrompts(prompt: ComfyUIPrompt): { positive: string; negative: string } {
  // Find sampler node to trace positive/negative connections
  const samplerTypes = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'];
  let samplerNode: ComfyUINode | undefined;

  for (const type of samplerTypes) {
    const nodes = findNodes(prompt, type);
    if (nodes.length > 0) {
      samplerNode = nodes[0][1];
      break;
    }
  }

  let positiveNodeId: string | undefined;
  let negativeNodeId: string | undefined;

  if (samplerNode) {
    const posRef = samplerNode.inputs.positive;
    const negRef = samplerNode.inputs.negative;
    if (Array.isArray(posRef)) { positiveNodeId = String(posRef[0]); }
    if (Array.isArray(negRef)) { negativeNodeId = String(negRef[0]); }
  }

  // Collect text from CLIP encode nodes
  const clipEncodeNodes = findNodesContaining(prompt, 'CLIPTextEncode');
  const texts: { id: string; text: string }[] = [];

  for (const [id, node] of clipEncodeNodes) {
    const text = resolveTextInput(prompt, node.inputs.text);
    if (text) {
      texts.push({ id, text: text.trim() });
    }
  }

  // If we traced sampler connections, use them
  if (positiveNodeId || negativeNodeId) {
    // Positive might be connected through intermediate nodes (e.g. ConditioningCombine)
    // Walk through to find actual text
    const positive = findTextForConditioningChain(prompt, positiveNodeId, texts);
    const negative = findTextForConditioningChain(prompt, negativeNodeId, texts);
    return { positive, negative };
  }

  // Fallback: check for ConditioningZeroOut (often used for negative in Flux)
  const zeroOutNodes = findNodes(prompt, 'ConditioningZeroOut');
  const zeroOutInputIds = new Set<string>();
  for (const [, node] of zeroOutNodes) {
    const ref = node.inputs.conditioning;
    if (Array.isArray(ref)) { zeroOutInputIds.add(String(ref[0])); }
  }

  // Texts not feeding into ConditioningZeroOut are likely positive
  const positiveTexts = texts.filter(t => !zeroOutInputIds.has(t.id));
  const negativeTexts = texts.filter(t => zeroOutInputIds.has(t.id));

  return {
    positive: positiveTexts.map(t => t.text).join('\n'),
    negative: negativeTexts.map(t => t.text).join('\n'),
  };
}

/**
 * Walk the conditioning chain from a node ID to find text content.
 */
function findTextForConditioningChain(
  prompt: ComfyUIPrompt,
  nodeId: string | undefined,
  clipTexts: { id: string; text: string }[]
): string {
  if (!nodeId) { return ''; }

  // Direct match: the node itself is a CLIPTextEncode
  const directMatch = clipTexts.find(t => t.id === nodeId);
  if (directMatch) { return directMatch.text; }

  // The node might be an intermediate (ConditioningZeroOut, ConditioningCombine, etc.)
  const node = prompt[nodeId];
  if (!node) { return ''; }

  // Check if it's a zero-out node (empty negative)
  if (node.class_type === 'ConditioningZeroOut') { return ''; }

  // For ConditioningCombine, collect texts from both inputs
  if (node.class_type === 'ConditioningCombine') {
    const texts: string[] = [];
    for (const key of ['conditioning_1', 'conditioning_2']) {
      const ref = node.inputs[key];
      if (Array.isArray(ref)) {
        const text = findTextForConditioningChain(prompt, String(ref[0]), clipTexts);
        if (text) { texts.push(text); }
      }
    }
    return texts.join('\n');
  }

  // Generic: check any input that references a known text node
  for (const value of Object.values(node.inputs)) {
    if (Array.isArray(value)) {
      const text = findTextForConditioningChain(prompt, String(value[0]), clipTexts);
      if (text) { return text; }
    }
  }

  return '';
}

/**
 * Extract generation settings from the sampler and related nodes.
 */
function extractSettings(prompt: ComfyUIPrompt): Record<string, string> {
  const settings: Record<string, string> = {};

  // Sampler settings
  const samplerTypes = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'];
  for (const type of samplerTypes) {
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

  // Image dimensions
  const latentTypes = ['EmptyLatentImage', 'EmptySD3LatentImage'];
  for (const type of latentTypes) {
    const nodes = findNodes(prompt, type);
    if (nodes.length > 0) {
      const inputs = nodes[0][1].inputs;
      if (inputs.width !== undefined) { settings['Width'] = String(inputs.width); }
      if (inputs.height !== undefined) { settings['Height'] = String(inputs.height); }
      if (inputs.batch_size !== undefined && inputs.batch_size > 1) {
        settings['Batch Size'] = String(inputs.batch_size);
      }
      break;
    }
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

export function parseComfyUIPrompt(rawPrompt: string, rawWorkflow: string = ''): ComfyUIMetadata {
  let prompt: ComfyUIPrompt;
  try {
    prompt = JSON.parse(rawPrompt);
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) { throw new Error('invalid'); }
  } catch {
    return {
      positivePrompt: '',
      negativePrompt: '',
      settings: {},
      rawPrompt,
      rawWorkflow,
      nodes: [],
    };
  }

  const { positive, negative } = extractPrompts(prompt);
  const settings = extractSettings(prompt);
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
