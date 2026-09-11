/**
 * Validate a built beacon: README.txt has at most 44 lines and carries the principle, the eight verbs,
 * the constitution hash and every address; every contract address in state.json has code on the
 * deployment's chain (template instances included); snippets have no unfilled placeholders; the
 * dashboard uses no gradients, emoji, purple or black. Pattern: agent-only-wallet/beacon/scripts/validate.mjs.
 *
 * Then the part that makes a passing validate mean something to an agent (decision.md 2026-09-10 "the
 * agent entry point must not sit behind a bot challenge"): every URL the README advertises on its own
 * origin is FETCHED from that origin and must answer 200 with the right content type, a parseable body
 * for the JSON endpoints, and no bot-challenge page. The old validate only read the local build, so a
 * beacon whose origin answers 403 `x-vercel-mitigated: challenge` to a plain GET passed. The origin is
 * the one the README itself names (`--origin` overrides it, e.g. to test the mirror); the fetches are
 * skipped only when `--no-fetch 1` is passed, and the summary then says `fetched: "SKIPPED"`.
 * stdout stays exactly one JSON document (the summary); the per-URL progress goes to stderr.
 * Custody (decision.md 2026-09-11 ruling 1): `/me/<address>.json` is the only member document the
 * README advertises, and it reported self-custody for an account whose key the relay holds. The
 * validator therefore fetches it for an address no relay can derive (must be self-custody) and, given
 * `--custodial <address>`, for one this relay derived from a T0 pass (must be custodial-lite).
 * Usage: tsx beacon/scripts/validate.ts --deployment <file> [--out <dir>] [--origin <url>] [--no-fetch 1] [--custodial <address>]
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAddress, isAddress, keccak256 } from "viem";

import { connect, json, loadDeployment, MIRROR_ORIGIN, ROOT } from "../../relay/common.js";
import type { DaoState } from "../../relay/chain.js";
import { parseArgs } from "./build.js";

const VERBS = ["join", "deposit", "task", "deliver", "propose", "vote", "execute", "ragequit"];

/** Content types accepted per kind of file. A mirror may label a helper differently; HTML never passes for a non-HTML file. */
const TYPES: Record<string, RegExp> = {
  txt: /^text\/plain\b/u,
  js: /^(?:text|application)\/javascript\b/u,
  py: /^(?:text\/(?:x-python|plain)|application\/(?:x-python|octet-stream))\b/u,
  md: /^text\/(?:markdown|x-markdown|plain)\b/u,
  json: /^application\/json\b/u,
  html: /^text\/html\b/u,
};

/** Markers of a bot-mitigation interstitial served instead of the document (Vercel, Cloudflare, Akamai). */
const CHALLENGE = /Security Checkpoint|Just a moment|challenge-platform|__cf_chl|Checking your browser|Attention Required/iu;

/** One live probe: the URL to fetch, what it is, and how the answer must look. */
interface Probe {
  /** The path (or path + query) on the origin under test. */
  target: string;
  /** Which README-advertised paths this probe covers. */
  covers: string[];
  /** Extension key into TYPES. */
  kind: keyof typeof TYPES | string;
  /** Extra body assertion, run on the decoded text (and parsed JSON when the kind is json). */
  check?: (text: string, parsed: unknown) => void;
}

/**
 * Every path the README advertises on its own origin, normalized to the form the probe table uses.
 *
 * Absolute `<origin>/...` URLs and bare `/paths` are both collected, `/me/<anything>` collapses to
 * `/me/<address>.json` and any `/relay?...` to `/relay`, because those two are families, not documents.
 *
 * @param readme The built README text.
 * @param origin The origin under test (no trailing slash).
 * @returns The advertised paths (sorted, unique) and the absolute URLs that point somewhere else.
 */
