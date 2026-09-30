// One model-name resolver for every screen (Home hero chip, chat identity
// row, header chip). Home used to title-case ids itself while Chat used a
// third rule, so the same model could print two different names in one
// session. The signature is deliberately settings-only so any screen that
// holds the settings object can call it.
//
// Rules:
//   1. The id's last path segment becomes words: "deepseek-v4.1-flash"
//      reads as "DeepSeek V4.1 Flash" instead of a raw provider token.
//   2. Known initialisms keep their capitals (gpt -> GPT, glm -> GLM).
//   3. A bare provider id (the id IS the provider, no model segment) names
//      no model, so it resolves to an empty string and callers hide their
//      chip rather than inventing a name.
//   4. No id at all is also an empty string, never a fallback model name:
//      the UI must not claim a model that was never configured.

/** Tokens that must not be title-cased like ordinary words. */
const MODEL_INITIALISMS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  glm: 'GLM',
  gpt: 'GPT',
  llm: 'LLM',
};

/** The settings fields this resolver reads; both are optional and nullable. */
export interface ModelLabelSettings {
  modelId?: string | null;
  provider?: string | null;
}

/** Human name for the configured model, or '' when there is none to name. */
export function modelLabel(settings: ModelLabelSettings): string {
  const raw = (settings?.modelId || '').trim();
  if (!raw) return '';
  const seg = raw.split('/').pop() || '';
  if (!seg) return '';
  const provider = (settings?.provider || '').trim().toLowerCase();
  // A bare provider id (no model segment) names the provider, not a model.
  if (seg === raw && seg.toLowerCase() === provider) return '';
  return seg
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const known = MODEL_INITIALISMS[word.toLowerCase()];
      if (known) return known;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}
