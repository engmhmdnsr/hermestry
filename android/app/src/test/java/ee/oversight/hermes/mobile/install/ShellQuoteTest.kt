package ee.oversight.hermes.mobile.install

import org.junit.Assert.assertEquals
import org.junit.Test

/** Quoting rules for the /bin/sh command lines Bootstrap.runProot() runs. */
class ShellQuoteTest {
  @Test
  fun wrapsTheFragmentInSingleQuotes() {
    assertEquals("'/usr/bin/python3'", shQuote("/usr/bin/python3"))
  }

  @Test
  fun anEmbeddedSingleQuoteIsClosedEscapedReopened() {
    // /bin/sh spelling of a'b
    assertEquals("'a'\\''b'", shQuote("a'b"))
  }

  @Test
  fun shellMetacharactersStayLiteral() {
    assertEquals("'a;$(b) | & > x'", shQuote("a;$(b) | & > x"))
    assertEquals("''", shQuote(""))
  }
}
