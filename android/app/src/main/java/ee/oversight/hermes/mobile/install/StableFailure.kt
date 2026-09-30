package ee.oversight.hermes.mobile.install

/**
 * Stable one-line failure string for plugin rejections: a machine-stable
 * code first, then the exception message. Never returns blank.
 */
fun stableFailure(e: Throwable, code: String): String {
  val detail = (e.message ?: e.toString()).trim().take(220)
  return if (detail.isEmpty()) code else "$code: $detail"
}