export function advertisedPaths(readme: string, origin: string): { paths: string[]; offOrigin: string[] } {
  const paths = new Set<string>();
  const offOrigin = new Set<string>();
  const normalize = (raw: string): string => {
    const clean = raw.replace(/[.,;:)]+$/u, "");
    if (clean.startsWith("/me")) return "/me/<address>.json";
    if (clean.startsWith("/relay")) return "/relay";
    return clean;
  };
  for (const match of readme.matchAll(/https?:\/\/[^\s,)]+/gu)) {
    const url = match[0].replace(/[.,;:)]+$/u, "");
    if (url === origin || url.startsWith(`${origin}/`)) paths.add(normalize(url.slice(origin.length) || "/"));
    else offOrigin.add(url);
  }
  // Bare paths: a `/` token that starts a word (after whitespace, `(` or `|`), e.g. "GET /relay?op=join".
  for (const match of readme.matchAll(/(?:^|[\s(|])(\/[A-Za-z][A-Za-z0-9_.<>/?=&-]*)/gmu)) paths.add(normalize(match[1]!));
  return { paths: [...paths].sort(), offOrigin: [...offOrigin].sort() };
}

/**
 * An address no relay can have derived from a T0 pass: the custody negative control. A relay that
 * hardcodes a custody label answers the same thing here as for a real custodial account.
 */
const NOT_DERIVABLE = getAddress("0x00000000000000000000000000000000c0ffee01");

/**
 * Assert the custody label of one `/me` document.
 *
 * @param parsed The parsed `/me` body.
 * @param expected The custody the relay must report for this address.
 * @param why What makes it that (for the failure message).
 */
function assertCustody(parsed: unknown, expected: "self-custody" | "custodial-lite", why: string): void {
  const body = parsed as { address?: string; custody?: string };
  assert.equal(body.custody, expected, `/me/${String(body.address)}.json reports custody ${JSON.stringify(body.custody)} for ${why} (decision.md 2026-09-11 ruling 1: the advertised member document must not publish an address the relay can sign for as self-custody)`);
}

/**
 * Build the probe table for one origin.
 *
 * @param origin Origin under test.
 * @param member An address that exists on this DAO (for `/me` and the read-only quote).
 * @param chainId The deployment's chain id.
 * @param builtReadme The README bytes this build produced (the served one must be identical).
 * @param constitutionHash The on-chain constitution hash.
 * @param custodial An address this relay derived from a T0 pass and can sign for, when one is known
 *   (`--custodial`): `/me/<it>.json` must report custodial-lite.
 * @returns The probes.
 */
