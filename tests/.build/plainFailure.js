// One place where infrastructure failure reasons become user copy.
//
// Machine and platform reasons are logs, not sentences: the Android service
// refuses a background start with "startForegroundService() not allowed due
// to …", a transport failure arrives as "Failed to fetch" / "ECONNREFUSED",
// and the native bridge rethrows its own token ("service_start_blocked").
// None of those belong on screen, so every caller maps its reason through the
// helpers here. This is the single place that decides what a reason means in
// words, so no bare token or raw transport string can reach the UI.
//
// Callers pass their local tx(key, english) resolver. When it is omitted the
// English fallback is returned, which lets the service layer compose plain
// copy without pulling i18n into a transport module.
// English-only resolver for callers with no locale bundle in scope.
const englishOnly = (_key, fallback) => fallback;
// Transport and reachability text that must never surface. Covers the whole
// family of runtime reasons, not just one spelling: Node's "fetch failed"
// (the message a live fetch() rejection carries), DNS ("getaddrinfo
// ENOTFOUND"), the socket codes ("read ECONNRESET", "ETIMEDOUT", "socket
// hang up"), TLS ("unable to verify the first certificate", "self signed")
// and the peer-close wordings ("other side closed", "terminated").
const TRANSPORT_RE = /econnrefused|econnreset|etimedout|econnaborted|epipe|eai_again|ehostunreach|enetunreach|networkerror|network error|failed to fetch|fetch failed|load failed|unreachable|not reachable|timed out|timeout|\boffline\b|net::|::err|err_[a-z]+|errno|unknownhost|getaddrinfo|enotfound|socket hang|socket disconnect|socketexception|sslexception|certificate|cert_|self.?signed|unable to verify|other side closed|\bterminated\b|\babort(?:ed)?\b/i;
// Platform and stack fragments that must never surface. Includes the DOM
// and native exception class names, because those reach user copy verbatim
// when a caller interpolates e.message (quota, security, bridge failures).
const PLATFORM_RE = /\bat\s+\S+\.(?:kt|java):\d+|java\.|kotlin\.|android\.|traceback|\bexception\b|\bhttp:\/\/|127\.0\.0\.1|localhost:\d|\bhttp \d{3}\b|\.log\b|\b(?:type|reference|syntax|range|eval|uri|quotaexceeded|security|invalidstate|dom|notfound|notallowed|notreadable|notsupported|abort|operation|network|timeout|encoding|dataclone|indexsize|invalidcharacter)(?:error|exception)\b|quota has been exceeded|native bridge|bridge unavailable|setserverkey unavailable|install\(\)|exit code|permission denial|\bproot\b|\b(?:eacces|enoent|eperm|eisdir|erofs|enospc)\b|startforegroundservice|toappstrictmode/i;
// Machine identifiers a case-insensitive scan cannot catch without eating
// honest prose: exception class names ("NullPointerException" with its
// detail), dotted package types ("com.example.App$Companion") and shouted
// status tokens ("CAPACITY"). Deliberately case-sensitive: "Agent Error",
// "e.g." and any sentence in the dictionary never match, while camel case
// and ALL CAPS do.
const CLASSNAME_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*Exception\b|\b[A-Za-z_$][A-Za-z0-9_$]*Error\b|\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.[A-Z][A-Za-z0-9_$]*|^[A-Z][A-Z0-9_]{4,}$/;
// A bare machine token: underscores, optional trailing colon, e.g.
// "service_start_blocked", "Service_Start_Blocked" or "not_installed:". Case
// is ignored because the bridge and the Android installers shout some of
// them. A word or a sentence with spaces never matches.
const TOKEN_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+:?$/i;
/** True when the text is transport or reachability noise, never user copy. */
export function isTransportFailure(raw) {
    const s = (raw || '').trim();
    return !!s && TRANSPORT_RE.test(s);
}
/** True when the text is a bare machine token or a platform/stack fragment. */
export function isMachineFailure(raw) {
    const s = (raw || '').trim();
    if (!s)
        return false;
    return TOKEN_RE.test(s) || PLATFORM_RE.test(s) || CLASSNAME_RE.test(s);
}
// Start and connect failures. A native reason is mapped to plain copy; a
// reason that already reads as a sentence passes through so honest messages
// keep their words.
export function plainGatewayFailure(raw, tx = englishOnly) {
    const s = (raw || '').trim();
    if (!s)
        return tx('startFailedPlain', 'Could not start Hermes. Try again.');
    if (/not[_ -]?installed|incompatible_image/i.test(s))
        return tx('setupNeededNow', 'Hermes is not set up on this device yet.');
    if (/install\(\)/i.test(s))
        return tx('setupStepNeeded', 'Hermes needs one setup step before it can start.');
    if (/service_start_blocked/i.test(s))
        return tx('serviceStartBlocked', 'Hermes could not start in the background. Open the app, then try again.');
    if (/\b(?:401|403)\b/.test(s))
        return tx('errAuth', 'Hermes rejected the API key. Add or fix it under Settings.');
    if (/startforegroundservice|foregroundservice|not allowed/i.test(s))
        return tx('startFailedPlain', 'Could not start Hermes. Try again.');
    if (TRANSPORT_RE.test(s))
        return tx('errUnavailable', 'Hermes is unreachable. Make sure it is running, then try again.');
    if (isMachineFailure(s))
        return tx('startFailedPlain', 'Could not start Hermes. Try again.');
    return s;
}
// A line that reports the outcome of an action the user started (snapshot,
// diagnostics run, diagnostics bundle). A raw cause is replaced by plain copy
// or the caller's fallback; a human sentence passes through untouched.
export function plainResultLine(raw, fallback, tx = englishOnly) {
    const s = (raw || '').trim();
    if (!s)
        return fallback;
    // A rejected key is a state the UI must keep recognising, so the status
    // token survives instead of being replaced by the fallback. Everything
    // else machine-made below is replaced.
    const httpAuth = /\bhttp (401|403)\b/i.exec(s);
    if (httpAuth)
        return `HTTP ${httpAuth[1]}`;
    if (TRANSPORT_RE.test(s))
        return tx('opsUnreachablePlain', 'Hermes is not reachable, so that did not finish.');
    if (isMachineFailure(s))
        return fallback;
    return s;
}
// Service-layer entry point: turn a thrown value into plain copy. The gateway
// service calls this so a raw transport or platform message is never composed
// into a result the UI might render.
export function plainServiceFailure(err, tx = englishOnly) {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    const fallback = tx('opsUnreachablePlain', 'Hermes is not reachable, so that did not finish.');
    return plainResultLine(raw, fallback, tx);
}
// A list envelope carries a short prefix ("Sessions unavailable:") plus a
// cause. Keep the prefix and any HTTP status other checks rely on, but never
// let a raw transport or platform string ride along behind it.
export function plainListStale(prefix, raw, tx = englishOnly) {
    const s = (raw || '').trim();
    if (!s)
        return prefix;
    // An HTTP status is a fact other checks rely on (rejected key detection),
    // so it stays; only transport and platform text is replaced.
    if (/\bhttp \d{3}\b/i.test(s))
        return `${prefix} ${s}`;
    if (TRANSPORT_RE.test(s))
        return `${prefix} ${tx('listStaleTransport', 'Hermes is not reachable, so this list may be out of date.')}`;
    if (isMachineFailure(s))
        return `${prefix} ${tx('listStaleReason', 'Hermes did not answer, so this list may be out of date.')}`;
    return `${prefix} ${s}`;
}
