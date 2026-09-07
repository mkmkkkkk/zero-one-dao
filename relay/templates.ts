/**
 * `propose` for agents (decision.md phase 2b ruling 2): template name + JSON parameters -> the relay
 * quotes the deterministic CREATE2 instance (address, code hash, params hash, budget, proposalData)
 * with an eth_call of `TemplateFactory.quote` (nothing is deployed by the quote), and returns the
 * ONE op-0 intent to sign: data = abi.encode(template id, params, salt), details = summary + JSON.
 * The account derives the instance and the fund+start multicall from the signed data on-chain, so
 * the relay can never substitute code. The relay deploys the instance (sponsored) only when the
 * signed intent arrives and the address is still empty.
 */
import { encodeProposalData } from "../src/baal.js";
import { encodeParams, fundAndStartCalls, proposalDetails, proposeIntentData, TEMPLATE_CONTRACTS, TEMPLATE_IDS, TEMPLATE_NAMES, type ConfigParams, type PaymentParams, type ProjectParams, type StrategyParams, type TemplateInstance, type TemplateName, type TemplateSpec, type Tranche } from "../src/proposals.js";
import { loadLocalArtifact } from "../src/baal.js";
import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";

import type { Env } from "./common.js";
import { fail } from "./errors.js";

const UINT = /^(0|[1-9][0-9]{0,77})$/u;

function big(value: unknown, field: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && UINT.test(value)) return BigInt(value);
  return fail(400, `params.${field} must be a non-negative integer (decimal string)`);
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) fail(400, `params.${field} must be an address`);
  return getAddress(value);
}

function addresses(value: unknown, field: string): Address[] {
  if (!Array.isArray(value) || value.length === 0) fail(400, `params.${field} must be a non-empty array of addresses`);
  return value.map((item, index) => address(item, `${field}[${index}]`));
}

/**
 * Parse untrusted template parameters into a TemplateSpec.
 *
 * @param template Template name (Payment | Strategy | Project | Config).
 * @param raw Parsed JSON parameters.
 * @returns The spec with bigints.
 * @throws RelayError 400 for an unknown template or malformed parameters.
 */
export function parseSpec(template: string, raw: unknown): TemplateSpec {
  if (!(TEMPLATE_NAMES as readonly string[]).includes(template)) fail(400, `unknown template ${template}; use one of ${TEMPLATE_NAMES.join(", ")}`);
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || p === null) fail(400, "params must be a JSON object");
  switch (template as TemplateName) {
    case "Payment": {
      const recipients = addresses(p.recipients, "recipients");
      if (!Array.isArray(p.amounts) || p.amounts.length !== recipients.length) fail(400, "params.amounts must match params.recipients");
      const amounts = p.amounts.map((item, index) => big(item, `amounts[${index}]`));
      const params: PaymentParams = { recipients, amounts };
      return { template: "Payment", params };
    }
    case "Strategy": {
      const rule = (p.rule ?? {}) as Record<string, unknown>;
      const params: StrategyParams = {
        venue: address(p.venue, "venue"),
        asset: address(p.asset, "asset"),
        budget: big(p.budget, "budget"),
        rule: { maxPerRun: big(rule.maxPerRun, "rule.maxPerRun"), minInterval: big(rule.minInterval ?? 0, "rule.minInterval"), deadline: big(rule.deadline, "rule.deadline"), takeProfitBps: big(rule.takeProfitBps ?? 0, "rule.takeProfitBps"), stopLossBps: big(rule.stopLossBps ?? 0, "rule.stopLossBps") },
      };
      return { template: "Strategy", params };
    }
    case "Project": {
      if (!Array.isArray(p.tranches) || p.tranches.length === 0) fail(400, "params.tranches must be a non-empty array");
      const tranches: Tranche[] = p.tranches.map((item, index) => {
        const t = (item ?? {}) as Record<string, unknown>;
        const releaseType = t.releaseType === "verifiers" ? "verifiers" : t.releaseType === "date" ? "date" : fail(400, `params.tranches[${index}].releaseType must be date or verifiers`);
        return {
          amount: big(t.amount, `tranches[${index}].amount`),
          releaseType,
          releaseAt: big(t.releaseAt ?? 0, `tranches[${index}].releaseAt`),
          verifiers: releaseType === "verifiers" ? addresses(t.verifiers, `tranches[${index}].verifiers`) : [],
          threshold: releaseType === "verifiers" ? Number(big(t.threshold ?? 1, `tranches[${index}].threshold`)) : 0,
        };
      });
      const params: ProjectParams = { tranches, deadline: big(p.deadline ?? 0, "deadline") };
      return { template: "Project", params };
    }
    case "Config": {
      const params: ConfigParams = {
        votingPeriod: Number(big(p.votingPeriod, "votingPeriod")),
        gracePeriod: Number(big(p.gracePeriod, "gracePeriod")),
        proposalOffering: big(p.proposalOffering ?? 0, "proposalOffering"),
        quorumPercent: big(p.quorumPercent ?? 0, "quorumPercent"),
        sponsorThreshold: big(p.sponsorThreshold, "sponsorThreshold"),
        minRetentionPercent: big(p.minRetentionPercent, "minRetentionPercent"),
      };
      return { template: "Config", params };
    }
  }
}

