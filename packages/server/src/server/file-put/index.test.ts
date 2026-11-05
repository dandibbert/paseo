import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  encodeFileTransferFrame,
  decodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { FilePutRequest, FilePutResponse } from "../messages.js";
import { FilePutStore } from "./index.js";

const tempDirs: string[] = [];
const source = {};

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-file-put-"));
  tempDirs.push(dir);
  return dir;
}

function frame(input: Parameters<typeof encodeFileTransferFrame>[0]): FileTransferFrame {
  const decoded = decodeFileTransferFrame(encodeFileTransferFrame(input));
  if (!decoded) throw new Error("Invalid test frame");
  return decoded;
}

function begin(
  store: FilePutStore,
  request: Omit<FilePutRequest, "type" | "requestId">,
): { requestId: string; response: Promise<FilePutResponse | null> } {
  const requestId = `put-${crypto.randomUUID()}`;
  const response = new Promise<FilePutResponse | null>((resolve) => {
    store.begin({ type: "fs.file.put.request", requestId, ...request }, source, resolve);
  });
  return { requestId, response };
}

async function stream(store: FilePutStore, requestId: string, chunks: string[]): Promise<void> {
  const size = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
  await store.receiveFrame(
    frame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "application/octet-stream",
        size,
        encoding: "binary",
        modifiedAt: new Date(0).toISOString(),
      },
    }),
    source,
  );
  for (const chunk of chunks) {
    await store.receiveFrame(
      frame({ opcode: FileTransferOpcode.FileChunk, requestId, payload: chunk }),
      source,
    );
  }
  await store.receiveFrame(frame({ opcode: FileTransferOpcode.FileEnd, requestId }), source);
}

describe("file puts", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a new file, creating parents, and leaves no temporary file", async () => {
    const root = makeRoot();
    const store = new FilePutStore();
    const { requestId, response } = begin(store, {
      cwd: root,
      path: "a/b/notes.txt",
      size: 11,
      createParents: true,
    });
    await stream(store, requestId, ["hello", " world"]);

    expect(await response).toMatchObject({
      type: "fs.file.put.response",
      payload: {
        requestId,
        path: "a/b/notes.txt",
        file: { path: "a/b/notes.txt", size: 11, absolutePath: join(root, "a", "b", "notes.txt") },
        error: null,
        errorCode: null,
      },
    });
    expect(readFileSync(join(root, "a", "b", "notes.txt"), "utf8")).toBe("hello world");
    expect(readdirSync(join(root, "a", "b"))).toEqual(["notes.txt"]);
  });

  it("keeps an existing file unless overwrite is set", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "notes.txt"), "original");
    const store = new FilePutStore();

    const refused = begin(store, { cwd: root, path: "notes.txt", size: 3 });
    await stream(store, refused.requestId, ["new"]);
    expect((await refused.response)?.payload).toMatchObject({ file: null, errorCode: "exists" });
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("original");

    const replaced = begin(store, { cwd: root, path: "notes.txt", size: 3, overwrite: true });
    await stream(store, replaced.requestId, ["new"]);
    expect((await replaced.response)?.payload).toMatchObject({ error: null, file: { size: 3 } });
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("new");
    expect(readdirSync(root)).toEqual(["notes.txt"]);
  });

  it("does not create the target when fewer bytes than declared arrive", async () => {
    const root = makeRoot();
    const store = new FilePutStore();
    const { requestId, response } = begin(store, { cwd: root, path: "short.bin", size: 10 });
    await stream(store, requestId, ["abc"]);

    expect((await response)?.payload).toMatchObject({
      file: null,
      errorCode: "error",
      error: expect.stringContaining("size mismatch"),
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects targets outside the root, including through a symlinked parent", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    symlinkSync(outside, join(root, "escape"));
    const store = new FilePutStore();

    const parentTraversal = begin(store, { cwd: root, path: "../outside.txt", size: 1 });
    expect((await parentTraversal.response)?.payload.error).toBe(
      "Access outside of workspace is not allowed",
    );
    const throughLink = begin(store, { cwd: root, path: "escape/inside.txt", size: 1 });
    expect((await throughLink.response)?.payload.error).toBe(
      "Access outside of workspace is not allowed",
    );
    const createThroughLink = begin(store, {
      cwd: root,
      path: "escape/made/inside.txt",
      size: 1,
      createParents: true,
    });
    expect((await createThroughLink.response)?.payload.error).toBe(
      "Access outside of workspace is not allowed",
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("removes the temporary file when the stream is cancelled", async () => {
    const root = makeRoot();
    const store = new FilePutStore();
    const settled: (FilePutResponse | null)[] = [];
    const cancel = store.begin(
      { type: "fs.file.put.request", requestId: "cancelled", cwd: root, path: "big.bin", size: 8 },
      source,
      (response) => settled.push(response),
    );
    await store.receiveFrame(
      frame({ opcode: FileTransferOpcode.FileChunk, requestId: "cancelled", payload: "abcd" }),
      source,
    );
    expect(readdirSync(root)).toHaveLength(1);
    await cancel();

    expect(settled).toEqual([null]);
    expect(readdirSync(root)).toEqual([]);
  });
});
