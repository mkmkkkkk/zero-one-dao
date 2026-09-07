/**
 * Shared helpers for the scripts that act as an outside agent against a published beacon + relay
 * (relay/cold-start.ts, relay/corner-cases-relay.ts): numbered steps, printed assertions, GET with
 * printed request/response (intents shortened, passes redacted), running the published snippets.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

let stepCounter = 0;

/** Print a numbered step header. */
export function step(title: string): void {
  stepCounter += 1;
  console.log(`\n== step ${stepCounter}: ${title}`);
}

/** Hard assertion: prints the check and throws on failure. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.log(`   ASSERT FAILED: ${message}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`   ok: ${message}`);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Shorten intent/authorization payloads and redact passes in a URL for logs. */
export function shortUrl(url: string): string {
  return url.replace(/(intent|authorization)=([A-Za-z0-9_-]{24})[A-Za-z0-9_-]+/gu, "$1=$2...").replace(/pass=[^&]+/gu, "pass=<redacted>");
}

/** Parse `--name value` arguments. */
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) throw new Error(`expected --name value at ${String(name)}`);
    args[name.slice(2)] = value;
  }
  return args;
}

/**
 * GET a relay URL, print status, latency and body, and check the ok flag as expected.
 *
 * @param url The URL.
 * @param expectOk true: body.ok must be true; false: body.ok must be false with a string reason.
 * @returns The parsed body (status added as `httpStatus`).
 */
export async function get(url: string, expectOk = true): Promise<Record<string, unknown>> {
  console.log(`   GET ${shortUrl(url)}`);
  const started = Date.now();
  const response = await fetch(url, { headers: { "user-agent": "zero-one-agent-script" } });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }
  console.log(`   -> ${response.status} (${Date.now() - started} ms) ${JSON.stringify(body).replace(/"pass":"[^"]+"/gu, '"pass":"<redacted>"').slice(0, 1500)}`);
  if (expectOk) assert(body.ok === true, `relay answered ok (${String(body.reason ?? "")})`);
  else assert(body.ok === false && typeof body.reason === "string", `relay answered with a JSON reason: ${String(body.reason)}`);
  return { ...body, httpStatus: response.status };
}

/** GET a JSON document (no ok field expected); prints a prefix of the body. */
export async function getJson(url: string, printChars = 600): Promise<Record<string, unknown>> {
  console.log(`   GET ${url}`);
  const started = Date.now();
  const response = await fetch(url, { headers: { "user-agent": "zero-one-agent-script" } });
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  console.log(`   -> ${response.status} (${Date.now() - started} ms, ${text.length} bytes) ${text.slice(0, printChars)}`);
  return body;
}

/** Run a published helper snippet in `dir` and return the URL it prints (stderr shown). */
export function snippet(lang: "node" | "python", dir: string, args: string[]): string {
  const command = lang === "node" ? ["node", path.join(dir, "snippet.js"), ...args] : ["python3", path.join(dir, "snippet.py"), ...args];
  console.log(`   $ ${lang === "node" ? "node snippet.js" : "python3 snippet.py"} ${args.map((a) => (a.includes(" ") || a.includes("{") ? JSON.stringify(a) : a)).join(" ")}`);
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", cwd: dir, timeout: 180_000 });
  if (result.stderr.trim()) console.log(`   stderr: ${result.stderr.trim().split("\n").join(" | ")}`);
  if (result.status !== 0) throw new Error(`${lang} snippet failed (${result.status}): ${result.stderr}`);
  const url = result.stdout.trim().split("\n").pop() ?? "";
  if (!url.startsWith("http")) throw new Error(`snippet printed no URL: ${result.stdout}`);
  return url;
}

/** Fetch README.txt, llms.txt and both snippets from a beacon into `dir`; returns the README text and the relay origin it names. */
export async function fetchBeacon(beacon: string, dir: string): Promise<{ readme: string; origin: string }> {
  const { writeFileSync } = await import("node:fs");
  const readme = await (await fetch(`${beacon}/README.txt`)).text();
  const originMatch = /Relay (https?:\/\/[^\s.]+(?:\.[^\s.]+)*)\./u.exec(readme);
  if (originMatch === null) throw new Error("README names no relay origin");
  for (const name of ["snippet.js", "snippet.py", "llms.txt"]) {
    const text = await (await fetch(`${beacon}/${name}`)).text();
    writeFileSync(path.join(dir, name), text);
    console.log(`   fetched ${name} (${text.length} bytes)`);
  }
  return { readme, origin: originMatch[1]! };
}
