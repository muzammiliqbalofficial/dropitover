// One address for the site.
//
// Without this the same page answers on http, https, www and the workers.dev
// address. That splits search ranking across four URLs, and worse: the plain
// http version is not a secure context, so browsers disable WebRTC and the
// clipboard there. A visitor who reaches http:// gets an app whose two
// peer-to-peer modes silently cannot work.

/**
 * Where a request should be redirected to reach the canonical address, or null
 * if it is already there (or is on some other host, such as workers.dev or
 * localhost, which are left alone).
 *
 * @param {string} requestUrl
 * @param {string} [canonicalHost] e.g. "dropitover.com". Unset disables redirects.
 * @returns {string|null}
 */
export function canonicalRedirect(requestUrl, canonicalHost) {
  const host = String(canonicalHost || '').trim().toLowerCase();
  if (!host) return null;

  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  const from = url.hostname.toLowerCase();
  const belongs = from === host || from === `www.${host}`;
  if (!belongs) return null;

  const alreadyCanonical = url.protocol === 'https:' && from === host;
  if (alreadyCanonical) return null;

  const target = new URL(url.toString());
  target.protocol = 'https:';
  target.hostname = host;
  target.port = '';
  return target.toString();
}

/**
 * True when the request is on the canonical host. Anything else that still
 * serves the site (the workers.dev address) is marked noindex so it doesn't
 * compete with the real domain in search results.
 */
export function isCanonicalHost(requestUrl, canonicalHost) {
  const host = String(canonicalHost || '').trim().toLowerCase();
  if (!host) return true;
  try {
    return new URL(requestUrl).hostname.toLowerCase() === host;
  } catch {
    return true;
  }
}
