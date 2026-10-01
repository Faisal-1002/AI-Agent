// Where to go after signing in: only a path on THIS site. Checking the text isn't enough —
// browsers read "/\evil.example" or "/<tab>/evil.example" as another site — so resolve it
// like a browser would and compare origins.
export function safeReturnTo(value: string | undefined, publicUrl: string): string {
  // Long values: it travels in the login cookie (and nothing legitimate is that long).
  if (!value || value.length > 512) return "/";
  try {
    const home = new URL(publicUrl);
    const target = new URL(value, home);
    if (target.origin !== home.origin || /[\\\u0000-\u001f]/.test(value)) return "/";
    const path = target.pathname + target.search + target.hash;
    // Resolving can itself produce "//": "/.//evil.example" → pathname "//evil.example",
    // which a browser reads as another site. Only a single leading slash is a local path.
    return path.startsWith("//") ? "/" : path;
  } catch {
    return "/";
  }
}
