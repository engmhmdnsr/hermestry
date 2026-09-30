package ee.oversight.hermes.mobile.install

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ApiServerCorsPatchTest {
  private val sample = listOf(
    "class Handler:",
    "    async def stream(self, request):",
    "        response = web.StreamResponse()",
    "        await response.prepare(request)",
    "        return response",
    "",
    "    async def chat(self, request):",
    "        response = web.StreamResponse()",
    "        await response.prepare(request)",
    "        return response",
    "",
  ).joinToString("\n")

  private fun rootfsWith(content: String?): File {
    val root = File(
      System.getProperty("java.io.tmpdir"),
      "corspatch-${System.nanoTime()}"
    )
    val dir = File(root, "opt/hermes-agent/gateway/platforms")
    dir.mkdirs()
    if (content != null) File(dir, "api_server.py").writeText(content)
    return root
  }

  private fun target(root: File): File =
    File(root, "opt/hermes-agent/gateway/platforms/api_server.py")

  @Test
  fun insertsHeaderBeforeEveryStreamingPrepare() {
    val root = rootfsWith(sample)
    val file = target(root)
    val before = file.readText()

    assertEquals(ApiServerCorsPatch.Outcome.APPLIED, ApiServerCorsPatch.apply(root))

    val lines = file.readText().split('\n')
    assertEquals(before.split('\n').size + 2, lines.size)
    val headerLines = lines.filter { it.contains("response.headers.update(self._cors_headers_for_origin") }
    assertEquals(2, headerLines.size)
    // Every header line sits directly above a prepare() call at the same indent.
    lines.forEachIndexed { i, line ->
      if (line.contains("await response.prepare(request)")) {
        assertTrue("header missing above prepare at line $i", i > 0)
        assertEquals(line.takeWhile { it == ' ' || it == '\t' }, lines[i - 1].takeWhile { it == ' ' || it == '\t' })
        assertTrue(lines[i - 1].contains("response.headers.update(self._cors_headers_for_origin"))
      }
    }
    // Pristine backup kept once.
    assertTrue(File(file.parentFile, "api_server.py.corsfix.bak").exists())
    assertEquals(sample, File(file.parentFile, "api_server.py.corsfix.bak").readText())
  }

  @Test
  fun secondRunIsIdempotent() {
    val root = rootfsWith(sample)
    assertEquals(ApiServerCorsPatch.Outcome.APPLIED, ApiServerCorsPatch.apply(root))
    val once = target(root).readText()
    assertEquals(ApiServerCorsPatch.Outcome.ALREADY, ApiServerCorsPatch.apply(root))
    assertEquals(once, target(root).readText())
  }

  @Test
  fun oneStreamingSiteStillGetsPatched() {
    val one = "def x():\n    await response.prepare(request)\n"
    val root = rootfsWith(one)
    assertEquals(ApiServerCorsPatch.Outcome.APPLIED, ApiServerCorsPatch.apply(root))
    val lines = target(root).readText().split('\n')
    assertEquals(one.split('\n').size + 1, lines.size)
    assertEquals(1, lines.count { it.contains("response.headers.update(self._cors_headers_for_origin") })
  }

  @Test
  fun fileWithoutStreamingSitesIsLeftUntouched() {
    val none = "def x():\n    pass\n"
    val root = rootfsWith(none)
    assertEquals(ApiServerCorsPatch.Outcome.ABORTED, ApiServerCorsPatch.apply(root))
    assertEquals(none, target(root).readText())
  }

  @Test
  fun missingFileReportsMissing() {
    val root = rootfsWith(null)
    assertEquals(ApiServerCorsPatch.Outcome.MISSING, ApiServerCorsPatch.apply(root))
  }
}
