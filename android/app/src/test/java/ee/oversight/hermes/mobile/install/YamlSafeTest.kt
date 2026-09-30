package ee.oversight.hermes.mobile.install

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host unit tests for the config.yaml rendering rules (audit: YAML injection).
 *
 * The template is a trimmed copy of Bootstrap.configTemplate(): the rules
 * under test are substitution, escaping and indentation, not the comments.
 */
class YamlSafeTest {
  private val template = """
    model:
      provider: "__PROVIDER__"
      default: "__MODEL__"__MODEL_BASE_URL_LINE__
    providers:
      __PROVIDER__:__API_KEY_LINE____BASE_URL_LINE__
  """.trimIndent()

  private fun render(
    provider: String = "myprov",
    model: String = "some-model",
    baseUrl: String = "",
    apiKey: String = "key-1",
    registry: Boolean = false
  ) = renderGatewayConfig(template, provider, model, baseUrl, apiKey, registry)

  @Test
  fun quotesAndNewlinesCannotLeaveTheirScalar() {
    val cfg = render(model = "say \"hi\"\nbye", apiKey = "k\"1")
    // Same render without the newline: identical line count is the proof that
    // the newline was dropped instead of becoming a line of its own.
    val flat = render(model = "say \"hi\"bye", apiKey = "k\"1")

    assertEquals(flat.lines().size, cfg.lines().size)
    assertTrue(cfg.contains("default: \"say \\\"hi\\\"bye\""))
    assertTrue(cfg.contains("api_key: \"k\\\"1\""))
    assertFalse(cfg.contains("bye\nproviders"))
  }

  @Test
  fun aModelCannotSmuggleExtraYamlKeys() {
    val cfg = render(model = "x\"\n    injected: true\n#")
    val flat = render(model = "x\" injected: true #")

    val lines = cfg.lines()
    // Every control character is dropped, so the smuggled keys stay inside the
    // quoted scalar instead of becoming mappings of their own.
    assertEquals(flat.lines().size, lines.size)
    assertFalse(lines.any { it.trimStart().startsWith("injected") })
    // Still exactly the two top-level blocks the template defines.
    assertEquals(1, Regex("(?m)^providers:").findAll(cfg).count())
    assertEquals(1, Regex("(?m)^model:").findAll(cfg).count())
  }

  @Test
  fun hostileProviderIsReducedToASafeSlugInBothPositions() {
    val cfg = render(provider = "ev\"il: #x")

    // __PROVIDER__ is a mapping key AND a quoted value; both get the slug.
    assertTrue(cfg.contains("provider: \"evilx\""))
    assertTrue(cfg.contains("\n  evilx:"))
    assertFalse(cfg.contains("evil\""))
    assertFalse(cfg.contains("#x"))
  }

  @Test
  fun baseUrlLinesUseTheIndentsThatParse() {
    val cfg = render(baseUrl = "https://x.test/v1")

    val lines = cfg.lines()
    val defaultIdx = lines.indexOfFirst { it.startsWith("  default:") }
    assertTrue("default line missing", defaultIdx >= 0)
    // Model-level base_url sits at indent 2, under `model:`. The shipped file
    // used 6 spaces, which PyYAML rejects outright (mapping values are not
    // allowed to start past the parent key's own indent).
    assertEquals("  base_url: \"https://x.test/v1\"", lines[defaultIdx + 1])
    // Provider-level base_url nests under `  myprov:` at indent 8, after the
    // api_key line.
    assertTrue(lines.any { it == "        api_key: \"key-1\"" })
    assertTrue(lines.any { it == "        base_url: \"https://x.test/v1\"" })
  }

  @Test
  fun registryProvidersGetNoKeyLineButCustomsDo() {
    assertFalse(render(registry = true).contains("api_key"))
    assertTrue(render(registry = false).contains("api_key: \"key-1\""))
    // An empty base URL adds no line at all, in either position.
    assertFalse(render().contains("base_url"))
  }

  @Test
  fun aValueThatLooksLikeAPlaceholderIsNeverExpandedTwice() {
    // If substitution were a chain of String.replace() calls, the model value
    // would be rescanned by the __API_KEY_LINE__ replace and grow a second
    // api_key line inside the model block.
    val cfg = render(model = "__API_KEY_LINE__")

    assertTrue(cfg.contains("default: \"__API_KEY_LINE__\""))
    assertEquals(1, Regex("api_key").findAll(cfg).count())
  }

  @Test
  fun adjacentPlaceholdersAreFilledIndependently() {
    assertEquals(
      "A1X2B",
      fillTemplate("A__ONE__X__TWO__B", mapOf("__ONE__" to "1", "__TWO__" to "2"))
    )
    // Back-to-back placeholders: the greedy __[A-Z_]+__ shape used to swallow
    // the whole run as one unknown token and emit it verbatim.
    assertEquals(
      "k-",
      fillTemplate("__A____B__", mapOf("__A__" to "k", "__B__" to "-"))
    )
    // Unknown placeholders survive so a template edit fails loudly on disk.
    assertEquals("__NOPE__", fillTemplate("__NOPE__", emptyMap()))
  }

  @Test
  fun yamlScalarAndSlugHaveTheExpectedShapes() {
    assertEquals("a\\\"b\\\\c", yamlScalar("a\"b\\c"))
    assertEquals("dropped", yamlScalar("d\r\n\u0000ropped"))
    assertEquals("kept-unicode", yamlScalar("kept-unicode"))
    assertEquals("abc._-012", yamlSlug("abc._-012 \t:#\"'[]{}&*!|>`"))
  }
}
