# Mainnet bring-up rehearsal receipts (2026-09-17 task)

Scope: installer implementation and dry-run only, on the existing Mac mini checkout. All receipts
are local files in this directory. No mainnet deployment record exists. No relay/tunnel was started,
restarted or reconfigured; no Cloudflare create/route command or chain transaction was executed.

- `red-before-implementation.log`: the requested script did not exist (exit 2).
- `red-permission-guard.log`: independent negative control disables only the permissions guard in
  memory; the refusal test fails. `tests.log`: restored implementation, 15 tests green, including
  occupied/automatic port, label/hostname/state/beacon collisions, no writes, deterministic plans,
  no-op and interrupted-provisioning recovery. Tests operate on temporary directories and mock job
  discovery; they do not run launchctl mutations or cloudflared provisioning.
- `missing-record.log`: current tree fails naming `deployments/base.json` (exit 1).
- `fixture-dry-run.log`: copied Sepolia record, complete plists, QUIC ingress, port and commands.
  `ingress-validate.log`: cloudflared locally parses that exact new ingress and reports OK; no tunnel started.
- `key-permissions.log`, `port-collision.log`, `ingress-collision.log`: actual CLI preflight refusals.
- `beacon-build-isolated.log`, `beacon-validate.log`: actual npm build and local validation against
  the copied record; only chain reads. Public fetches are explicitly SKIPPED because the hostname is
  a placeholder. `beacon-build.log` retains the first successful build: that first invocation used
  the builder's default **non-live** `state/relay` index cache. Inspection caught that implicit write;
  the installer now sets an independent cache path and the final build/validation use a temp cache.
  The running Sepolia state directory is `state/relay-base-sepolia-phase5`, never used by these builds.
- `built-beacon-dry-run.log`: a second plan with RELAY_BEACON_DIR pointing to the real temp build and
  its full README; `served-README.txt` preserves the public artifact after temp cleanup.
- `static-serving.log`: directly invokes `relay/static.ts` (no server): `/README.txt`, text/plain,
  byte-identical to the built artifact, visibly Base Sepolia (84532). This is a rehearsal, not a
  claim that the fixture is a mainnet deployment.
- `dry-run-filesystem-proof.json`: independently hashes the fixture tree and checks all proposed
  output directories/plists before/after actual dry-runs; identical, repeated output identical.
- `before.json`, `after.json`, `sepolia-before-after.diff`: actual old service plist contents,
  ingress, launchctl PIDs/runs and lsof listener. Diff is deliberately empty (0 bytes).
  `sepolia-preservation.json` gives explicit assertions. Raw before/after launchctl reads are included.

`temp-path.txt` records the historical temporary fixture path. The fixture contained a synthetic,
unfunded test sponsor value, was never used to start a relay, and was moved to Trash on completion.
Keys, deployment copies, beacon state snapshots and runtime caches are not committed here.

Future apply is intentionally untested: mainnet hostname is DECIDE, `deployments/base.json` is absent,
and live mainnet activity is outside this task. A new named tunnel is the proposed isolation choice.
The installer builds only the canonical beacon; provisioning a mainnet mirror remains outside it.
