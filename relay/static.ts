/**
 * Serve the built beacon's own files from the relay process, so the canonical entry point is a host we
 * control (decision.md 2026-09-10 "the agent entry point must not sit behind a bot challenge": Vercel's
 * bot mitigation answers a plain GET from datacenter and VPN addresses with a 403 challenge page, and
 * those are exactly the addresses agents run on).
 *
 * Rules, all enforced here rather than documented: exact path match only (no traversal, no directory
 * listing, no extension guessing), one fixed content type per path, no redirect (`/` returns the
 * dashboard body itself), no request header is read (no user-agent sniffing, no cookies, no
 * content negotiation), and no path in this table may collide with one of the relay's dynamic routes
 * (`assertNoDynamicCollision` is called at startup, so a future edit cannot shadow `/state.json`).
 * `state.json` and `proposals.json` are deliberately absent: the build writes them, but the relay
 * answers those paths live and a static copy must never take over.
 *
 * Directory: `RELAY_BEACON_DIR` (default `beacon/public`, i.e. the beacon build output). With no build
 * present every path here answers 404 in the relay's JSON error shape; the dynamic endpoints keep working.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./common.js";

/** One servable file: the name inside the beacon build and the content type to answer with. */
interface Servable {
  name: string;
  type: string;
}

const TEXT = "text/plain; charset=utf-8";
const HTML = "text/html; charset=utf-8";

/** Path -> file in the beacon build. Exact match; the key set is the whole public surface. */
const FILES: Readonly<Record<string, Servable>> = {
  "/": { name: "index.html", type: HTML },
  "/index.html": { name: "index.html", type: HTML },
  "/README.txt": { name: "README.txt", type: TEXT },
  "/llms.txt": { name: "llms.txt", type: TEXT },
  "/robots.txt": { name: "robots.txt", type: TEXT },
  "/snippet.js": { name: "snippet.js", type: "text/javascript; charset=utf-8" },
  "/snippet.py": { name: "snippet.py", type: "text/x-python; charset=utf-8" },
  "/CONSTITUTION.md": { name: "CONSTITUTION.md", type: "text/markdown; charset=utf-8" },
};

/**
 * Content-Security-Policy for the dashboard: it carries one inline style block and one inline script
 * that fetches `state.json` from its own origin (the relay's live route), and nothing else.
 */
export const DASHBOARD_CSP = "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Every path this module serves. */
export function staticPaths(): string[] {
  return Object.keys(FILES);
}

/** The configured beacon directory as written by the operator (relative form kept, for error messages). */
export function beaconDirSetting(): string {
  return process.env.RELAY_BEACON_DIR ?? path.join("beacon", "public");
}

/** The resolved beacon directory. */
export function beaconDir(): string {
  return path.resolve(ROOT, beaconDirSetting());
}

/**
 * Refuse at startup if any static path would shadow a dynamic relay route.
 *
 * @param dynamicPaths The relay's exact dynamic paths (`/health.json`, `/relay`, ...).
 * @param dynamicPrefixes The relay's dynamic path prefixes (`/me/`).
 * @throws Error naming the colliding path; the relay must not start.
 */
export function assertNoDynamicCollision(dynamicPaths: readonly string[], dynamicPrefixes: readonly string[]): void {
  for (const key of Object.keys(FILES)) {
    if (dynamicPaths.includes(key)) throw new Error(`beacon static path ${key} collides with a dynamic relay route; the dynamic route must keep the path`);
    for (const prefix of dynamicPrefixes) if (key.startsWith(prefix)) throw new Error(`beacon static path ${key} is inside the dynamic prefix ${prefix}`);
  }
}

/** True when the relay serves this exact path from the beacon build. */
export function isStaticPath(pathname: string): boolean {
  return Object.hasOwn(FILES, pathname);
}

/**
 * Read one beacon file.
 *
 * @param pathname An exact path from `staticPaths()`.
 * @returns The bytes, the content type and the file's mtime, or undefined when the build has no such file.
 * @throws Error if `pathname` is not a static path (caller must check `isStaticPath` first).
 */
export function readStatic(pathname: string): { body: Buffer; type: string; modified: Date } | undefined {
  const entry = FILES[pathname];
  if (entry === undefined) throw new Error(`${pathname} is not a beacon static path`);
  const file = path.join(beaconDir(), entry.name);
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  return { body: readFileSync(file), type: entry.type, modified: stats.mtime };
}

/**
 * The 404 reason for a static path with no build behind it: operator-actionable, no stack trace, and
 * never an absolute filesystem path (an absolute RELAY_BEACON_DIR is named only as the env var, because
 * this string is public).
 *
 * @param pathname The static path that was requested.
 * @returns The reason string for the JSON error body.
 */
export function missingBuildReason(pathname: string): string {
  const setting = beaconDirSetting();
  const where = path.isAbsolute(setting) ? "the directory named by RELAY_BEACON_DIR" : setting;
  return `${pathname} is not built: this relay serves the beacon out of ${where}, which holds no ${FILES[pathname]?.name ?? "such file"}. The operator rebuilds it with: npm run beacon:build -- --deployment <file> --origin <this origin> --out <that directory>. The relay's own endpoints are unaffected: /health.json, /me/<address>.json, /proposals.json, /state.json, /pending.json, /relay`;
}