export interface Quote {
  instance: TemplateInstance;
  /** Whether code already exists at the instance address. */
  exists: boolean;
  /** abi.encode(template id, params, salt): the `data` field of the op-0 intent. */
  intentData: Hex;
  proposalData: Hex;
  details: string;
  calls: Array<{ to: Address; data: Hex }>;
}

/**
 * Quote the deterministic instance for (spec, member, salt) without deploying it: eth_call
 * `TemplateFactory.quote` (which deploys inside the call and describes the result), then build the
 * exact op-0 intent data, the proposalData and the details JSON (template, instance, operator,
 * budget, deadline, params, paramsHash, codeHash, salt).
 *
 * @param env The connected environment.
 * @param member The proposer; becomes the instance's operator.
 * @param spec Template and parameters.
 * @param summary One-line summary prefixed to the details JSON.
 * @param salt CREATE2 salt (the relay uses the member's intent nonce).
 * @returns The quote.
 * @throws RelayError 422 when the factory refuses the parameters (decoded reason) or when the
 *   factory's proposalData differs from the builder's.
 */
export async function quoteProposal(env: Env, member: Address, spec: TemplateSpec, summary: string, salt: Hex): Promise<Quote> {
  const dao = { safe: env.deployment.safe, settlement: env.deployment.settlement, baal: env.deployment.baal, templateFactory: env.deployment.templateFactory };
  const paramsBytes = encodeParams(spec);
  const templateId = TEMPLATE_IDS[spec.template];
  const simulation = await env.publicClient.simulateContract({ address: dao.templateFactory, abi: env.abi.factory, functionName: "quote", args: [templateId, paramsBytes, member, salt], account: member } as never);
  const [instanceAddress, codeHash, paramsHash, budget, deadline, onChainData] = simulation.result as unknown as [Address, Hex, Hex, bigint, bigint, Hex];
  const localParamsHash = keccak256(paramsBytes);
  if (paramsHash !== localParamsHash) fail(422, `paramsHash mismatch: factory ${paramsHash}, local ${localParamsHash}`);
  const existing = await env.publicClient.getCode({ address: instanceAddress });
  const exists = existing !== undefined && existing !== "0x";
  const artifact = loadLocalArtifact(TEMPLATE_CONTRACTS[spec.template]) as { compiler?: string };
  const instance: TemplateInstance = {
    address: getAddress(instanceAddress),
    deployHash: undefined,
    salt,
    paramsBytes,
    template: spec.template,
    contractName: TEMPLATE_CONTRACTS[spec.template],
    compiler: artifact.compiler ?? "unknown",
    spec,
    paramsHash,
    codeHash,
    description: { template: spec.template, paramsHash, operator: getAddress(member), budget, deadline, status: "Pending" },
  };
  const calls = fundAndStartCalls(dao, instance);
  const proposalData = encodeProposalData(calls).toLowerCase() as Hex;
  if (proposalData !== onChainData.toLowerCase()) fail(422, `TemplateFactory.proposalData (${onChainData.length} bytes) differs from the builder's multicall (${proposalData.length} bytes)`);
  return { instance, exists, intentData: proposeIntentData(spec.template, paramsBytes, salt), proposalData, details: proposalDetails(instance, summary), calls: calls.map((call) => ({ to: call.to, data: call.data })) };
}

/** Template name for a factory template id. */
export function templateNameOf(templateId: number): TemplateName {
  const name = TEMPLATE_NAMES[templateId];
  if (name === undefined) fail(400, `unknown template id ${templateId}`);
  return name;
}
