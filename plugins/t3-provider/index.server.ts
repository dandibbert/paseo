import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createT3Provider } from "./server/provider.js";
import { createT3UsageSource } from "./server/usage.js";

export default function contribute(
  server: Pick<PluginServerContext, "registerProvider" | "registerUsageSource">,
) {
  server.registerUsageSource(createT3UsageSource());
  server.registerProvider(createT3Provider());
  return () => {};
}
