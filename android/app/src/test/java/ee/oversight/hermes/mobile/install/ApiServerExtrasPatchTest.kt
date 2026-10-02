package ee.oversight.hermes.mobile.install

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ApiServerExtrasPatchTest {
  private val extrasSource = listOf(
    "\"\"\"Mobile extras.\"\"\"",
    "",
    "def _http_routes(api):",
    "    return []",
    "",
  ).joinToString("\n")

  private val sample = listOf(
    "from gateway.platforms import api_server_runs as _api_runs",
    "",
    "class Server:",
    "    def _http_route_table(self):",
    "        routes = [",
    "            (\"GET\", \"/api/jobs\", self._handle_list_jobs),",
    "        ]",
    "        routes.extend(_api_runs._http_routes(self))",
    "        return routes",
    "",
  ).joinToString("\n")

  private fun rootfsWith(content: String?): File {
    val root = File(
      System.getProperty("java.io.tmpdir"),
      "extraspatch-${System.nanoTime()}"
    )
    val dir = File(root, "opt/hermes-agent/gateway/platforms")
    dir.mkdirs()
    if (content != null) File(dir, "api_server.py").writeText(content)
    return root
  }

  private fun target(root: File): File =
    File(root, "opt/hermes-agent/gateway/platforms/api_server.py")

  private fun extrasFile(root: File): File =
    File(root, "opt/hermes-agent/gateway/platforms/api_server_mobile_extras.py")

  @Test
  fun registersExtrasAfterKnownAnchor() {
    val root = rootfsWith(sample)
    val before = target(root).readText()

    assertEquals(ApiServerExtrasPatch.Outcome.APPLIED, ApiServerExtrasPatch.apply(root, extrasSource))

    val lines = target(root).readText().split('\n')
    assertEquals(before.split('\n').size + 5, lines.size)
    val anchor = lines.indexOfFirst { it.contains("routes.extend(_api_runs._http_routes(self))") }
    assertTrue("anchor line kept", anchor >= 0)
    // Guarded block sits directly below the anchor at the same indent.
    assertEquals("        try:", lines[anchor + 1])
    assertTrue(lines[anchor + 2].contains("from gateway.platforms import api_server_mobile_extras as _mobile_extras"))
    assertEquals("            routes.extend(_mobile_extras._http_routes(self))", lines[anchor + 3])
    assertEquals("        except Exception:", lines[anchor + 4])
    assertEquals("            pass", lines[anchor + 5])
    // Extras module landed byte-identical.
    assertEquals(extrasSource, extrasFile(root).readText())
    // Pristine backup kept once.
    assertEquals(before, File(target(root).parentFile, "api_server.py.mobilextras.bak").readText())
  }

  @Test
  fun secondRunIsIdempotent() {
    val root = rootfsWith(sample)
    assertEquals(ApiServerExtrasPatch.Outcome.APPLIED, ApiServerExtrasPatch.apply(root, extrasSource))
    val once = target(root).readText()
    assertEquals(ApiServerExtrasPatch.Outcome.ALREADY, ApiServerExtrasPatch.apply(root, extrasSource))
    assertEquals(once, target(root).readText())
    assertEquals(extrasSource, extrasFile(root).readText())
  }

  @Test
  fun staleExtrasFileIsRefreshedWithoutTouchingServer() {
    val root = rootfsWith(sample)
    assertEquals(ApiServerExtrasPatch.Outcome.APPLIED, ApiServerExtrasPatch.apply(root, extrasSource))
    val serverOnce = target(root).readText()
    extrasFile(root).writeText("stale")
    assertEquals(ApiServerExtrasPatch.Outcome.APPLIED, ApiServerExtrasPatch.apply(root, extrasSource))
    assertEquals(serverOnce, target(root).readText())
    assertEquals(extrasSource, extrasFile(root).readText())
  }

  @Test
  fun fileWithoutAnchorIsLeftUntouched() {
    val none = "def x():\n    pass\n"
    val root = rootfsWith(none)
    assertEquals(ApiServerExtrasPatch.Outcome.ABORTED, ApiServerExtrasPatch.apply(root, extrasSource))
    assertEquals(none, target(root).readText())
    assertTrue("no extras file on abort", !extrasFile(root).exists())
  }

  @Test
  fun failingSyntaxCheckAbortsWithoutWriting() {
    val root = rootfsWith(sample)
    assertEquals(ApiServerExtrasPatch.Outcome.ABORTED, ApiServerExtrasPatch.apply(root, extrasSource) { false })
    assertEquals(sample, target(root).readText())
    assertTrue("no extras file on abort", !extrasFile(root).exists())
  }

  @Test
  fun missingFileReportsMissing() {
    val root = rootfsWith(null)
    assertEquals(ApiServerExtrasPatch.Outcome.MISSING, ApiServerExtrasPatch.apply(root, extrasSource))
  }
}
