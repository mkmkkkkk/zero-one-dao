/** Thin base entry point; all deployment and genesis logic is shared. */
import { deployNetwork } from "./deploy-network.js";
deployNetwork(8453).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