function probesFor(origin: string, member: string, chainId: number, builtReadme: string, constitutionHash: string, custodial?: string): Probe[] {
  const quoteParams = encodeURIComponent(JSON.stringify({ recipients: [member], amounts: ["1000000"] }));
  return [
    {
      target: "/README.txt",
      covers: ["/README.txt"],
      kind: "txt",
      check: (text) => assert.equal(text, builtReadme, "the README served by the origin is not the one this build produced"),
    },
    { target: "/llms.txt", covers: ["/llms.txt"], kind: "txt", check: (text) => assert(text.includes("# Zero One"), "llms.txt does not start with the Zero One header") },
    { target: "/snippet.js", covers: ["/snippet.js"], kind: "js", check: (text) => assert(/ORIGIN=/u.test(text), "snippet.js carries no ORIGIN") },
    { target: "/snippet.py", covers: ["/snippet.py"], kind: "py", check: (text) => assert(/ORIGIN=/u.test(text), "snippet.py carries no ORIGIN") },
    {
      target: "/CONSTITUTION.md",
      covers: ["/CONSTITUTION.md"],
      kind: "md",
      check: (text) => assert.equal(keccak256(new TextEncoder().encode(text)), constitutionHash, "the CONSTITUTION.md served by the origin does not hash to the on-chain hash"),
    },
    { target: "/robots.txt", covers: ["/robots.txt"], kind: "txt" },
    { target: "/", covers: ["/", "/index.html"], kind: "html", check: (text) => assert(/<title>Zero One<\/title>/u.test(text), "the dashboard is not the Zero One dashboard") },
    {
      target: "/health.json",
      covers: ["/health.json"],
      kind: "json",
      check: (_text, parsed) => {
        const body = parsed as { alive?: boolean; chainId?: number };
        assert.equal(body.alive, true, "/health.json does not report alive");
        assert.equal(Number(body.chainId), chainId, "/health.json reports another chain id");
      },
    },
    {
      target: "/state.json",
      covers: ["/state.json"],
      kind: "json",
      check: (_text, parsed) => assert.equal(Number((parsed as DaoState).chain.id), chainId, "/state.json reports another chain id"),
    },
    { target: "/proposals.json", covers: ["/proposals.json"], kind: "json", check: (_text, parsed) => assert(Array.isArray((parsed as { proposals?: unknown[] }).proposals), "/proposals.json carries no proposals array") },
    { target: "/pending.json", covers: ["/pending.json"], kind: "json", check: (_text, parsed) => assert(Array.isArray((parsed as { inFlight?: unknown[] }).inFlight), "/pending.json carries no inFlight array") },
    {
      target: `/me/${member}.json`,
      covers: ["/me/<address>.json"],
      kind: "json",
      check: (_text, parsed) => {
        const body = parsed as { address: string; custody?: string; usdc?: string; settlement?: { token?: string; balance?: string } };
        assert.equal(getAddress(String(body.address)), getAddress(member), "/me answered for another address");
        assert(body.custody === "self-custody" || body.custody === "custodial-lite", `/me carries no custody label (got ${JSON.stringify(body.custody)})`);
        // Ruling 2: an agent must be able to see what its deposit will draw on without a chain read.
        assert(body.settlement !== undefined && typeof body.settlement.balance === "string" && /^\d+$/u.test(body.settlement.balance), "/me carries no settlement.balance (the USDC a deposit pulls)");
        assert(typeof body.settlement.token === "string" && isAddress(body.settlement.token), "/me settlement carries no token address");
        assert.equal(body.settlement.balance, body.usdc, "/me settlement.balance and usdc disagree about the same balance");
      },
    },
    {
      // Custody negative control: an address the relay cannot have derived must read self-custody.
      target: `/me/${NOT_DERIVABLE}.json`,
      covers: ["/me/<address>.json"],
      kind: "json",
      check: (_text, parsed) => assertCustody(parsed, "self-custody", "an address no relay holds a key for"),
    },
    ...(custodial === undefined
      ? []
      : [{
          // Ruling 1: the advertised member document, for an address this relay derived from a T0 pass.
          target: `/me/${getAddress(custodial)}.json`,
          covers: ["/me/<address>.json"],
          kind: "json",
          check: (_text: string, parsed: unknown) => assertCustody(parsed, "custodial-lite", "a T0 account whose key this relay derived and holds"),
        } satisfies Probe]),
    {
      // The README's own read-only relay URL: it proves /relay is reachable and answers JSON, which is
      // exactly what a challenge page does not do. Nothing is signed and nothing is deployed.
      target: `/relay?op=quote&member=${member}&template=Payment&params=${quoteParams}&summary=beacon%20validate%20probe`,
      covers: ["/relay"],
      kind: "json",
      check: (_text, parsed) => {
        const body = parsed as { ok?: boolean; instance?: string };
        assert.equal(body.ok, true, `/relay?op=quote did not answer ok: ${JSON.stringify(parsed).slice(0, 300)}`);
        assert(typeof body.instance === "string" && isAddress(body.instance), "/relay?op=quote answered without an instance address");
      },
    },
  ];
}

/**
 * Fetch one probe and assert status, content type and body.
 *
 * @param origin Origin under test.
 * @param probe The probe.
 * @returns One result row for the summary.
 */
