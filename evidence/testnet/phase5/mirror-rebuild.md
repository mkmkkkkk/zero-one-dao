# Vercel mirror rebuild receipt

Recorded 2026-09-11T08:12:28.218323+00:00. Source commit: f0c134a (main).

Existing project `zero-one-beacon`, ID `prj_9ZTM6ovfrSr6Db3BFliYDpbfEd1I`. Deployment `dpl_BnFcMHtWFgfs1eyra3PD9x2JtudR` is READY; the independent project GET confirms it is the production target. Production aliases are unchanged: zero-one-beacon.vercel.app, zero-one-beacon-michaelyangs-projects-ce4b2cbd.vercel.app. No new project or domain was created; no push, contract change or transaction was performed.

## Build and deployment

Built the current templates, without editing README by hand, using `deployments/base-sepolia.json` (chain 84532). Build block: 46672912. Build command:

```sh
npm run beacon:build -- --deployment deployments/base-sepolia.json --origin https://zero-one-beacon.vercel.app --mirror https://relay-zero.mkyang.ai --out beacon/public-mirror-rebuild
```

`--mirror` is explicitly the other origin because the old build named Vercel as both origins. Only host substitutions differ from the canonical README. The current template's generic "That host is canonical" sentence is unchanged; this task rebuilds the existing template and does not redesign its terminology.

Used the existing `beacon/scripts/vercel.ts` API/deploy functions after GET `/v9/projects/zero-one-beacon` verified the expected project ID, then `deploy({project: "prj_9ZTM6ovfrSr6Db3BFliYDpbfEd1I", outDir: absolute build directory})`. Credentials stayed in the existing credential file and curl stdin. Static upload: 8 files; dynamic state/proposals snapshots were excluded by the deployment script so canonical rewrites apply. No environment files, keys, or relay state are included in this evidence commit.

Actual deploy output:
```json
{
  "id": "dpl_BnFcMHtWFgfs1eyra3PD9x2JtudR",
  "url": "zero-one-beacon-4rilek3ve-michaelyangs-projects-ce4b2cbd.vercel.app",
  "readyState": "READY",
  "aliases": [
    "zero-one-beacon.vercel.app",
    "zero-one-beacon-michaelyangs-projects-ce4b2cbd.vercel.app"
  ],
  "files": 8
}
```

## Red to green

Before deployment, the unchanged validator exited 1:
```text
AssertionError [ERR_ASSERTION]: the README served by the origin is not the one this build produced
```
See [validate-before.log](mirror-rebuild/validate-before.log), [before.diff](mirror-rebuild/before.diff), and captured before READMEs/headers. The old file omitted the raw-unit rule, settlement source, optional exit amount and key-file note.

After deployment, the same command exited 0:
```sh
npm run beacon:validate -- --deployment deployments/base-sepolia.json --out beacon/public-mirror-rebuild --origin https://zero-one-beacon.vercel.app --custodial 0x321D04C0ED837304F90162e55e76317378038fF2
```
Actual summary fields:
```json
{
  "result": "PASS",
  "fetched": 15,
  "origin": "https://zero-one-beacon.vercel.app",
  "custodyProbed": {
    "selfCustody": "0x00000000000000000000000000000000C0FFEE01",
    "custodialLite": "0x321D04C0ED837304F90162e55e76317378038fF2"
  },
  "readmeLines": 44,
  "addressesWithCode": 15
}
```
The full unmodified stdout/stderr is [validate-after.log](mirror-rebuild/validate-after.log). It includes all 15 live probes and the independently fetched published constitution hash check. `mirrorProbed` in the validator summary is false because that field compares the tested origin to the README's secondary origin, which is canonical for this build; the command, summary origin and every probe clearly target Vercel.

Independent curl output:
```text
README origin-only diff: True; served matches build: True; HTTP assertions: 17/18
member: 200 application/json; charset=utf-8; custody=custodial-lite
```
The 18 probes include extra checks beyond the validator. The sole failed assumption is the literal shorthand `/me`: it returns JSON 404. The documented concrete `/me/<address>.json` route returns 200 and the required custody. This existing shorthand discrepancy is recorded, not hidden or changed in this static rebuild.

`/me/pass/` was probed with an all-zero synthetic, unregistered hash: expected JSON 404 was received. A successful response for a real pass hash remains **unknown**; no pass, key, state file or account was accessed or created for this check. `/relay` was tested only with read-only `op=quote`; mutating GET examples were not executed.

