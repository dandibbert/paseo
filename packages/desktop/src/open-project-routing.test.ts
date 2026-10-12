import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseOpenProjectPathFromArgv,
  parseOpenDirectoryModeFromArgv,
} from "./open-project-routing";

describe("open-project-routing", () => {
  it("parses the terminal intent while preserving the selected directory", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-terminal-"));
    const argv = ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--open-terminal", projectPath];
    expect(parseOpenProjectPathFromArgv({ argv, isDefaultApp: false })).toBe(projectPath);
    expect(parseOpenDirectoryModeFromArgv(argv)).toBe("terminal");
    expect(parseOpenDirectoryModeFromArgv([argv[0], "--open-project", projectPath])).toBe(
      "workspace",
    );
  });
  it("returns a bare absolute path argument", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", projectPath],
        isDefaultApp: false,
      }),
    ).toBe(projectPath);
  });

  it("finds a bare absolute path even when Chromium noise args appear first", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));

    expect(
      parseOpenProjectPathFromArgv({
        argv: [
          "/Applications/Paseo.app/Contents/MacOS/Paseo",
          "--allow-file-access-from-files",
          "--no-sandbox",
          projectPath,
        ],
        isDefaultApp: false,
      }),
    ).toBe(projectPath);
  });

  it("does not treat flags as project paths", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));
    const flagLikeDirectory = path.join(projectPath, "--version");
    mkdirSync(flagLikeDirectory);

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--version", flagLikeDirectory],
        isDefaultApp: false,
      }),
    ).toBe(flagLikeDirectory);

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--version"],
        isDefaultApp: false,
      }),
    ).toBeNull();
  });

  it("returns the path from an explicit --open-project flag for backward compatibility", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--open-project", projectPath],
        isDefaultApp: false,
      }),
    ).toBe(projectPath);
  });
});
