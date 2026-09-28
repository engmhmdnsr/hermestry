package ee.oversight.hermes.mobile

/** Full API-key provider catalog, mirrored from Desktop hermes_cli/auth.py
 *  PROVIDER_REGISTRY (OAuth / external-process / AWS-SDK rows excluded:
 *  they cannot work with a pasted key on a phone). */
val PROVIDER_OPTIONS = listOf(
  "deepseek" to "DeepSeek",
  "opencode-go" to "OpenCode Go",
  "opencode-zen" to "OpenCode Zen",
  "openai-api" to "OpenAI API",
  "anthropic" to "Anthropic",
  "gemini" to "Google AI Studio",
  "xai" to "xAI",
  "kimi-coding" to "Kimi / Moonshot",
  "kimi-coding-cn" to "Kimi / Moonshot (China)",
  "zai" to "Z.AI / GLM",
  "minimax" to "MiniMax",
  "minimax-cn" to "MiniMax (China)",
  "alibaba" to "Qwen Cloud",
  "alibaba-coding-plan" to "Alibaba Cloud (Coding Plan)",
  "nvidia" to "NVIDIA NIM",
  "ai-gateway" to "Vercel AI Gateway",
  "kilocode" to "Kilo Code",
  "huggingface" to "Hugging Face",
  "xiaomi" to "Xiaomi MiMo",
  "tencent-tokenhub" to "Tencent TokenHub",
  "tencent-tokenplan" to "Tencent TokenPlan",
  "ollama-cloud" to "Ollama Cloud",
  "lmstudio" to "LM Studio",
  "copilot" to "GitHub Copilot",
  "stepfun" to "StepFun Step Plan",
  "arcee" to "Arcee AI",
  "gmi" to "GMI Cloud",
  "actual" to "Actual Computer",
  "azure-foundry" to "Azure Foundry"
)

/** Desktop _PROVIDER_ALIASES (api-key rows only) so typed shorthands resolve. */
val PROVIDER_ALIASES = mapOf(
  "glm" to "zai", "z-ai" to "zai", "z.ai" to "zai", "zhipu" to "zai",
  "google" to "gemini", "google-gemini" to "gemini", "google-ai-studio" to "gemini",
  "x-ai" to "xai", "x.ai" to "xai", "grok" to "xai",
  "kimi" to "kimi-coding", "kimi-for-coding" to "kimi-coding", "moonshot" to "kimi-coding",
  "kimi-cn" to "kimi-coding-cn", "moonshot-cn" to "kimi-coding-cn",
  "step" to "stepfun", "stepfun-coding-plan" to "stepfun",
  "arcee-ai" to "arcee", "arceeai" to "arcee",
  "gmi-cloud" to "gmi", "gmicloud" to "gmi",
  "actual-computer" to "actual", "actualcomputer" to "actual", "aci" to "actual",
  "minimax-china" to "minimax-cn", "minimax_cn" to "minimax-cn",
  "alibaba_coding" to "alibaba-coding-plan", "alibaba-coding" to "alibaba-coding-plan",
  "alibaba_coding_plan" to "alibaba-coding-plan",
  "claude" to "anthropic", "claude-code" to "anthropic",
  "github" to "copilot", "github-copilot" to "copilot",
  "github-models" to "copilot", "github-model" to "copilot",
  "aigateway" to "ai-gateway", "vercel" to "ai-gateway", "vercel-ai-gateway" to "ai-gateway",
  "opencode" to "opencode-zen", "zen" to "opencode-zen",
  "hf" to "huggingface", "hugging-face" to "huggingface", "huggingface-hub" to "huggingface",
  "mimo" to "xiaomi", "xiaomi-mimo" to "xiaomi",
  "tencent" to "tencent-tokenhub", "tokenhub" to "tencent-tokenhub",
  "tencent-cloud" to "tencent-tokenhub", "tencentmaas" to "tencent-tokenhub",
  "tokenplan" to "tencent-tokenplan", "tencent-lkeap" to "tencent-tokenplan",
  "go" to "opencode-go", "opencode-go-sub" to "opencode-go",
  "kilo" to "kilocode", "kilo-code" to "kilocode", "kilo-gateway" to "kilocode",
  "lm-studio" to "lmstudio", "lm_studio" to "lmstudio"
)

val KNOWN_PROVIDERS: Set<String> = PROVIDER_OPTIONS.map { it.first }.toSet()

/** Normalize typed provider ids: trim, lowercase, whitespace -> dash, aliases -> canonical.
 *  So "OpenCode GO" / "opencode go" / "go" all resolve to "opencode-go". */
fun normProvider(p: String): String {
  val slug = p.trim().lowercase().replace(Regex("\\s+"), "-")
  return PROVIDER_ALIASES[slug] ?: slug
}
