package ee.oversight.hermes.mobile.install

import java.io.File

/**
 * Adds the missing CORS header to the gateway's streaming (SSE) responses.
 *
 * The gateway env `API_SERVER_CORS_ORIGINS` is honored by the request
 * middleware, but the two streaming handlers build their own
 * `web.StreamResponse` and call `await response.prepare(request)` directly,
 * so those replies leave without an `Access-Control-Allow-Origin` header.
 * The WebView runs on https://localhost, so the browser blocks every streamed
 * answer: curl gets a 200 with a body while the app still looks offline.
 *
 * This inserts exactly one header line in front of each streaming prepare()
 * call and keeps [Bootstrap]'s env var for the routes the middleware already
 * covers.
 *
 * Defensive contract: it only writes when the file has at least one streaming
 * prepare() call, it verifies the header count and line delta match the
 * number of call sites before swapping, and the candidate is compiled by the
 * rootfs python before it is allowed to replace the original. A file without
 * any call site, or one that no longer parses, is reported and left as it was,
 * so a changed gateway file is never corrupted or replaced by something that
 * cannot start, and a miss must never stop the gateway from starting.
 */
object ApiServerCorsPatch {
  /** Path of the gateway file inside the extracted rootfs. */
  private const val RELATIVE = "opt/hermes-agent/gateway/platforms/api_server.py"
  /** Prefix of our inserted line; also the already-patched marker. */
  private const val MARKER = "response.headers.update(self._cors_headers_for_origin"
  /** The two streaming call sites this patch lines up with. */
  private const val PREPARE = "await response.prepare(request)"
  private const val HEADER =
    "response.headers.update(self._cors_headers_for_origin(request.headers.get(\"Origin\", \"\")) or {})"

  /** Possible outcomes of one [apply] call. */
  enum class Outcome { APPLIED, ALREADY, MISSING, ABORTED }

  /**
   * Guest path of [hostFile] (the rootfs is mounted at / inside proot), or
   * null when it does not live under [rootfs]. Lets the caller compile the
   * candidate from inside the guest without knowing where this patch keeps it.
   */
  fun guestPath(rootfs: File, hostFile: File): String? {
    val root = rootfs.absolutePath
    val path = hostFile.absolutePath
    if (!path.startsWith(root)) return null
    val rel = path.removePrefix(root).replace('\\', '/')
    return if (rel.startsWith("/")) rel else "/$rel"
  }

  /**
   * Apply the patch under [rootfs]; never throws.
   *
   * [syntaxCheck] must compile the candidate BEFORE it replaces the original:
   * the rootfs ships a python3, the phone has none, so the caller runs the
   * check in the guest. A failing or unavailable check puts the pristine
   * backup back and reports [Outcome.ABORTED] instead of handing the gateway a
   * file it cannot start (a gateway that fails to parse api_server.py never
   * serves anything, which is worse than an unpatched CORS header). A null
   * [syntaxCheck] skips the check; only JVM unit tests use that.
   */
  fun apply(rootfs: File, syntaxCheck: ((File) -> Boolean)? = null): Outcome = try {
    run(rootfs, syntaxCheck)
  } catch (_: Exception) {
    Outcome.ABORTED
  }

  private fun run(rootfs: File, syntaxCheck: ((File) -> Boolean)?): Outcome {
    val file = File(rootfs, RELATIVE)
    if (!file.isFile) return Outcome.MISSING
    val text = file.readText()
    // Idempotent: our own line starts with MARKER, and the stock file only
    // uses the helper at the definition and inside the middleware adapter.
    if (text.contains(MARKER)) return Outcome.ALREADY
    val lines = text.split('\n')
    val prepareCount = lines.count { it.contains(PREPARE) }
    if (prepareCount == 0) return Outcome.ABORTED
    val out = ArrayList<String>(lines.size + prepareCount)
    for (line in lines) {
      if (line.contains(PREPARE)) {
        // Same indent as the statement it precedes, so the block stays valid.
        val indent = line.takeWhile { it == ' ' || it == '\t' }
        out.add(indent + HEADER)
      }
      out.add(line)
    }
    val patched = out.joinToString("\n")
    if (out.size != lines.size + prepareCount) return Outcome.ABORTED
    if (patched.split(MARKER).size - 1 != prepareCount) return Outcome.ABORTED
    // One backup of the pristine file, then an atomic-looking swap: write the
    // side file first so a crash mid-write cannot leave a half file behind.
    val parent = file.parentFile ?: return Outcome.ABORTED
    val bak = File(parent, "${file.name}.corsfix.bak")
    if (!bak.exists()) file.copyTo(bak, overwrite = false)
    val tmp = File(parent, "${file.name}.corspatch.tmp")
    tmp.writeText(patched)
    // Compile before the swap: a candidate that python cannot parse must never
    // become api_server.py, because a syntax error takes the whole gateway
    // down. On refusal the pristine backup goes back over the target and the
    // side file is dropped, so the install is exactly as it was found.
    val ok = try { syntaxCheck?.invoke(tmp) ?: true } catch (_: Throwable) { false }
    if (!ok) {
      try { tmp.delete() } catch (_: Exception) { }
      try { if (bak.exists()) bak.copyTo(file, overwrite = true) } catch (_: Exception) { }
      return Outcome.ABORTED
    }
    if (!tmp.renameTo(file)) {
      file.writeText(patched)
      tmp.delete()
    }
    return Outcome.APPLIED
  }
}
