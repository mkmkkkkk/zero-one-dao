/**
 * Deploy a built beacon directory to Vercel through the REST API (pattern: agent-only-wallet/beacon/
 * scripts/vercel.mjs): every file is uploaded by sha1 to /v2/files, then one production deployment
 * of project `zero-one-beacon` is created with beacon/vercel.json (headers + rewrites of /relay, /me,
 * /health.json, /state.json, /proposals.json to the relay). Credentials: env ZERO_ONE_VERCEL_CREDENTIALS_FILE,
 * else ~/.config/aow-v2/vercel.json (mini), else ../nerve/state/credentials_vault.json deploy.vercel
 * ({pat, team}); the token travels only through curl's stdin config. The project is created on first
 * deploy (its production alias is <project>.vercel.app).
 * Usage: tsx beacon/scripts/vercel.ts [--out beacon/public-base-sepolia] [--project zero-one-beacon]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { json, ROOT } from "../../relay/common.js";
import { parseArgs } from "./build.js";

const PROXY = process.env.HTTPS_PROXY ?? "http://127.0.0.1:7897";

function credentials(): { pat: string; team: string } {
  const candidates = [process.env.ZERO_ONE_VERCEL_CREDENTIALS_FILE, path.join(homedir(), ".config", "aow-v2", "vercel.json")].filter((file): file is string => file !== undefined && existsSync(file));
  if (candidates.length > 0) return JSON.parse(readFileSync(candidates[0]!, "utf8")) as { pat: string; team: string };
  const vault = JSON.parse(readFileSync(path.join(ROOT, "..", "nerve", "state", "credentials_vault.json"), "utf8")) as { deploy: { vercel: { pat: string; team: string } } };
  return vault.deploy.vercel;
}

/**
 * One Vercel API call via curl (proxy, retries); the bearer token is written to curl's stdin config.
 *
 * @param method HTTP method.
 * @param apiPath Path under https://api.vercel.com (teamId is appended).
 * @param body JSON body (optional).
 * @param raw Raw bytes body (file upload).
 * @param digest x-vercel-digest for uploads.
 * @returns The parsed JSON response.
 * @throws Error on HTTP >= 400 or transport failure.
 */
export async function api(method: string, apiPath: string, body?: unknown, raw?: Buffer, digest?: string): Promise<Record<string, unknown>> {
  const { pat, team } = credentials();
  const dir = mkdtempSync(path.join(tmpdir(), "zero-one-vercel-"));
  const args = ["-sS", "--max-time", "120", "--retry", "4", "--retry-all-errors", "--retry-delay", "3", "--proxy", PROXY, "--noproxy", "", "--config", "-", "-X", method, `https://api.vercel.com${apiPath}${apiPath.includes("?") ? "&" : "?"}teamId=${team}`, "-w", "\n%{http_code}"];
  if (body !== undefined || raw !== undefined) {
    const file = path.join(dir, "body");
    writeFileSync(file, raw ?? JSON.stringify(body), { mode: 0o600 });
    args.push("-H", `Content-Type: ${raw ? "application/octet-stream" : "application/json"}`, "--data-binary", `@${file}`);
  }
  if (digest !== undefined) args.push("-H", `x-vercel-digest: ${digest}`);
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile("/usr/bin/curl", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(new Error("Vercel transport failed")) : resolve(stdout)));
      child.stdin!.end(`header = ${JSON.stringify(`Authorization: Bearer ${pat}`)}\n`);
    });
    const at = out.lastIndexOf("\n");
    const status = Number(out.slice(at + 1));
    const data = JSON.parse(out.slice(0, at) || "{}") as Record<string, unknown>;
    if (status >= 400) throw new Error(`Vercel HTTP ${status} ${String((data.error as { code?: string } | undefined)?.code ?? "")} ${String((data.error as { message?: string } | undefined)?.message ?? "")}`);
    return data;
  } finally {
    renameSync(dir, path.join(homedir(), ".Trash", `zero-one-vercel-${process.pid}-${Date.now()}`));
  }
}

/**
 * Upload `outDir` + beacon/vercel.json and create a production deployment.
 *
 * @param options Project name and built directory.
 * @returns Deployment id, URL and the project's production alias.
 */
export async function deploy(options: { project: string; outDir: string }): Promise<Record<string, unknown>> {
  const files: Array<{ file: string; sha: string; size: number }> = [];
  const blobs = new Map<string, Buffer>();
  const add = (file: string, source: string): void => {
    const bytes = readFileSync(source);
    const sha = createHash("sha1").update(bytes).digest("hex");
    files.push({ file, sha, size: bytes.length });
    blobs.set(sha, bytes);
  };
  // Vercel serves a static file before applying rewrites, so the build-time snapshots of the two documents the
  // relay serves live (state.json, proposals.json) are not uploaded; the rewrites in beacon/vercel.json take over.
  const rewritten = new Set(["public/state.json", "public/proposals.json"]);
  const walk = (dir: string, prefix = "public"): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (/\.(new|pyc)$/u.test(entry.name) || entry.name === "__pycache__") continue;
      if (rewritten.has(`${prefix}/${entry.name}`)) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      else if (entry.isFile()) add(`${prefix}/${entry.name}`, path.join(dir, entry.name));
    }
  };
  walk(options.outDir);
  add("vercel.json", path.join(ROOT, "beacon", "vercel.json"));
  for (const [sha, bytes] of blobs) await api("POST", "/v2/files", undefined, bytes, sha);
  const created = await api("POST", "/v13/deployments?skipAutoDetectionConfirmation=1", { name: options.project, project: options.project, target: "production", files, projectSettings: { framework: null, buildCommand: "", installCommand: "", outputDirectory: "public" } });
  const id = String(created.id);
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const status = await api("GET", `/v13/deployments/${id}`);
    if (status.readyState === "READY") {
      const aliases = (status.alias as string[] | undefined) ?? [];
      return { id, url: status.url, readyState: status.readyState, aliases, files: files.length };
    }
    if (status.readyState === "ERROR" || status.readyState === "CANCELED") throw new Error(`Vercel ${String(status.readyState)}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Vercel deployment readiness timeout");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  deploy({ project: args.project ?? "zero-one-beacon", outDir: path.resolve(ROOT, args.out ?? "beacon/public-base-sepolia") })
    .then((result) => console.log(json(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
