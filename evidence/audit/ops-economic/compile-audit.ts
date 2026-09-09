/** Compile the audit helper contracts (evidence/audit/ops-economic/contracts) into ./artifacts. */
import { compileAuditContracts } from "./lib-audit.js";

console.log(`compiled: ${compileAuditContracts().join(", ")}`);
