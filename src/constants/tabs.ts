/**
 * Tab routing constants shared by App.tsx (the shell that reads and writes
 * them), Header.tsx (the screen name that reads the hash back) and any other
 * surface that needs to agree on which index a tab is.
 *
 * They live in one place because the hash *is* the route: two local copies
 * that drift apart leave a persisted tab restoring to the wrong screen, or a
 * hash that no longer matches any tab. The encoding is part of the contract
 * (lower case fragment with a leading '#/'), since saved tabs and deep links
 * are stored as these exact strings.
 */
export const TAB_HASHES = ['#/home', '#/chat', '#/terminal', '#/settings'] as const;

/**
 * Exactly the rule HomeTab applies to its list sync envelopes: an
 * authenticated list call rejected with HTTP 401/403 while health stayed
 * green means the stored key is stale, not that the server is offline.
 * Shared so the header banner and the home banner can never disagree about
 * what counts as an auth failure.
 */
export const AUTH_FAILURE_RE = /401|403|unauthori[sz]ed|forbidden|invalid (api )?key/i;
