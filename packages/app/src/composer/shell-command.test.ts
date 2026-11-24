import { describe, expect, it } from "vitest";
import { parseComposerShellInput, validateComposerShellSubmit } from "./shell-command";

describe("composer shell-command helpers", () => {
  it("detects ! shell commands and unescapes leading \\! for normal chat", () => {
    expect(parseComposerShellInput("!git status")).toEqual({
      mode: "shell",
      command: "git status",
    });
    expect(parseComposerShellInput("!\ncd packages\nnpm test")).toEqual({
      mode: "shell",
      command: "\ncd packages\nnpm test",
    });
    expect(parseComposerShellInput("\\!important note")).toEqual({
      mode: "chat",
      text: "!important note",
    });
    expect(parseComposerShellInput("hello! world")).toEqual({
      mode: "chat",
      text: "hello! world",
    });
  });

  it("validates shell submission prerequisites and conflict rules", () => {
    expect(
      validateComposerShellSubmit({
        command: "ls",
        hasAttachments: false,
        isShellSupported: true,
        isConnected: true,
        hasAgent: true,
      }),
    ).toEqual({ allowed: true, reason: null });

    expect(
      validateComposerShellSubmit({
        command: "ls",
        hasAttachments: false,
        isShellSupported: false,
        isConnected: true,
        hasAgent: true,
      }),
    ).toEqual({ allowed: false, reason: "unsupported" });

    expect(
      validateComposerShellSubmit({
        command: "ls",
        hasAttachments: true,
        isShellSupported: true,
        isConnected: true,
        hasAgent: true,
      }),
    ).toEqual({ allowed: false, reason: "attachments_conflict" });

    expect(
      validateComposerShellSubmit({
        command: "   ",
        hasAttachments: false,
        isShellSupported: true,
        isConnected: true,
        hasAgent: true,
      }),
    ).toEqual({ allowed: false, reason: "empty" });
  });
});