async function runProbe(origin: string, probe: Probe): Promise<Record<string, unknown>> {
  const url = `${origin}${probe.target}`;
  const response = await fetch(url, { redirect: "manual", headers: { accept: "*/*" } });
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const mitigated = [...response.headers].filter(([name]) => /mitigat|challenge|cf-mitigated/iu.test(name)).map(([name, value]) => `${name}: ${value}`);
  const context = `${url} -> ${response.status} ${type}${mitigated.length > 0 ? ` [${mitigated.join(", ")}]` : ""}${response.status === 200 ? "" : ` body: ${text.slice(0, 200).replace(/\s+/gu, " ")}`}`;
  assert.equal(response.status, 200, `origin did not answer 200 for ${context}`);
  assert.equal(mitigated.length, 0, `origin answered with a bot-mitigation header for ${context}`);
  assert(!CHALLENGE.test(text.slice(0, 4000)), `origin answered a bot-challenge page instead of the document for ${context}`);
  const expected = TYPES[probe.kind];
  assert(expected !== undefined, `no expected content type for kind ${probe.kind}`);
  assert(expected.test(type), `wrong content type for ${context} (expected ${String(expected)})`);
  let parsed: unknown;
  if (probe.kind === "json") {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`unparseable JSON body for ${context}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  probe.check?.(text, parsed);
  console.error(`   fetched ${probe.target} -> 200 ${type} (${text.length} bytes)`);
  return { target: probe.target, status: response.status, type, bytes: text.length };
}

/**
 * Run every check; throws on the first failure.
 *
 * @param options Deployment file, beacon output directory, the origin to fetch from (default: the one
 *   the README names), `noFetch` to skip the live fetches, and `custodial`: an address this origin's
 *   relay derived from a T0 pass, whose `/me` must report custodial-lite (ruling 1).
 * @returns A summary of the checks that passed.
 */
export async function validateBeacon(options: { deployment: string; out: string; origin?: string; noFetch?: boolean; custodial?: string }): Promise<Record<string, unknown>> {
  const deployment = loadDeployment(options.deployment);
  const env = connect(deployment);
  const readme = readFileSync(path.join(options.out, "README.txt"), "utf8");
  const lines = readme.trimEnd().split("\n");
  assert(readme.includes("Deposits pause while an open proposal contract still holds a non-USDC asset"), "README lacks the settlement rule (phase 5 ruling 4a: open instances pause deposits, Safe dust does not)");
  assert(readme.includes("exit is pro-rata of the Safe only"), "README lacks the exit rule (ragequit is pro-rata of the Safe only)");
  assert(readme.includes("T0: the relay operator can delay or drop your intents; anything you cannot afford to lose goes through T1."), "README lacks the T0 relay-authority line (phase 5 ruling 7, A5-10)");
  assert(/128 bits of entropy/u.test(readme), "README lacks the T0 pass entropy floor (phase 5 ruling 9, A5-08)");
  assert(/\/pending\.json/u.test(readme), "README lacks /pending.json (phase 5 ruling 7)");
  assert(lines.length <= 44, `README.txt has ${lines.length} lines (max 44)`);
  assert(readme.includes("Any member can propose anything; only the other members' votes or exits can stop it."), "README lacks the principle");
  for (const verb of VERBS) assert(new RegExp(`^${verb}\\b`, "mu").test(readme), `README lacks verb ${verb}`);
  assert(readme.includes("Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)"), "README lacks the intent type");
  assert(!/\{\{[A-Z_]+\}\}/u.test(readme), "README has unfilled placeholders");
  assert(!/[—\p{Extended_Pictographic}]/u.test(readme), "README contains an em dash or emoji");
  assert(!/op=1\b|\bsponsor\s+op=|op=prepare/u.test(readme), "README still mentions the retired sponsor verb (op 1) or op=prepare");
  assert(/op=quote/u.test(readme) && /abi\.encode\(uint8 template,bytes params,bytes32 salt\)/u.test(readme), "README lacks the one-intent propose format (op=quote, abi.encode(template, params, salt))");

  // What the 2026-09-11 cold start found missing in the 44 served lines (decision.md rulings 1..5).
  // Each defect is one assertion, so losing the sentence again fails here instead of in a cold start.
  assert(/custody self-custody or custodial-lite/u.test(readme), "README does not say /me reports custody (ruling 1)");
  assert(/faucet/u.test(readme) && /[Mm]ainnet/u.test(readme), "README does not say where the USDC a deposit pulls comes from, test chain against mainnet (ruling 2: a fresh key holds none and there is no public faucet)");
  assert(/settlement\.balance/u.test(readme), "README does not point at the settlement balance /me carries (ruling 2)");
  assert(/deposit\s+op=5 amount=<USDC raw units/u.test(readme), "README does not name the unit on the deposit intent (ruling 3)");
  assert(/op=deposit&amount=<USDC raw units>/u.test(readme), "README does not name the unit on the fetch-only deposit (ruling 3: amount=100 deposits 0.0001 USDC in a mined transaction)");
  assert(/--usdc 100 \(whole USDC/u.test(readme), "README does not say the keyed snippet takes whole USDC while the fetch-only path takes raw units (ruling 3)");
  assert(/op=ragequit\[&amount=/u.test(readme), "README does not document the partial amount the fetch-only exit honours (ruling 4)");
  assert(/creates the key file at 0600/u.test(readme), "README does not say the snippet writes the key file when it is missing (ruling 5)");
  assert(/\/me\/pass\//u.test(readme), "README does not advertise /me/pass/<hash>.json, which relay responses point at (ruling 5)");
  assert(/myVote/u.test(readme) && !/my votes/u.test(readme), "README names a member's own vote something other than the myVote field /me delivers (ruling 5)");

  // Entry point (decision.md 2026-09-10): the README names the canonical origin it is served from and,
  // in one line, the mirror; the origin under test is the one it names unless --origin overrides it.
  const originMatch = /Relay (https?:\/\/[^\s.]+(?:\.[^\s.]+)*)\./u.exec(readme);
  assert(originMatch !== null, "README names no relay origin (the line must read `Relay <url>.`)");
  const readmeOrigin = originMatch![1]!.replace(/\/+$/u, "");
  const mirrorMatch = /Mirror (https?:\/\/[^\s.]+(?:\.[^\s.]+)*) /u.exec(readme);
  assert(mirrorMatch !== null, "README names no mirror (one line must read `Mirror <url> ...`)");
  const mirror = mirrorMatch![1]!.replace(/\/+$/u, "");
  assert(mirror !== readmeOrigin, `README names ${mirror} as both the canonical origin and the mirror`);
  assert(readme.includes("That host is canonical"), "README does not say which host is canonical");
  const origin = (options.origin ?? readmeOrigin).replace(/\/+$/u, "");

  const state = JSON.parse(readFileSync(path.join(options.out, "state.json"), "utf8")) as DaoState;
  assert.equal(typeof state.treasury.settled, "boolean", "state.json lacks settled");
  assert.match(state.treasury.depositTreasury, /^\d+$/u, "state.json lacks raw depositTreasury");
  assert.match(state.treasury.shareLiability, /^\d+$/u, "state.json lacks raw shareLiability (phase 5 ruling 4c)");
  for (const proposal of state.proposals) {
    assert(Array.isArray(proposal.flags), `state.json proposal ${proposal.id} lacks flags[]`);
    assert.match(proposal.treasuryEffect.usdcApproved, /^\d+$/u, `state.json proposal ${proposal.id} lacks treasuryEffect.usdcApproved (phase 5 ruling 6)`);
    // A5-11: the instance panel is bound to the decoded calls, never to the details JSON.
    if (proposal.instance !== undefined) {
      const called = proposal.calls.map((call) => getAddress(call.to));
      assert(called.includes(getAddress(proposal.instance.address)), `state.json proposal ${proposal.id} shows an instance panel for ${proposal.instance.address}, which none of its calls touches`);
    }
  }
  assert.equal(state.chain.id, deployment.chainId, "state.json chain id differs from the deployment");
  assert.equal(state.constitution.textHash, deployment.constitution.textHash, "constitution hash differs from the deployment");
  assert(readme.includes(state.constitution.textHash), "README lacks the constitution hash");
  const addresses = new Map<string, string>();
  for (const [name, address] of Object.entries(state.contracts)) addresses.set(getAddress(address), `contracts.${name}`);
  for (const proposal of state.proposals) if (proposal.instance) addresses.set(getAddress(proposal.instance.address), `proposal ${proposal.id} instance`);
  for (const [address, label] of addresses) {
    const code = await env.publicClient.getCode({ address: address as `0x${string}` });
    assert(code !== undefined && code !== "0x", `${label} ${address} has no code on chain ${deployment.chainId}`);
  }
  for (const name of ["safe", "baal", "shares", "settlement", "depositShaman", "workManager", "templateFactory", "intentAccount"]) {
    const address = state.contracts[name];
    assert(address !== undefined && isAddress(address) && readme.includes(getAddress(address)), `README lacks the ${name} address`);
  }
  for (const name of ["snippet.js", "snippet.py", "llms.txt", "index.html"]) {
    const text = readFileSync(path.join(options.out, name), "utf8");
    assert(!/\{\{[A-Z_]+\}\}/u.test(text), `${name} has unfilled placeholders`);
  }
  const html = readFileSync(path.join(options.out, "index.html"), "utf8");
  assert(!/gradient|lucide|\bInter\b|Geist|Space Grotesk|purple|#000\b|#000000|#fff\b|#ffffff|box-shadow|border-radius/iu.test(html), "dashboard uses a forbidden design token (gradient, purple, black, white, shadow, radius, AI fonts)");
  assert(!/[—\p{Extended_Pictographic}]/u.test(html), "dashboard contains an em dash or emoji");
  assert(!/<form\b|<iframe\b/iu.test(html), "dashboard must not contain forms or iframes");
  const constitution = readFileSync(path.join(options.out, "CONSTITUTION.md"));
  assert.equal(keccak256(constitution), state.constitution.textHash, "published CONSTITUTION.md bytes do not hash to the on-chain constitution hash");

  // Live checks. Without these a beacon whose origin challenges a plain GET validates green.
  const { paths, offOrigin } = advertisedPaths(readme, origin);
  const member = state.members[0]?.address ?? deployment.founder;
  if (options.custodial !== undefined && !isAddress(options.custodial)) throw new Error(`--custodial must be an address, got ${options.custodial}`);
  const probes = probesFor(origin, getAddress(member), deployment.chainId, readme, state.constitution.textHash, options.custodial);
  const covered = new Set(probes.flatMap((probe) => probe.covers));
  const uncovered = paths.filter((advertised) => !covered.has(advertised));
  assert.deepEqual(uncovered, [], `the README advertises ${JSON.stringify(uncovered)} on ${origin} and this validator does not fetch it: add it to probesFor()`);
  if (options.noFetch === true) {
    console.error(`   SKIPPED the live fetches against ${origin} (--no-fetch); a beacon whose origin answers a bot challenge would pass this run`);
    return { result: "PASS", fetched: "SKIPPED", origin, mirror, advertised: paths, readmeLines: lines.length, readmeLineLimit: 44, addressesWithCode: addresses.size, proposals: state.proposals.length, tasks: state.tasks.length, members: state.members.length, block: state.chain.blockNumber };
  }
  console.error(`   fetching every URL the README advertises on ${origin} (${paths.length} advertised paths, ${probes.length} probes)`);
  const fetched: Array<Record<string, unknown>> = [];
  for (const probe of probes) fetched.push(await runProbe(origin, probe));

  // The constitution URL the README publishes may live on another host (a pinned GitHub raw URL): fetch
  // it wherever it points and hash the bytes, because that is the URL an agent is told to read (A5-14).
  const constitutionUrl = /Constitution (https?:\/\/\S+?) keccak256/u.exec(readme)?.[1];
  assert(constitutionUrl !== undefined, "README does not publish a constitution URL");
  const constitutionResponse = await fetch(constitutionUrl, { redirect: "follow" });
  assert.equal(constitutionResponse.status, 200, `the constitution URL the README publishes (${constitutionUrl}) answered ${constitutionResponse.status}`);
  const constitutionBytes = new Uint8Array(await constitutionResponse.arrayBuffer());
  assert.equal(keccak256(constitutionBytes), state.constitution.textHash, `the bytes at ${constitutionUrl} do not hash to the on-chain constitution hash`);
  console.error(`   fetched ${constitutionUrl} -> 200 (${constitutionBytes.length} bytes, hash matches on chain)`);

  return {
    result: "PASS",
    fetched: fetched.length,
    origin,
    mirror,
    mirrorProbed: origin === mirror,
    advertised: paths,
    offOriginUrls: offOrigin,
    constitutionUrl,
    custodyProbed: { selfCustody: NOT_DERIVABLE, custodialLite: options.custodial === undefined ? null : getAddress(options.custodial) },
    probes: fetched,
    readmeLines: lines.length,
    readmeLineLimit: 44,
    addressesWithCode: addresses.size,
    proposals: state.proposals.length,
    tasks: state.tasks.length,
    members: state.members.length,
    block: state.chain.blockNumber,
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  validateBeacon({
    deployment: args.deployment ?? process.env.ZERO_ONE_DEPLOYMENT ?? "deployments/local.json",
    out: path.resolve(ROOT, args.out ?? "beacon/public"),
    origin: args.origin === "mirror" ? MIRROR_ORIGIN : args.origin,
    noFetch: args["no-fetch"] === "1",
    custodial: args.custodial,
  })
    .then((summary) => console.log(json(summary)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
