package ee.oversight.hermes.mobile.install

import java.io.File

/**
 * Ships the mobile-only gateway routes that the prebuilt image predates.
 *
 * The app calls GET /api/memory, POST /api/memory/toggle, GET /api/blueprints,
 * POST /api/blueprints/{id}/instantiate, POST /api/providers/validate and the
 * /api/projects set (see gateway.ts and providerValidation.ts), but the baked
 * image's api_server.py serves none of them: every one of those calls answers
 * 404 on a fresh install, which reads in the UI as memory and routines being
 * broken. The routes live in device-patch/api_server_mobile_extras.py; a copy
 * rides in the APK assets under [ASSET_NAME] and this patch drops it next to
 * api_server.py and registers its _http_routes table, guarded so an image that
 * grows the routes natively (or one shaped differently) is left untouched.
 *
 * Defensive contract, mirroring ApiServerCorsPatch: it only writes when the
 * route table carries a known anchor line, it keeps one pristine backup, both
 * files are compiled by the guest python before either replaces its target,
 * and any miss aborts with the install exactly as found. A gateway that fails
 * to parse api_server.py serves nothing, which is worse than missing extras.
 */
object ApiServerExtrasPatch {
  /** Asset file name; tests/check.native.mjs pins it byte-identical to device-patch/. */
  const val ASSET_NAME = "api_server_mobile_extras.py"

  /** Path of the gateway file inside the extracted rootfs. */
  private const val RELATIVE_SERVER = "opt/hermes-agent/gateway/platforms/api_server.py"
  /** Where the extras module lands, next to the file that imports it. */
  private const val RELATIVE_EXTRAS = "opt/hermes-agent/gateway/platforms/api_server_mobile_extras.py"
  /** Presence of our registration; also the idempotency marker. */
  const val MARKER = "api_server_mobile_extras"
  /** Route-table anchors, newest image shape first. */
  private const val PRIMARY_ANCHOR = "routes.extend(_api_runs._http_routes(self))"
  private const val FALLBACK_ANCHOR = "routes.extend(_room_grants._http_routes(self))"
  private const val BACKUP_SUFFIX = ".mobilextras.bak"

  /** Possible outcomes of one [apply] call. */
  enum class Outcome { APPLIED, ALREADY, MISSING, ABORTED }

  /**
   * Guest path of [hostFile] (the rootfs is mounted at / inside proot), or
   * null when it does not live under [rootfs]. Same shape as the CORS patch
   * helper so the caller reuses one compile probe for both files.
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
   * [extrasSource] is the full text of the extras module (read from APK
   * assets by the caller). [syntaxCheck] must compile each candidate BEFORE
   * it replaces its target; a null check skips compilation and is only for
   * JVM unit tests. Any failure restores the pristine files and reports
   * [Outcome.ABORTED].
   */
  fun apply(rootfs: File, extrasSource: String, syntaxCheck: ((File) -> Boolean)? = null): Outcome = try {
    run(rootfs, extrasSource, syntaxCheck)
  } catch (_: Exception) {
    Outcome.ABORTED
  }

  private fun run(rootfs: File, extrasSource: String, syntaxCheck: ((File) -> Boolean)?): Outcome {
    val server = File(rootfs, RELATIVE_SERVER)
    if (!server.isFile) return Outcome.MISSING
    val text = server.readText()
    val registered = text.contains(MARKER)
    val extras = File(rootfs, RELATIVE_EXTRAS)
    val extrasCurrent = extras.isFile && extras.readText() == extrasSource

    var serverCandidate: File? = null
    var extrasCandidate: File? = null
    try {
      if (!registered) {
        val lines = text.split('\n')
        var anchor = lines.indexOfFirst { it.contains(PRIMARY_ANCHOR) }
        if (anchor < 0) anchor = lines.indexOfFirst { it.contains(FALLBACK_ANCHOR) }
        if (anchor < 0) return Outcome.ABORTED
        val indent = lines[anchor].takeWhile { it == ' ' || it == '\t' }
        val out = ArrayList<String>(lines.size + 5)
        out.addAll(lines.subList(0, anchor + 1))
        // Function-level guarded import: self-contained, no import-block hunt,
        // and a future image missing the extras deps degrades to unregistered
        // routes instead of a gateway that cannot start.
        out.add(indent + "try:")
        out.add(indent + "    from gateway.platforms import api_server_mobile_extras as _mobile_extras")
        out.add(indent + "    routes.extend(_mobile_extras._http_routes(self))")
        out.add(indent + "except Exception:")
        out.add(indent + "    pass")
        out.addAll(lines.subList(anchor + 1, lines.size))
        val patched = out.joinToString("\n")
        if (patched.split(MARKER).size - 1 != 1) return Outcome.ABORTED
        serverCandidate = File(server.parentFile, "api_server.py.mobilextras.tmp")
        serverCandidate.writeText(patched)
        val ok = try { syntaxCheck?.invoke(serverCandidate) ?: true } catch (_: Throwable) { false }
        if (!ok) return Outcome.ABORTED
      }
      if (!extrasCurrent) {
        extrasCandidate = File(server.parentFile, "api_server_mobile_extras.py.mobilextras.tmp")
        extrasCandidate.writeText(extrasSource)
        val ok = try { syntaxCheck?.invoke(extrasCandidate) ?: true } catch (_: Throwable) { false }
        if (!ok) return Outcome.ABORTED
      }
      if (serverCandidate == null && extrasCandidate == null) return Outcome.ALREADY
      // Both candidates compiled: swap them in. Pristine backup of the server
      // file is kept once; the extras file is fully owned by this patch, so
      // overwriting it needs no backup.
      val bak = File(server.parentFile, "api_server.py$BACKUP_SUFFIX")
      if (serverCandidate != null && !bak.exists()) server.copyTo(bak, overwrite = false)
      if (!extrasCandidateAdmit(extrasCandidate, extras)) return Outcome.ABORTED
      if (!serverCandidateAdmit(serverCandidate, server)) {
        // Server swap failed after the extras landed: the gateway still
        // starts (registration absent, routes 404 as before), so report the
        // miss instead of pretending success.
        return Outcome.ABORTED
      }
      return Outcome.APPLIED
    } finally {
      try { serverCandidate?.let { if (it.exists() && !filesEqual(it, server)) it.delete() } } catch (_: Exception) { }
      try { extrasCandidate?.let { if (it.exists() && !filesEqual(it, extras)) it.delete() } } catch (_: Exception) { }
    }
  }

  private fun filesEqual(a: File, b: File): Boolean {
    if (!a.isFile || !b.isFile || a.length() != b.length()) return false
    return a.readBytes().contentEquals(b.readBytes())
  }

  private fun extrasCandidateAdmit(candidate: File?, target: File): Boolean {
    if (candidate == null) return true
    return if (candidate.renameTo(target)) true else try {
      target.writeText(candidate.readText())
      candidate.delete()
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun serverCandidateAdmit(candidate: File?, target: File): Boolean {
    if (candidate == null) return true
    return if (candidate.renameTo(target)) true else try {
      target.writeText(candidate.readText())
      candidate.delete()
      true
    } catch (_: Exception) {
      false
    }
  }
}
