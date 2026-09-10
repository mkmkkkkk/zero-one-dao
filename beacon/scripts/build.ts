/**
 * Build the public beacon for one deployment: README.txt (<= 44 lines), llms.txt, state.json (from the
 * chain via relay/chain.ts), proposals.json, snippet.js / snippet.py (addresses filled in) and the
 * dashboard (index.html). Pattern: agent-only-wallet/beacon/scripts/build.mjs, parameterized here.
 *
 * `--origin` is the origin the built files advertise, and it defaults to CANONICAL_ORIGIN, the relay's
 * own public hostname (decision.md 2026-09-10: the canonical entry point must be a host we control that
 * never challenges a plain GET; the relay serves these files itself, relay/static.ts). `--mirror` is the
 * second copy the README names in one line, default MIRROR_ORIGIN (the Vercel beacon). Building the
 * mirror is the same command with `--origin <mirror>`, which is what keeps the Vercel deployment working
 * unchanged: every URL in its files then points at itself, and its rewrites forward /relay to the relay.
 * Usage: tsx beacon/scripts/build.ts [--deployment <file>] [--origin <url>] [--mirror <url>] [--out <dir>] [--constitution-url <url>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDaoState, type DaoState } from "../../relay/chain.js";
import { CANONICAL_ORIGIN, connect, json, loadDeployment, MIRROR_ORIGIN, ROOT, fmtShares } from "../../relay/common.js";

const TEMPLATES = path.join(ROOT, "beacon", "templates");

/** Parse `--name value` arguments. */
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name === undefined || !name.startsWith("--")) throw new Error(`expected --name value, got ${name}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`--${name.slice(2)} needs a value`);
    args[name.slice(2)] = value;
    i += 1;
  }
  return args;
}

/** Seconds as a compact human duration. */
function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * Fill a template with deployment facts.
 *
 * @param text Template text with {{PLACEHOLDERS}}.
 * @param values Placeholder values.
 * @returns The filled text.
 * @throws Error if a placeholder has no value.
 */
export function fill(text: string, values: Record<string, string>): string {
  const out = text.replace(/\{\{([A-Z_]+)\}\}/gu, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`no value for {{${key}}}`);
    return value;
  });
  if (/\{\{[A-Z_]+\}\}/u.test(out)) throw new Error("unfilled placeholder remains");
  return out;
}

/**
 * Build the beacon into `out`.
 *
 * @param options Deployment file, the origin these files advertise (default CANONICAL_ORIGIN), output
 *   dir, the mirror origin the README names (default MIRROR_ORIGIN), constitution URL.
 * @returns The state that was written.
 */
export async function buildBeacon(options: { deployment: string; origin?: string; out: string; mirror?: string; constitutionUrl?: string }): Promise<DaoState> {
  const origin = (options.origin ?? CANONICAL_ORIGIN).replace(/\/+$/u, "");
  const mirror = (options.mirror ?? MIRROR_ORIGIN).replace(/\/+$/u, "");
  const deployment = loadDeployment(options.deployment);
  const env = connect(deployment);
  const state = await readDaoState(env, 0);
  const constitutionUrl = options.constitutionUrl ?? (deployment.constitution.textUrl.startsWith("http") ? deployment.constitution.textUrl : `${origin}/CONSTITUTION.md`);
  const values: Record<string, string> = {
    CHAIN_ID: String(deployment.chainId),
    CHAIN_NAME: state.chain.name,
    ORIGIN: origin,
    MIRROR: mirror,
    CONSTITUTION_URL: constitutionUrl,
    CONSTITUTION_HASH: state.constitution.textHash,
    CONSTITUTION: deployment.constitution.address,
    SAFE: deployment.safe,
    BAAL: deployment.baal,
    SHARES: deployment.shares,
    SETTLEMENT: deployment.settlement,
    DEPOSIT: deployment.depositShaman,
    WORK: deployment.workManager,
    ADAPTER: deployment.intentAccount,
    FACTORY: deployment.templateFactory,
    SPONSOR_THRESHOLD: fmtShares(BigInt(state.governance.sponsorThreshold)),
    VOTING_PERIOD: duration(state.governance.votingPeriod),
    GRACE_PERIOD: duration(state.governance.gracePeriod),
  };
  mkdirSync(options.out, { recursive: true });
  const write = (name: string, content: string): void => writeFileSync(path.join(options.out, name), content);
  for (const name of ["README.txt", "llms.txt", "snippet.js", "snippet.py"]) write(name, fill(readFileSync(path.join(TEMPLATES, name), "utf8"), values));
  write("index.html", fill(readFileSync(path.join(TEMPLATES, "dashboard.html"), "utf8"), values));
  write("state.json", json(state));
  write("proposals.json", json({ chain: state.chain, governance: state.governance, openProposals: state.openProposals, proposals: state.proposals, generatedAt: state.generatedAt }));
  write("CONSTITUTION.md", readFileSync(path.join(ROOT, "docs", "CONSTITUTION.md"), "utf8"));
  write("robots.txt", "User-agent: *\nAllow: /\n");
  return state;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  const deployment = args.deployment ?? process.env.ZERO_ONE_DEPLOYMENT ?? "deployments/local.json";
  const origin = args.origin ?? process.env.RELAY_ORIGIN ?? CANONICAL_ORIGIN;
  const mirror = args.mirror ?? MIRROR_ORIGIN;
  const out = path.resolve(ROOT, args.out ?? "beacon/public");
  buildBeacon({ deployment, origin, out, mirror, constitutionUrl: args["constitution-url"] })
    .then((state) => console.log(json({ out, origin, mirror, block: state.chain.blockNumber, members: state.members.length, proposals: state.proposals.length, tasks: state.tasks.length })))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
