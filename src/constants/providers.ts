// Static catalog. OFFLINE FALLBACK ONLY: the gateway live catalog from
// GET /api/model/options is the single source of truth and must be queried
// first. Use these entries only when the gateway is unreachable or returns
// no models for a configured provider. Do not treat this list as live data
// and do not add/remove ids here to mirror the server; update the gateway.

export const STATIC_CATALOG_SOURCE = 'offline-fallback' as const;

export type ProviderCatalogSource = 'live' | 'offline-fallback';

export interface StaticProviderEntry {
  id: string;
  label: string;
  source: typeof STATIC_CATALOG_SOURCE;
}

export const PROVIDER_OPTIONS: Array<[string, string]> = [
  ['openrouter', 'OpenRouter'],
  ['mixture-of-agents', 'Mixture of Agents'],
  ['deepseek', 'DeepSeek'],
  ['opencode-go', 'OpenCode Go'],
  ['opencode-zen', 'OpenCode Zen'],
  ['openai-api', 'OpenAI API'],
  ['anthropic', 'Anthropic'],
  ['gemini', 'Google AI Studio'],
  ['xai', 'xAI'],
  ['kimi-coding', 'Kimi / Moonshot'],
  ['kimi-coding-cn', 'Kimi / Moonshot (China)'],
  ['zai', 'Z.AI / GLM'],
  ['minimax', 'MiniMax'],
  ['minimax-cn', 'MiniMax (China)'],
  ['alibaba', 'Qwen Cloud'],
  ['alibaba-coding-plan', 'Alibaba Cloud (Coding Plan)'],
  ['nvidia', 'NVIDIA NIM'],
  ['ai-gateway', 'Vercel AI Gateway'],
  ['kilocode', 'Kilo Code'],
  ['huggingface', 'Hugging Face'],
  ['xiaomi', 'Xiaomi MiMo'],
  ['tencent-tokenhub', 'Tencent TokenHub'],
  ['tencent-tokenplan', 'Tencent TokenPlan'],
  ['ollama-cloud', 'Ollama Cloud'],
  ['lmstudio', 'LM Studio'],
  ['copilot', 'GitHub Copilot'],
  ['stepfun', 'StepFun Step Plan'],
  ['arcee', 'Arcee AI'],
  ['gmi', 'GMI Cloud'],
  ['actual', 'Actual Computer'],
  ['azure-foundry', 'Azure Foundry'],
];

export const PROVIDER_ALIASES: Record<string, string> = {
  glm: 'zai',
  'z-ai': 'zai',
  'z.ai': 'zai',
  zhipu: 'zai',
  google: 'gemini',
  'google-gemini': 'gemini',
  'google-ai-studio': 'gemini',
  'x-ai': 'xai',
  'x.ai': 'xai',
  grok: 'xai',
  kimi: 'kimi-coding',
  'kimi-for-coding': 'kimi-coding',
  moonshot: 'kimi-coding',
  'kimi-cn': 'kimi-coding-cn',
  'moonshot-cn': 'kimi-coding-cn',
  step: 'stepfun',
  'stepfun-coding-plan': 'stepfun',
  'arcee-ai': 'arcee',
  arceeai: 'arcee',
  'gmi-cloud': 'gmi',
  gmicloud: 'gmi',
  'actual-computer': 'actual',
  actualcomputer: 'actual',
  aci: 'actual',
  'minimax-china': 'minimax-cn',
  minimax_cn: 'minimax-cn',
  alibaba_coding: 'alibaba-coding-plan',
  'alibaba-coding': 'alibaba-coding-plan',
  alibaba_coding_plan: 'alibaba-coding-plan',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  github: 'copilot',
  'github-copilot': 'copilot',
  'github-models': 'copilot',
  'github-model': 'copilot',
  aigateway: 'ai-gateway',
  vercel: 'ai-gateway',
  'vercel-ai-gateway': 'ai-gateway',
  opencode: 'opencode-zen',
  zen: 'opencode-zen',
  hf: 'huggingface',
  'hugging-face': 'huggingface',
  'huggingface-hub': 'huggingface',
  mimo: 'xiaomi',
  'xiaomi-mimo': 'xiaomi',
  tencent: 'tencent-tokenhub',
  tokenhub: 'tencent-tokenhub',
  'tencent-cloud': 'tencent-tokenhub',
  tencentmaas: 'tencent-tokenhub',
  tokenplan: 'tencent-tokenplan',
  'tencent-lkeap': 'tencent-tokenplan',
  go: 'opencode-go',
  'opencode-go-sub': 'opencode-go',
  opencode_go: 'opencode-go',
  'opencode-go-api': 'opencode-go',
  kilo: 'kilocode',
  'kilo-code': 'kilocode',
  'kilo-gateway': 'kilocode',
  'lm-studio': 'lmstudio',
  lm_studio: 'lmstudio',
};

export const KNOWN_PROVIDERS = new Set(PROVIDER_OPTIONS.map(([id]) => id));

export function normProvider(p: string): string {
  const slug = p.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return PROVIDER_ALIASES[slug] || slug;
}

export function keysValid(provider: string, key: string, baseUrl: string): boolean {
  // Empty provider names nothing: never substitute a default here. A caller
  // with no provider configured must read invalid, not inherit deepseek.
  const p = normProvider(provider).trim();
  if (!p) return false;
  if (KEYLESS_PROVIDERS.has(p)) return true;
  if (!key.trim()) return false;
  return KNOWN_PROVIDERS.has(p) || baseUrl.trim().length > 0;
}

export const KEYLESS_PROVIDERS = new Set(['lmstudio', 'ollama-cloud']);

