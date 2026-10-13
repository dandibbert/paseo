import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { listPiProviderSkills, setPiProviderSkillEnabled } from "./provider-skills.js";

interface PiSkillFixture {
  root: string;
  home: string;
  agentDir: string;
  cwd: string;
}

function createFixture(): PiSkillFixture {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-skills-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const cwd = path.join(root, "repo", "packages", "app");
  mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, agentDir, cwd };
}

function writeSkill(dir: string, name: string, description = `${name} description`): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`);
  return filePath;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function list(fixture: PiSkillFixture) {
  return listPiProviderSkills({
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    homeDir: fixture.home,
    loadedCommands: [],
  });
}

describe("Pi provider skills", () => {
  test("lists skills from every Pi skill location with their settings state", async () => {
    const fixture = createFixture();
    const userSkill = writeSkill(path.join(fixture.agentDir, "skills", "pdf-tools"), "pdf-tools");
    const userAgentsSkill = writeSkill(
      path.join(fixture.home, ".agents", "skills", "review"),
      "review",
    );
    const projectSkill = writeSkill(path.join(fixture.cwd, ".pi", "skills", "deploy"), "deploy");
    const ancestorSkill = writeSkill(
      path.join(fixture.root, "repo", ".agents", "skills", "lint"),
      "lint",
    );
    writeSkill(path.join(fixture.root, ".agents", "skills", "outside-repo"), "outside-repo");
    writeJson(path.join(fixture.agentDir, "settings.json"), {
      theme: "dark",
      skills: ["-skills/pdf-tools/SKILL.md"],
    });
    writeJson(path.join(fixture.cwd, ".pi", "settings.json"), { skills: ["!lint"] });

    const skills = await list(fixture);

    expect(skills).toEqual([
      {
        name: "skill:deploy",
        description: "deploy description",
        enabled: true,
        path: projectSkill,
        scope: "project",
        source: ".pi/skills",
        pluginId: null,
        toggleSupported: true,
        visibilityCycleSupported: false,
      },
      {
        name: "skill:lint",
        description: "lint description",
        enabled: false,
        path: ancestorSkill,
        scope: "project",
        source: ".agents/skills",
        pluginId: null,
        toggleSupported: true,
        visibilityCycleSupported: false,
      },
      {
        name: "skill:pdf-tools",
        description: "pdf-tools description",
        enabled: false,
        path: userSkill,
        scope: "user",
        source: "~/.pi/agent/skills",
        pluginId: null,
        toggleSupported: true,
        visibilityCycleSupported: false,
      },
      {
        name: "skill:review",
        description: "review description",
        enabled: true,
        path: userAgentsSkill,
        scope: "user",
        source: "~/.agents/skills",
        pluginId: null,
        toggleSupported: true,
        visibilityCycleSupported: false,
      },
    ]);
  });

  test("skips skill files that Pi would not load", async () => {
    const fixture = createFixture();
    const skillsDir = path.join(fixture.agentDir, "skills");
    mkdirSync(path.join(skillsDir, "no-description"), { recursive: true });
    writeFileSync(path.join(skillsDir, "no-description", "SKILL.md"), "---\nname: x\n---\n");
    writeSkill(path.join(skillsDir, ".hidden"), "hidden");
    writeSkill(path.join(skillsDir, "node_modules", "dep"), "dep");

    await expect(list(fixture)).resolves.toEqual([]);
  });

  test("lists skills loaded from other sources without a toggle", async () => {
    const fixture = createFixture();
    const userSkill = writeSkill(path.join(fixture.agentDir, "skills", "pdf-tools"), "pdf-tools");

    const skills = await listPiProviderSkills({
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      homeDir: fixture.home,
      loadedCommands: [
        { name: "skill:pdf-tools", source: "skill", sourceInfo: { path: userSkill } },
        {
          name: "skill:browser",
          description: "Drive a browser",
          source: "skill",
          sourceInfo: { path: "/pkgs/browser/SKILL.md", source: "npm:pi-skills", scope: "user" },
        },
        { name: "review", source: "prompt" },
      ],
    });

    expect(skills.map((skill) => [skill.name, skill.toggleSupported, skill.source])).toEqual([
      ["skill:browser", false, "npm:pi-skills"],
      ["skill:pdf-tools", true, "~/.pi/agent/skills"],
    ]);
  });

  test("writes the same override entry as pi config and replaces earlier ones", async () => {
    const fixture = createFixture();
    const userSkill = writeSkill(path.join(fixture.agentDir, "skills", "pdf-tools"), "pdf-tools");
    const settingsPath = path.join(fixture.agentDir, "settings.json");
    writeJson(settingsPath, {
      theme: "dark",
      skills: ["extra/skills", "+skills/pdf-tools/SKILL.md"],
    });

    await setPiProviderSkillEnabled({
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      homeDir: fixture.home,
      path: userSkill,
      enabled: false,
    });

    expect(readJson(settingsPath)).toEqual({
      theme: "dark",
      skills: ["extra/skills", "-skills/pdf-tools/SKILL.md"],
    });
    await expect(list(fixture)).resolves.toMatchObject([
      { name: "skill:pdf-tools", enabled: false },
    ]);

    await setPiProviderSkillEnabled({
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      homeDir: fixture.home,
      path: userSkill,
      enabled: true,
    });

    expect(readJson(settingsPath)).toEqual({
      theme: "dark",
      skills: ["extra/skills", "+skills/pdf-tools/SKILL.md"],
    });
  });

  test("writes project skill overrides to the project settings relative to their base dir", async () => {
    const fixture = createFixture();
    const ancestorSkill = writeSkill(
      path.join(fixture.root, "repo", ".agents", "skills", "lint"),
      "lint",
    );

    await setPiProviderSkillEnabled({
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      homeDir: fixture.home,
      path: ancestorSkill,
      enabled: false,
    });

    expect(readJson(path.join(fixture.cwd, ".pi", "settings.json"))).toEqual({
      skills: ["-skills/lint/SKILL.md"],
    });
    await expect(list(fixture)).resolves.toMatchObject([{ name: "skill:lint", enabled: false }]);
  });

  test("refuses to toggle a skill outside the Pi skill directories", async () => {
    const fixture = createFixture();
    const strayPath = writeSkill(path.join(fixture.root, "elsewhere", "stray"), "stray");

    await expect(
      setPiProviderSkillEnabled({
        cwd: fixture.cwd,
        agentDir: fixture.agentDir,
        homeDir: fixture.home,
        path: strayPath,
        enabled: false,
      }),
    ).rejects.toThrow("Pi skill is not in a Pi skills directory");
  });
});
