/*
 * LumeOS - desktop/base.ts
 * Resolve site-relative paths against the document base URL.
 *
 * LumeOS must work both at the domain root (served by the C backend) and
 * under a subpath, as with a GitHub Pages project site
 * (https://<user>.github.io/<repo>/). Every runtime URL the kernel builds
 * goes through appUrl() so a single build works in both layouts.
 */

export function appUrl(path: string): string {
  const clean = path.replace(/^\.?\//, '');
  return new URL(clean, document.baseURI).href;
}

/** The site base path, e.g. "/" or "/LumeOS-web/". */
export function appBasePath(): string {
  return new URL('.', document.baseURI).pathname;
}
