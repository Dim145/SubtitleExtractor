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
  return /^https?:\/\//i.test(u) ? proxyPath : u;
}
