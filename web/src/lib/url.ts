// Guard against a server-provided URL being used as a media/fetch source with a
// dangerous scheme (javascript:, data:, blob: from an untrusted origin, etc.).
// We only trust http(s) URLs and same-origin relative paths. Returns the safe
// URL, or null if it should be rejected.
export function safeMediaUrl(url: string): string | null {
  if (!url) return null;
  // Same-origin relative path (e.g. "/api/…") is always fine.
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Presigned URLs for the local-fs backend are absolute to the API host. Rewriting
// our own /api/* URLs to same-origin makes them ride the dev proxy / nginx proxy
// (avoids CORS, and works when the API isn't publicly published). S3 presigned
// URLs point at a different host and are left untouched.
export function sameOriginApiUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    if (u.pathname.startsWith("/api/")) return u.pathname + u.search;
  } catch {
    /* not a parseable URL — return as-is */
  }
  return url;
}

// Pick a browser-usable URL for a stored object. The local backend's presigned
// URL is same-origin (/api/files/…) and works directly; an S3 presigned URL is
// cross-origin and blocked by our CSP (connect-src/media-src 'self'), so fall
// back to the same-origin API streaming proxy. Avoids a guaranteed-to-fail
// cross-origin request and keeps the CSP tight.
export function downloadableUrl(presignedUrl: string, proxyPath: string): string {
  const u = sameOriginApiUrl(presignedUrl);
  // Reject anything that isn't http(s) or a same-origin path (javascript:/data:
  // etc.) by falling back to the trusted same-origin proxy.
  if (safeMediaUrl(u) == null) return proxyPath;
  return /^https?:\/\//i.test(u) ? proxyPath : u;
}
