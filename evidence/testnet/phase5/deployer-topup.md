# Base Sepolia deployer top-up — 2026-09-11

The deployer funding gate (`src/deployerGate.ts`, `docs/PARAMETERS.md` line 88) is now one rule on
every chain: a deployment needs `max(measured deployment gas x live base fee x 5, 0.02 ETH)`. At Base
Sepolia fees the binding term is the 0.02 ETH floor, so the Base Sepolia deployer had to be topped up
with free test ETH before it could redeploy. This is a top-up, not a parameter change.

Deployer: `0x71208DBf8DD681c5FC2998c8192B633677BFcc10` (key file `~/srv/aow-exit/.env.sepolia`, var
`ANCHOR_PRIVATE_KEY`, mode 0600 on the Mac mini). Every transaction below is Base Sepolia (84532) or
Ethereum Sepolia (11155111). No Base mainnet transaction was made.

## Result

| | Base Sepolia | Ethereum Sepolia |
|---|---|---|
| before | **0.000898124954079328 ETH** | 0.013152867994546495 ETH |
| after | **0.023191149621950376 ETH** | 0.000272865235425677 ETH |

The gate at 0.02 ETH now passes with 0.003191 ETH of headroom — proven by calling the gate itself
(`assertDeployerFunded`) against the live balance, receipt `evidence/testnet/phase5/deployer-topup-gate.log`:

```
0.02 ETH: 24754842 gas (measured over 22 transactions, evidence/phase5/base-fork/measurements.json)
  x 0.005 gwei live base fee x 5 = 0.00061887105 ETH, floor 0.02 ETH governs
ASSERT deployer 0x71208DBf8DD681c5FC2998c8192B633677BFcc10 holds 0.023191149621950376 ETH ... GATE PASSES
```
 **The 0.03 ETH target was not
reached — it is 0.006808850378049624 ETH short**, and it cannot be reached from funds this project
controls: see "What is left" below.

The brief's figure of "roughly 0.0057 test ETH" did not match the chain. The deployer held
0.000898124954079328 ETH when this run started; 0.0053 was its balance in
`evidence/testnet/sponsor-topup-2026-09-08.log`, three days and several funding runs ago.

## Route 1 — Base Sepolia faucets: every one tried is gated

Tried from the Mac mini over the Clash proxy (`HTTPS_PROXY=http://127.0.0.1:7897`). None can be
claimed from a CLI; each needs an interactive browser for a captcha, an OAuth login, or both.

| Faucet | HTTP | What it returned |
|---|---|---|
| `sepolia-faucet.pk910.de` (PoW, Ethereum Sepolia) | 200 | Config reachable (`minClaim` 0.05, `maxClaim` 2.5 SepETH) but `modules.captcha.requiredForStart: true`. `POST /api/startSession` answered `{"status":"failed","failedCode":"INVALID_CAPTCHA","failedReason":"captcha check failed: captcha token missing"}`. The challenge script at `faucets.pk910.de/captcha/captchaChallenge.php` loads hCaptcha / reCAPTCHA / Turnstile plus FingerprintJS. |
| `faucets.pk910.de` hub | 200 | Lists only sepolia, holesky, hoodi, ephemery. There is no pk910 PoW faucet for Base Sepolia. |
| `faucet.quicknode.com/base/sepolia` | 200 | "no Quicknode account, no post on X and no minimum mainnet balance" — but the flow is "enter your wallet address ... then complete the verification". The claim UI and its verification widget are injected client-side; the served HTML carries no API route. Browser-only. |
| `www.alchemy.com/faucets/base-sepolia` (also where `basefaucet.com` redirects) | 200 | Requires >= 0.001 ETH and history on Ethereum **mainnet**. We hold no such address for this project. |
| `www.ethereum-ecosystem.com/faucets/base-sepolia` | **402** | `Payment required / DEPLOYMENT_DISABLED` (Vercel). The site is offline, not gated. |
| `faucet.triangleplatform.com/base/sepolia` | **503** | Service unavailable. |
| `bwarelabs.com/faucets/base-sepolia` | **530** | Cloudflare origin error. |
| `faucet.zalalena.com/base` | 200 | Page carries hCaptcha + Turnstile + login. |
| `faucet.trade/base-sepolia-eth-faucet` | 200 | hCaptcha + reCAPTCHA. |
| `www.l2faucet.com/base` | 200 | GitHub / X login. |
| `faucetme.pro` | 200 | GitHub / X login. |
| `getblock.io/faucet/base-sepolia/` | 200 | Login + Turnstile. |
| `faucet.chainstack.com/base-testnet-faucet` | 200 | Login (its API faucet needs a Chainstack API key). |
| `cloud.google.com/application/web3/faucet/ethereum/sepolia` | 200 | Google sign-in + reCAPTCHA. |
| `tokentool.bitbond.com/faucet/base-sepolia` | 200 | Wallet-connect SPA; no server route in the served HTML. |

