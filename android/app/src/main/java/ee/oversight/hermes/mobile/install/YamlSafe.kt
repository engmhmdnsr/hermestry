package ee.oversight.hermes.mobile.install

/**
 * Safe substitution helpers for the rendered config.yaml.
 *
 * [Bootstrap.renderConfig] fills a template with values the user controls
 * (provider id, model id, base URL, API key). A raw `"` closes the quoted
 * scalar it sits in and a raw newline starts a new document line, so one
 * pasted model name or URL used to be able to break, or rewrite, the whole
 * gateway config. Every value therefore goes through [yamlScalar] (quoted
 * positions) or [yamlSlug] (the mapping-key position), and [fillTemplate]
 * substitutes in a single pass so text that merely *looks* like a placeholder
 * can never be expanded a second time.
 *
 * Pure JVM, no Android dependencies: safe to unit-test on the host.
 */

/**
 * Escapes [value] for the inside of a double-quoted YAML scalar.
 *
 * Backslashes and quotes are escaped; every other character is kept as-is
 * except C0 control characters and DEL, which are illegal inside a quoted
 * scalar and are dropped rather than escaped (a newline in a model id must
 * not become a line break in config.yaml).
 */
fun yamlScalar(value: String): String {
  val out = StringBuilder(value.length)
  for (ch in value) {
    when {
      ch == '\\' -> out.append("\\\\")
      ch == '"' -> out.append("\\\"")
      ch < ' ' || ch == '\u007f' -> Unit // dropped
      else -> out.append(ch)
    }
  }
  return out.toString()
}

/**
 * Reduces [value] to a plain YAML scalar that is safe in BOTH positions
 * __PROVIDER__ occupies: a mapping key (`  myprov: ...`, unquoted) and the
 * inside of a double-quoted scalar (`provider: "myprov"`). Anything that can
 * end the key early (`:`, `#`, quotes, flow indicators, whitespace, control
 * characters) is dropped; letters, digits, `.`, `_` and `-` survive, which is
 * exactly the shape of every registry id and of normProvider()'s output.
 */
fun yamlSlug(value: String): String = buildString(value.length) {
  for (ch in value) {
    if (ch in 'a'..'z' || ch in 'A'..'Z' || ch in '0'..'9' ||
      ch == '.' || ch == '_' || ch == '-'
    ) append(ch)
  }
}

/**
 * Replaces every `__PLACEHOLDER__` in [template] from [values] in ONE pass.
 *
 * A chain of String.replace() rescans the text it just inserted, so a value
 * carrying a placeholder-looking substring (or the api-key line, which used to
 * contain a literal __API_KEY__ that a later replace had to fill) was expanded
 * again with the wrong value. A single scan cannot rescan: [values] are
 * inserted verbatim and never re-examined. Unmatched placeholders pass through
 * unchanged, so a template edit fails loudly in the file instead of silently
 * dropping a value.
 */
fun fillTemplate(template: String, values: Map<String, String>): String =
  TEMPLATE_PLACEHOLDER.replace(template) { m -> values[m.value] ?: m.value }

/**
 * Assembles the finished config.yaml text from [template] and the values the
 * user controls. Bootstrap.renderConfig() only reads the prefs and writes the
 * file, so every escaping and indentation rule lives here, where the host
 * unit tests can pin it down.
 *
 * @param registryProvider true for providers that take their key from env only,
 *   which must never get a plaintext `api_key` line in the file.
 */
fun renderGatewayConfig(
  template: String,
  provider: String,
  model: String,
  baseUrl: String,
  apiKey: String,
  registryProvider: Boolean
): String {
  // Registry ids read their key from env (service export); writing api_key
  // for them is dead config plus a plaintext secret. Customs need it.
  val apiKeyLine = if (registryProvider) ""
  else "\n        api_key: \"${yamlScalar(apiKey)}\""
  // Indentation matters as much as quoting: the provider's api_key and
  // base_url are appended to "  <prov>:" (indent 8 nests under it), while the
  // model base_url is appended to "  default: ..." and must stay at indent 2.
  // The old 6-space indent made every config with a custom base URL fail to
  // parse at all.
  val providerBaseUrlLine =
    if (baseUrl.isNotBlank()) "\n        base_url: \"${yamlScalar(baseUrl)}\"" else ""
  val modelBaseUrlLine =
    if (baseUrl.isNotBlank()) "\n  base_url: \"${yamlScalar(baseUrl)}\"" else ""
  // YAML injection (audit hardening): __PROVIDER__ is a mapping key AND a
  // quoted value, so it is reduced to a plain scalar; model and base URL sit
  // inside double quotes and are escaped. A quote or newline in any of them
  // used to be able to break (or rewrite) config.yaml. One pass, so a value
  // that merely looks like a placeholder is never expanded twice.
  return fillTemplate(template, mapOf(
    "__PROVIDER__" to yamlSlug(provider),
    "__MODEL__" to yamlScalar(model),
    "__API_KEY_LINE__" to apiKeyLine,
    "__API_KEY__" to yamlScalar(apiKey),
    "__BASE_URL_LINE__" to providerBaseUrlLine,
    "__MODEL_BASE_URL_LINE__" to modelBaseUrlLine
  ))
}

/** Any `__UPPER_SNAKE__` run inside the config template. */
private val TEMPLATE_PLACEHOLDER = Regex("__[A-Z]+(?:_[A-Z]+)*__")
