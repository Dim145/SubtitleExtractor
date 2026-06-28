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
