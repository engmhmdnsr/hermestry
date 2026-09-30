package ee.oversight.hermes.mobile.install

/**
 * Quotes one fragment of a command line for /bin/sh inside the guest.
 *
 * Bootstrap.runProot() passes its command to `/usr/bin/sh -c`, so anything
 * built here (paths, `-c` probes) has to survive a shell parse. Wrapping in
 * single quotes makes every character literal except `'` itself, which is
 * closed, escaped and reopened (`'\''`).
 *
 * Pure JVM, no Android dependencies: unit-testable on the host.
 */
fun shQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