// Human label for a provider id, for anywhere a user reads a provider name.
// The raw id is never the label: an id with no catalog entry is turned into
// words ('my-proxy' -> 'My Proxy') so no slug is ever shown to the user.
export function providerLabel(id: string): string {
  const norm = normProvider(id);
  const known = PROVIDER_OPTIONS.find(([pid]) => pid === norm);
  if (known) return known[1];
  const words = norm.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return 'Provider';
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export const DEFAULT_MODELS: Record<string, string[]> = {
  openrouter: [
    'anthropic/claude-fable-5.1',
    'anthropic/claude-fable-5',
    'anthropic/claude-opus-5.5',
    'anthropic/claude-opus-5',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-3-7-sonnet',
    'anthropic/claude-3-5-sonnet',
    'deepseek/deepseek-r1',
    'deepseek/deepseek-chat',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/o3-mini',
    'google/gemini-2.5-pro',
    'meta-llama/llama-3.3-70b-instruct',
    'qwen/qwen-2.5-72b-instruct',
  ],
  'mixture-of-agents': [
    'moa/hermes-swarm-ultra',
    'moa/deepseek-claude-hybrid',
    'moa/reasoning-ensemble-v2',
  ],
  deepseek: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'],
  'opencode-go': [
    'deepseek-v4.1-flash',
    'deepseek-v4.1-coder',
    'deepseek-v4.1-reasoner',
    'deepseek-v3',
    'deepseek-r1',
    'deepseek-chat',
    'deepseek-reasoner',
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'gpt-4o',
    'gpt-4o-mini',
    'o3-mini',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'qwen-2.5-coder-32b',
    'meta-llama/llama-3.3-70b-instruct',
  ],
  'opencode-zen': ['opencode-zen/default', 'opencode-zen/auto'],
  xiaomi: ['mimo-v2-flash', 'mimo-v2-thinking-flash'],
  'tencent-tokenhub': ['tokenhub-default', 'tokenhub-plus'],
  'tencent-tokenplan': ['tokenplan-default', 'tokenplan-plus'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash-exp'],
  anthropic: ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'],
  'openai-api': ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1'],
  xai: ['grok-2-latest', 'grok-beta'],
  'kimi-coding': ['moonshot-v1-auto', 'moonshot-v1-8k', 'moonshot-v1-32k'],
  'kimi-coding-cn': ['moonshot-v1-auto', 'moonshot-v1-8k'],
  zai: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  minimax: ['MiniMax-Text-01', 'abab6.5s-chat'],
  'minimax-cn': ['MiniMax-Text-01', 'abab6.5s-chat'],
  alibaba: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  'alibaba-coding-plan': ['qwen-coder-plus', 'qwen-coder-turbo'],
  nvidia: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1'],
  'ai-gateway': ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'],
  kilocode: ['kilo-coder-v1'],
  huggingface: ['meta-llama/Llama-3.3-70B-Instruct', 'mistralai/Mistral-Small-24B-Instruct-2501'],
  'ollama-cloud': ['llama3.3:70b', 'qwen2.5-coder:32b', 'deepseek-r1:32b'],
  lmstudio: ['local-model'],
  copilot: ['gpt-4o', 'claude-3.5-sonnet'],
  stepfun: ['step-2-16k', 'step-1-8k'],
  arcee: ['arcee-super', 'arcee-spark'],
  gmi: ['meta/llama-3.1-405b-instruct'],
  actual: ['actual-default-model'],
  'azure-foundry': ['azure-gpt-4o', 'azure-o1'],
};

// Verified live id for the opencode-go provider. Keep in sync with the
// gateway only; the static list stays as the offline fallback snapshot.
export const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  // Known model-catalog roots for OpenAI-compatible providers: when the base
  // URL field is empty, the direct key test falls back here instead of
  // failing on an empty host. Only providers whose catalog path is certain
  // are listed (deepseek and others stay on the gateway path until verified).
  'openai-api': 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  xai: 'https://api.x.ai/v1',
};
export const OPENCODE_GO_VERIFIED_MODELS: readonly string[] = ['deepseek-v4.1-flash'];

// Static catalog entries tagged as offline fallback. UI lists must label
// these as fallback and must prefer GET /api/model/options (live) first.
export const STATIC_PROVIDER_ENTRIES: StaticProviderEntry[] = PROVIDER_OPTIONS.map(([id, label]) => ({
  id,
  label,
  source: STATIC_CATALOG_SOURCE,
}));

export function formatFallbackDisplayName(id: string): string {
  const parts = id.split('/');
  // The model name is the LAST segment: azure/openai/gpt-4o used to display
  // 'openai' (parts[1]) and drop the actual model identifier.
  const rawName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const clean = rawName
    .replace(/[-_]/g, ' ')
    .replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return clean;
}

// Offline-fallback snapshot of default models. Array copies so callers
// cannot mutate the shared catalog. Source is always offline-fallback.
export function staticModelsFor(provider: string): { models: string[]; source: ProviderCatalogSource } {
  const norm = normProvider(provider);
  const list = DEFAULT_MODELS[norm];
  return { models: list ? [...list] : [], source: STATIC_CATALOG_SOURCE };
}

// Merge helper enforcing gateway-live-first: live models win when the live
// list is non-empty; the static snapshot is used only as fallback.
export function resolveModelsLiveFirst(
  liveModels: string[],
  provider: string
): { models: string[]; source: ProviderCatalogSource } {
  if (liveModels.length > 0) return { models: [...liveModels], source: 'live' };
  return staticModelsFor(provider);
}