## HTTP assertions and challenges

No bot challenge was observed in either validator run or the independent probes. Exact status lines and full response headers are saved as individual `.headers` files next to [assertions.json](mirror-rebuild/assertions.json) and [probes.log](mirror-rebuild/probes.log), which map each URL to its header file. JSON response bodies were parsed in temporary storage and moved to Trash after probing; only status, type, body digest and the required custody assertion are retained here.

| URL | Status | Content type | Assertion |
| --- | --- | --- | --- |
| https://zero-one-beacon.vercel.app/README.txt | 200 | text/plain; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/llms.txt | 200 | text/plain; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/snippet.js | 200 | application/javascript; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/snippet.py | 200 | application/octet-stream | OK |
| https://zero-one-beacon.vercel.app/CONSTITUTION.md | 200 | text/markdown; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/robots.txt | 200 | text/plain; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/ | 200 | text/html; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/health.json | 200 | application/json; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/state.json | 200 | application/json; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/proposals.json | 200 | application/json; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/pending.json | 200 | application/json; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/me/0x321D04C0ED837304F90162e55e76317378038fF2.json | 200 | application/json; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/me/0x00000000000000000000000000000000c0ffee01.json | 200 | application/json; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/me | 404 | application/json; charset=utf-8 | FINDING: literal /me is not a member document |
| https://zero-one-beacon.vercel.app/me/pass/0000000000000000000000000000000000000000000000000000000000000000.json | 404 | application/json; charset=utf-8 | OK |
| https://zero-one-beacon.vercel.app/relay?op=quote&member=0x321D04C0ED837304F90162e55e76317378038fF2&template=Payment&params=%7B%22recipients%22%3A+%5B%220x321D04C0ED837304F90162e55e76317378038fF2%22%5D%2C+%22amounts%22%3A+%5B%221000000%22%5D%7D&summary=mirror+rebuild+read+only+probe | 200 | application/json; charset=utf-8 | OK |
| https://relay-zero.mkyang.ai/README.txt | 200 | text/plain; charset=utf-8 | OK |
| https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/06a0bf010480dbbab2cca58892dc5a1ee1a95ff7/docs/CONSTITUTION.md | 200 | text/plain; charset=utf-8 | OK |

## Fetched README diff

Both fetched READMEs return 200 text/plain. The mirror bytes equal the local generated README. Replacing only the two literal origin URLs with `<ORIGIN>` makes the files byte-identical. Full actual diff:

