import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityProvider } from "./server/provider.js";
import { createAntigravityUsageSource } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  const usage = createAntigravityUsageSource();
  server.registerProvider(createAntigravityProvider(usage.rememberLaunch));
  server.registerUsageSource(usage.registration());
  return () => {};
}
