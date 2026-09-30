package ee.oversight.hermes.mobile.install

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Coverage for the part of ApiServerCorsPatch that the original five tests
 * could not see: the pre-swap compile probe handed over by the caller.
 *
 * The contract under test is the one that matters on device: a candidate the
 * rootfs python cannot compile must never reach api_server.py, the pristine
 * backup stays in place, and no scratch file is left behind.
 */
class CorsPatchSyntaxCheckTest {
  private val sample =
    "class Handler:\n    async def stream(self, request):\n" +
      "        await response.prepare(request)\n        return response\n"

  private fun rootfs(): File {
    val root = File.createTempFile("corspatch-check", "")
    root.delete()
    File(root, "opt/hermes-agent/gateway/platforms").mkdirs()
    val target = target(root)
    target.writeText(sample)
    return root
  }

  private fun target(root: File) =
    File(root, "opt/hermes-agent/gateway/platforms/api_server.py")

  @Test
  fun failedCompileCheckKeepsThePristineFile() {
    val root = rootfs()
    val file = target(root)
    val bak = File(file.parentFile, "api_server.py.corsfix.bak")

    assertEquals(ApiServerCorsPatch.Outcome.ABORTED, ApiServerCorsPatch.apply(root) { false })

    assertEquals(sample, file.readText())
    assertEquals(sample, bak.readText())
    assertFalse(File(file.parentFile, "api_server.py.corspatch.tmp").exists())
  }

  @Test
  fun passingCompileCheckAppliesNormally() {
    val root = rootfs()
    val file = target(root)

    assertEquals(ApiServerCorsPatch.Outcome.APPLIED, ApiServerCorsPatch.apply(root) { true })

    assertTrue(file.readText().contains("self._cors_headers_for_origin"))
  }

  @Test
  fun aCheckerThatThrowsIsTreatedAsAFailureNotAnEscape() {
    val root = rootfs()
    val file = target(root)

    assertEquals(ApiServerCorsPatch.Outcome.ABORTED, ApiServerCorsPatch.apply(root) {
      throw IllegalStateException("proot gone")
    })

    assertEquals(sample, file.readText())
    // The abort does not poison a retry: a later run that passes still patches.
    assertEquals(ApiServerCorsPatch.Outcome.APPLIED, ApiServerCorsPatch.apply(root) { true })
    assertTrue(file.readText().contains("self._cors_headers_for_origin"))
  }

  @Test
  fun guestPathIsRootRelativeSoTheGuestPythonCanOpenIt() {
    val root = rootfs()
    val file = target(root)

    assertEquals(
      "/opt/hermes-agent/gateway/platforms/api_server.py",
      ApiServerCorsPatch.guestPath(root, file)
    )
    assertNull(ApiServerCorsPatch.guestPath(root, File(root.parentFile, "outside.py")))
  }
}
