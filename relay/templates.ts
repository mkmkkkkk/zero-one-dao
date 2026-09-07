/**
 * `propose` for agents: template name + JSON parameters -> the relay deploys the instance with the
 * member as operator (sponsored gas), builds the fund+start multicall with src/proposals.ts and
 * returns instance address, code hash, params hash, proposalData and details. The member then signs
 * the op-0 intent that submits the Baal proposal (T1) or the relay signs it with the T0 key.
 */
import { getAddress, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";

import type { WriteContext } from "../src/baal.js";
import { deployTemplate, fundAndStartCalls, proposalDetails, TEMPLATE_NAMES, type ConfigParams, type PaymentParams, type ProjectParams, type StrategyParams, type TemplateInstance, type TemplateName, type TemplateSpec, type Tranche } from "../src/proposals.js";
import { encodeProposalData } from "../src/baal.js";
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

export interface Prepared {
  instance: TemplateInstance;
  proposalData: Hex;
  details: string;
  calls: Array<{ to: Address; data: Hex }>;
}

/**
 * Deploy the template instance for `member` (operator) with the sponsor's gas and build the exact
 * Baal proposal (multicall + details) that funds and starts it.
 *
 * @param env The connected environment.
 * @param sponsor The sponsor write context (pays the deployment).
 * @param member The proposer; becomes the instance's operator.
 * @param spec Template and parameters.
 * @param summary One-line summary prefixed to the details JSON.
 * @returns Instance, proposalData, details and the calls.
 */
export async function prepareProposal(env: Env, sponsor: WriteContext, member: Address, spec: TemplateSpec, summary: string): Promise<Prepared> {
  const dao = { safe: env.deployment.safe, settlement: env.deployment.settlement, baal: env.deployment.baal };
  const instance = await deployTemplate(sponsor, dao, spec, member);
  const calls = fundAndStartCalls(dao, instance);
  const details = proposalDetails(instance, summary);
  return { instance, proposalData: encodeProposalData(calls), details, calls: calls.map((call) => ({ to: call.to, data: call.data })) };
}

/** The EIP-191 message a T1 member signs to authorize a sponsored template deployment. */
export function prepareMessage(member: Address, template: string, params: string, nonce: string): string {
  return `Zero One prepare\nmember: ${getAddress(member)}\ntemplate: ${template}\nparamsHash: ${keccak256(stringToHex(params))}\nnonce: ${nonce}`;
}
