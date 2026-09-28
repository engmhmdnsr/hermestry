package ee.oversight.hermes.mobile.install

/**
 * Pure boot/install failure classifier for the first-run wizard error step.
 *
 * No Android dependencies, safe to unit-test on the JVM. Feed it the
 * visible log lines (vm.log) or one joined blob; it returns a headline for
 * branching plus a one-line user sentence and a suggested action for display.
 */
enum class BootHeadline {
  DISK_FULL,
  PERMISSION,
  PORT_IN_USE,
  INSTALL_MISSING,
  TIMED_OUT,
  UNKNOWN
}

data class BootError(
  val headline: BootHeadline,
  /** One plain-language line shown under the wizard error title. */
  val userLine: String,
  /** One concrete next step shown as the Retry/Export hint. */
  val suggestedAction: String
)

/** Classify from the live log lines (newest last, as vm.log holds them). */
fun classifyBootError(log: List<String>): BootError =
  classifyBootError(log.joinToString("\n"))

/** Classify from a single joined log blob. Matching is case-insensitive. */
fun classifyBootError(logText: String): BootError {
  val t = logText.lowercase()
  fun has(vararg needles: String) = needles.any { it in t }

  if (has("no space left", "enospc", "disk full", "storage full", "not enough space"))
    return BootError(
      BootHeadline.DISK_FULL,
      "The download stopped: your phone is out of storage space.",
      "Free at least 1 GB, then Retry install."
    )
  if (has("permission denied", "eacces", "error=13", "selinux", "operation not permitted", "access denied"))
    return BootError(
      BootHeadline.PERMISSION,
      "The installer was blocked by a file-permission error.",
      "Retry install; if it repeats, Export the log and report it."
    )
  if (has("eaddrinuse", "address already in use", "port in use", "port 8080", ":8080", "bind failed"))
    return BootError(
      BootHeadline.PORT_IN_USE,
      "Hermes could not start: the gateway port is already in use.",
      "Stop the old gateway (Setup > Stop), then Start again."
    )
  if (has("not_installed", "no such file", "enoent", "rootfs", "proot", "hermes-image",
      "404", "checksum", "sha256", "hash mismatch", "download failed", "install failed"))
    return BootError(
      BootHeadline.INSTALL_MISSING,
      "The on-phone install is missing or incomplete.",
      "Check your connection, then Retry install."
    )
  if (has("timed out", "timeout", "still not up", "connection refused", "econnrefused",
      "waiting for localhost", "90s", "poll", "unreachable"))
    return BootError(
      BootHeadline.TIMED_OUT,
      "Hermes took too long to come up and the start timed out.",
      "Skip for now, then open the System tab and check the gateway log."
    )
  return BootError(
    BootHeadline.UNKNOWN,
    "Something went wrong starting Hermes.",
    "Retry, or Export the log from below and report it."
  )
}
