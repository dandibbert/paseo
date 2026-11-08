import { describe, expect, it } from "vitest";
import { describeMarkdownLink } from "./link-target";

const workspace = { workspaceRoot: "/Users/me/project" };

describe("describeMarkdownLink", () => {
  it("treats web addresses as URLs", () => {
    expect(describeMarkdownLink({ href: "https://paseo.sh/docs" }, workspace)).toEqual({
      kind: "url",
      url: "https://paseo.sh/docs",
    });
  });

  it("resolves a workspace-relative path against the workspace", () => {
    expect(describeMarkdownLink({ href: "src/app.ts" }, workspace)).toEqual({
      kind: "path",
      path: "/Users/me/project/src/app.ts",
      absolutePath: "/Users/me/project/src/app.ts",
      workspacePath: "src/app.ts",
    });
  });

  it("keeps an absolute path and knows when it is inside the workspace", () => {
    expect(describeMarkdownLink({ href: "/Users/me/project/dist" }, workspace)).toMatchObject({
      absolutePath: "/Users/me/project/dist",
      workspacePath: "dist",
    });
    expect(describeMarkdownLink({ href: "/tmp/build.zip" }, workspace)).toMatchObject({
      kind: "path",
      absolutePath: "/tmp/build.zip",
      workspacePath: null,
    });
  });

  it("drops a line suffix from the path", () => {
    expect(describeMarkdownLink({ href: "src/app.ts:42" }, workspace)).toMatchObject({
      absolutePath: "/Users/me/project/src/app.ts",
      workspacePath: "src/app.ts",
    });
  });
});
