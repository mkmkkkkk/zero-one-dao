# Mainnet service installer

`scripts/install-mainnet-services.py --deployment deployments/base.json --sponsor-key <file> --dry-run`
prints complete launchd plists, environment, selected port, separate tunnel ingress, commands and
an existing build's README. Dry-run does not create files, query RPC/Cloudflare, bootstrap jobs or
send transactions. Local launchctl discovery is read-only; the port check briefly binds and closes
a socket without listening. A Base Sepolia record is accepted only in dry-run and visibly labelled
`rehearsalOnly: true`; it remains Sepolia in the built README.

Remove `--dry-run` only after mainnet launch approval. Apply builds and locally validates the beacon,
creates the separate `zero-one-relay-base` named tunnel, adds its DNS route without overwrite,
bootstraps `ai.mkyang.zero-one-relay-base` and `ai.mkyang.zero-one-tunnel-base`, then runs the full
public beacon validator. This installs an operational relay which can sponsor user requests;
the installer itself contains no chain transaction or contract deployment commands.

The sponsor file must be a user-owned, non-symlink 0600 file with a `RELAY_SPONSOR_KEY=0x...` line
(the existing relay's env-file format). No key is embedded in a plist or output. Existing node,
local tsx dependencies, cloudflared, compiled contract artifacts and the user's Cloudflare origin
certificate at `~/.cloudflared/cert.pem` are prerequisites. No login, registration, funding or
purchases are performed. The hostname defaults to the Mainnet relay hostname DECIDE line in
PARAMETERS.md; `.invalid` is a preview placeholder and blocks apply. `--hostname` supplies the
confirmed choice. `--port` requires an available non-Sepolia port; otherwise the installer selects
and persists the first free port after the discovered live Sepolia port. `--beacon-dir` overrides
`beacon/public-base`, for example for the temporary rehearsal build.

The existing pair is discovered by `launchctl print gui/<uid>/<label>` and its actual plist and
repo `state/tunnel` configuration are inspected. Those files and labels are never write/restart
targets. A new tunnel is intentional: adding ingress to the live tunnel would require changing its
config or restarting it. The new tunnel uses QUIC and ephemeral loopback metrics, both jobs set HOME
and KeepAlive, and the relay binds loopback only. DNS is not routed through the Sepolia tunnel.

State is fixed at `state/relay-base`. Symlinked destinations, overlaps with live state/beacon/key,
unowned nonempty state, mismatched chain/DAO identity, occupied ports, existing unowned output/jobs,
and the live hostname are refused. Beacon build/validation caches use `state/tunnel-base/beacon-cache`,
so even failed builds do not seed the relay's request/T0 state. The sponsor key stays outside generated
artifacts. No `.env`, credential, runtime state or deployment record belongs in the installer commit.

Unchanged configuration with both jobs loaded is a no-op. It also verifies the listener belongs to
the mainnet launchd process when the port is occupied. Missing own jobs can be bootstrapped on rerun.
An interrupted pre-bootstrap install can resume from its manifest, including missing tunnel credentials.
A changed deployment cannot reuse the old state. Other configuration changes are printed but refused
while either own job is loaded: intentionally no implicit restart. Stop only those mainnet jobs in a
separately approved maintenance task and rerun after review. A failed public validator exits nonzero;
it leaves the newly installed mainnet jobs available for diagnosis and does not roll back DNS or
interfere with Sepolia. Concurrent apply invocations serialize with a file lock and repeat preflight.
Cloudflare errors (including a name already claimed without local credentials) stop installation;
there is no automatic adoption of unknown tunnels or overwrite of existing DNS.

The local checks and current-tree dry-runs are recorded in `evidence/phase5/mainnet-bringup/`.
They prove the plan, refusal paths, static README wiring and preservation of the existing services.
They do not claim mainnet deployment, sponsor funding, live mainnet ingress or public mainnet validation.