No Alchemy, QuickNode, Coinbase CDP, Chainstack or Infura credential exists in
`nerve/state/credentials_vault.json`, `nerve/resources_catalog.json`,
`AAA_RESOURCE_INVENTORY_MASTER.md`, `~/.zshrc` or any project env file (searched by provider name and
by env-var name).

## Route 2 — bridge Ethereum Sepolia ETH through the OptimismPortal

`scripts/bridge-sepolia-to-base.ts` (new). The portal's `receive()` forwards a plain ETH transfer to
`depositTransaction(msg.sender, msg.value, RECEIVE_DEFAULT_GAS_LIMIT, false, "")`, so the same amount
is minted to the **same address** on Base Sepolia. Before sending, the script refuses any L1 chain id
other than 11155111, any L2 chain id other than 84532, and any portal whose `l2Sender()` is not the
idle sentinel — it cannot be pointed at a mainnet bridge.

Portal `0x49f53e41452C74589E85cA1677426Ba426459e85`, `version()` = `5.2.0`, `l2Sender()` =
`0x...dEaD`, escrow balance ~1.27M ETH.

- L1 deposit: `0xb813a281f772fb11904bee1a707f2b98a9d7b865bc46494da0b16bc6904dc678`
  (Sepolia block 11680928, gasUsed 90299, maxFeePerGas 3.710053508 gwei)
- bridged: **0.012738603419843215 ETH** (the whole L1 balance minus the gas reserve)
- Base Sepolia balance 0.000898124954079328 -> **0.013636728373922543 ETH**, credited within the
  600 s wait

Receipt: `evidence/testnet/phase5/deployer-topup-bridge.log`.

## Route 3 — sweep test ETH out of finished scenario keys

`scripts/sweep-testnet-eth.ts` (new). Base Sepolia only (refuses any other chain id); each source
keeps three times the estimated total fee (L2 execution + OP-stack L1 data fee) and sends the rest.
29 accounts, all successful, **0.009554421248027833 ETH** moved to the deployer:

| source | accounts | ETH |
|---|---|---|
| `state/testnet/actors.json` (A,B,C,D,O,W) | 6 | 0.004231962 |
| `state/testnet-phase5-corners/actors.json` | 6 | 0.001030290 |
| `state/testnet-phase5-ledger/actors.json` | 6 | 0.000649743 |
| `state/testnet-phase5-k/actors.json` | 6 | 0.001072448 |
| founder keys (corners, k, ledger, weth) | 4 | 0.001233076 |
| `state/relay-phase5-corners-sponsor.env` (disposable phase-5 corners sponsor, not running) | 1 | 0.001336901 |

Per-account amounts and all 29 transaction hashes: `evidence/testnet/phase5/deployer-topup-sweep.log`.

**Deliberately not swept:** `state/relay-phase5-corners-sponsor.env`'s live sibling
`state/relay.env` — sponsor `0xecA60CAb6dc8fdBdFC9da022f70efa0Ee79A24Bd`, 0.004314073494324124 ETH.
That key funds the relay `ai.mkyang.zero-one-relay` is running with right now (launchd PID 50195,
`relay-zero.mkyang.ai`). Taking it would stop sponsored governance, and it would still leave the
deployer at 0.027505 ETH — below the 0.03 target. Breaking a live service without reaching the target
is not a trade worth making.

## What is left, and what a human has to do

Every address this project holds a key for was enumerated (39 keys across
`state/*/actors.json`, `state/*/founder.env`, the two relay sponsor env files and
`~/srv/aow-exit/.env.sepolia`) and its balance read on both chains. The complete owned float on the
two chains at the start of this run was 0.027931119 ETH. **0.03 ETH was never reachable from owned
funds**, with or without the live relay sponsor; only free test ETH from outside can close the gap.

To finish, one browser claim is enough — any of these overshoots the remaining 0.0069 ETH several
times over:

1. **`https://faucets.chain.link/base-sepolia`** — GitHub login + captcha, drips directly on Base
   Sepolia. Paste `0x71208DBf8DD681c5FC2998c8192B633677BFcc10`. Nothing else to run afterwards.
2. **`https://faucet.quicknode.com/base/sepolia`** — no account, captcha only; same address, same
   result.
3. **`https://cloud.google.com/application/web3/faucet/ethereum/sepolia`** or
   **`https://sepolia-faucet.pk910.de`** — these pay out on *Ethereum* Sepolia. Send to the same
   address, then re-run the bridge on the mini:
   ```
   ssh macmini
   cd ~/srv/zero-one-dao
   PATH=/opt/homebrew/bin:$PATH node_modules/.bin/tsx scripts/bridge-sepolia-to-base.ts --all true
   ```

Verify at any time with:
```
curl -s -X POST https://sepolia.base.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x71208DBf8DD681c5FC2998c8192B633677BFcc10","latest"]}'
```

## Note for whoever redeploys next

The mini's runtime checkout `~/srv/zero-one-dao` is behind the main-Mac checkout: its `src/live.ts`
has no `fmtGwei` export, so it predates the deployer-gate work in `docs/PARAMETERS.md` line 88. The
bridge script keeps its own gwei formatter for that reason. Sync the mini before relying on the gate
there.