```diff
--- canonical/README.txt
+++ mirror/README.txt
@@ -1,10 +1,10 @@
 Zero One | Any member can propose anything; only the other members' votes or exits can stop it.
-Chain Base Sepolia (84532). Relay https://relay-zero.mkyang.ai. Settlement USDC (6 dec). Shares: 18 dec, non-transferable, weight and exit.
-That host is canonical: it serves this file, the snippets, the dashboard and every endpoint below. Mirror https://zero-one-beacon.vercel.app has the same files and forwards /relay, but a mirror can answer a plain GET with a bot challenge page, so read from https://relay-zero.mkyang.ai.
+Chain Base Sepolia (84532). Relay https://zero-one-beacon.vercel.app. Settlement USDC (6 dec). Shares: 18 dec, non-transferable, weight and exit.
+That host is canonical: it serves this file, the snippets, the dashboard and every endpoint below. Mirror https://relay-zero.mkyang.ai has the same files and forwards /relay, but a mirror can answer a plain GET with a bot challenge page, so read from https://zero-one-beacon.vercel.app.
 Constitution https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/06a0bf010480dbbab2cca58892dc5a1ee1a95ff7/docs/CONSTITUTION.md keccak256 0xebc7c39cf14fdc0ac2c028cdba5960ecc4560a314e613b93b4585b62826f2d9a (immutable, on-chain at 0xF4cDf63FCD19bBf7285D089b848212ba2C34596F).
 In: USDC at NAV (1 share per USDC while empty). Out: ragequit any time, pro-rata, same block. Work: shares voted per task.
 Deposits pause while an open proposal contract still holds a non-USDC asset (a vote settles it, then they resume); Safe dust never pauses them; exit is pro-rata of the Safe only.
-Eight verbs. One signed intent each, sent as GET https://relay-zero.mkyang.ai/relay?intent=<base64url JSON {message,signature[,authorization]}>.
+Eight verbs. One signed intent each, sent as GET https://zero-one-beacon.vercel.app/relay?intent=<base64url JSON {message,signature[,authorization]}>.
 message = {member, op, proposalId, amount, evidenceHash, data, details, nonce, deadline}; unused fields are 0 / "0x" / ""; every amount is raw units (USDC 6 dec, shares 18 dec), never whole tokens.
 join      GET /relay?op=join&authorization=<base64url {chainId,address,nonce,r,s,yParity}> attaches the adapter to your key; mints nothing
 deposit   op=5 amount=<USDC raw units: 25 USDC = 25000000>  pulls USDC from your address into the Safe, mints shares at NAV. Test chain: a fresh key needs no USDC, the relay tops this address up to amount inside the deposit (mainnet has no faucet: hold the USDC first; /me settlement.balance is what you hold).
@@ -25,13 +25,13 @@
 Templates (every amount raw: USDC 6 dec, shares 18 dec): Payment {recipients[],amounts[]} | Strategy {venue,asset,budget,rule{maxPerRun,minInterval,deadline,takeProfitBps,stopLossBps,slippageBps}}
            Project {tranches[{amount,releaseType:date|verifiers,releaseAt,verifiers[],threshold}],deadline} | Config {votingPeriod,gracePeriod,...}
 Every response is JSON: {ok:true, hash, ...} or {ok:false, status, reason, error:{name,args}} (decoded custom errors, never a bare revert).
-T1 (your own key; Node 18+ or Python 3, no packages): GET https://relay-zero.mkyang.ai/snippet.js or /snippet.py and run
+T1 (your own key; Node 18+ or Python 3, no packages): GET https://zero-one-beacon.vercel.app/snippet.js or /snippet.py and run
   node snippet.js join --key agent.key        python3 snippet.py join --key agent.key
   ... deposit --usdc 100 (whole USDC; --amount takes raw units) | vote --proposal 1 --approve yes | execute --proposal 1 | task --task 1 | deliver --task 1 --evidence "text"
   ... propose --template Payment --params '{"recipients":["0x.."],"amounts":["10000000"]}' (raw: 10 USDC) | ragequit [--amount <shares raw>] | work --verifiers a,b --reward-shares RAW
   ... confirm --task 1 --evidence "text" (verifier). propose checks the quoted intent (template id, salt, paramsHash; Payment params re-encoded) before signing.
 Each command reads /me, signs locally and prints the exact GET URL; fetch it. Address goes to stderr. The snippet creates the key file at 0600 when it is missing; keep it 0600.
-T0 (fetch only; custodial-lite: the relay derives and holds your key from your pass, so it can sign for you): GET https://relay-zero.mkyang.ai/relay?op=join&pass=<32..256 chars, >= 128 bits of entropy: openssl rand -hex 32>
+T0 (fetch only; custodial-lite: the relay derives and holds your key from your pass, so it can sign for you): GET https://zero-one-beacon.vercel.app/relay?op=join&pass=<32..256 chars, >= 128 bits of entropy: openssl rand -hex 32>
   same pass with op=deposit&amount=<USDC raw units> | op=vote&proposalId=&approve=yes | op=execute&proposalId= | op=task&taskId= | op=deliver&taskId=&evidence=
   op=propose&template=&params= | op=work&verifiers=&rewardShares= | op=confirm&taskId=&evidence= | op=ragequit[&amount=<shares raw units; default all>] ; op=identity&pass= gives your address
 Read: /me/<address>.json or /me/pass/<sha256 of your pass>.json (custody self-custody or custodial-lite, shares, NAV, settled, depositTreasury, shareLiability, exit value, settlement.balance = the USDC a deposit draws on, open proposals with deadlines, decoded calls, treasury effect and warnings[], myVote per open proposal, my tasks, nonce, ragequit data)
```

All evidence is under [mirror-rebuild/](mirror-rebuild/). No browser, listener, server or daemon was opened for this task. Build output remains in ignored `beacon/public-mirror-rebuild` for reproduction; no task process remains after collection. Unrelated pre-existing untracked files are excluded from the commit.

Evidence formatting: `git diff --cached --check` flags raw HTTP CRLF/status-line whitespace and captured log trailing blank lines. These are retained deliberately to preserve the exact headers and validator output; no hook was bypassed.
