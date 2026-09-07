/**
 * Generate a fresh private key into a mode-0600 file (creating the directory 0700) and print only the
 * address. Used on the Mac mini for the relay sponsor (`state/relay.env`, line RELAY_SPONSOR_KEY=...)
 * and for scenario actors. Refuses to overwrite an existing file.
 * Usage: tsx scripts/testnet-key.ts --out <file> [--var RELAY_SPONSOR_KEY]   (--var writes NAME=0x.. instead of the bare key)
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { parseArgs } from "../beacon/scripts/build.js";

const args = parseArgs(process.argv.slice(2));
const out = args.out;
if (out === undefined) throw new Error("--out <file> is required");
if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a key file`);
mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
chmodSync(path.dirname(out), 0o700);
const key = generatePrivateKey();
writeFileSync(out, args.var !== undefined ? `${args.var}=${key}\n` : `${key}\n`, { mode: 0o600, flag: "wx" });
chmodSync(out, 0o600);
console.log(JSON.stringify({ file: out, address: privateKeyToAccount(key).address }));
