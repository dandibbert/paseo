import fs from "node:fs";

const target = "packages/server/src/server/agent/providers/codex-app-server-agent.ts";
let source = fs.readFileSync(target, "utf8");
let changed = false;

const importAnchor = 'import { CodexSubagentPreview } from "./codex/subagent-preview.js";';
const catalogImport = `import {
  buildCodexAppServerArgs,
  resolveCodexModelCatalogConfigOverride,
} from "./codex/model-catalog-override.js";`;

if (!source.includes('from "./codex/model-catalog-override.js"')) {
  if (!source.includes(importAnchor)) {
    throw new Error("Could not find Codex subagent import anchor");
  }
  source = source.replace(importAnchor, `${importAnchor}\n${catalogImport}`);
  changed = true;
}

const oldSpawnSetup = `    const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
    const args = [...launchPrefix.args, "app-server"];
    if (options?.goalsEnabled) {
      args.push("--enable", "goals");
    }`;

const newSpawnSetup = `    const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
    const modelCatalogConfigOverride = await resolveCodexModelCatalogConfigOverride({
      command: launchPrefix.command,
      launchArgs: launchPrefix.args,
      runtimeSettings: this.runtimeSettings,
      launchEnv,
      configuredModels: this.deps.configuredModels,
    });
    const args = buildCodexAppServerArgs(
      launchPrefix.args,
      modelCatalogConfigOverride,
      options?.goalsEnabled === true,
    );`;

if (source.includes(oldSpawnSetup)) {
  source = source.replace(oldSpawnSetup, newSpawnSetup);
  changed = true;
} else if (!source.includes("resolveCodexModelCatalogConfigOverride({")) {
  throw new Error("Could not find Codex app-server spawn setup anchor");
}

if (changed) {
  fs.writeFileSync(target, source);
  console.log(`Patched ${target}`);
} else {
  console.log(`${target} already contains the context-catalog fix`);
}
