import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encodeMessage } from "../src/protocol/messages.js"
import {
  cursorEditReadAnswer,
  cursorEditReadReachesHost,
  hostToolForCursorEdit,
  toolsToDescriptors,
} from "../src/protocol/tools.js"
import {
  UNBOUND_EXEC_ID,
  cursorEditAnnouncement,
  earlyRowToolCallId,
  parseEarlyRowToolCallId,
  shouldOpenEarlyRow,
} from "../src/early-tool-rows.js"
import { extractTrailingToolResults, findContinuationSession, pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

const tempDirs: string[] = []

afterEach(() => {
  sessionManager.dispose()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-early-row-"))
  tempDirs.push(dir)
  return dir
}

function existingFile(): string {
  const file = path.join(tempDir(), "existing.txt")
  fs.writeFileSync(file, "one\n")
  return file
}

function partial(callId: string, filePath: string): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: {
      partial_tool_call: {
        call_id: callId,
        tool_call: { edit_tool_call: { args: { path: filePath } } },
      },
    },
  })
}

/** Cursor's edit as it arrives: announced, started, then its private read under the edit's call id. */
function editHandshake(callId: string, target: string, readExecId: number, writeText?: string): Uint8Array[] {
  const frames = [
    partial(callId, target),
    encodeMessage("AgentServerMessage", {
      interaction_update: {
        tool_call_started: { call_id: callId, tool_call: { edit_tool_call: { args: { path: target } } } },
      },
    }),
    encodeMessage("AgentServerMessage", {
      exec_server_message: { id: readExecId, read_args: { path: target, tool_call_id: callId } },
    }),
  ]
  if (writeText !== undefined) {
    frames.push(encodeMessage("AgentServerMessage", {
      exec_server_message: {
        id: readExecId + 1,
        write_args: { path: target, file_text: writeText, tool_call_id: callId },
      },
    }))
  }
  return frames
}

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0

/**
 * Bun's realpath needs read access to the file and Node's does not, so on Bun
 * an unreadable file's containment is unproven and it is treated as external.
 * Either way OpenCode's `read` answers it.
 */
function lockedFileAnswer(locked: string): "host" | "external" {
  try {
    fs.realpathSync(locked)
    return "host"
  } catch {
    return "external"
  }
}

function turnEnded(): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
  })
}

function pumpSession(
  payloads: Uint8Array[],
  tools: Array<{ name: string; description: string }>,
): { session: CursorSession; parts: any[] } {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
      : { done: true, value: undefined },
  }
  const descriptors = toolsToDescriptors(tools, "opencode", [])
  const session = sessionFixture({
    sessionId: `early-${Math.random().toString(16).slice(2)}`,
    conversationId: `conv-early-${Math.random().toString(16).slice(2)}`,
    stream: {
      write() {},
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as never,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: tools,
    toolDescriptors: descriptors,
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    heartbeatCancel: null,
    closed: false,
  })
  const parts: any[] = []
  return {
    session,
    parts,
  }
}

async function run(session: CursorSession, parts: any[]): Promise<void> {
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
}

describe("hostToolForCursorEdit", () => {
  it("predicts edit for an existing file, write for a new or empty one, and withholds a patch that would change CRLF", () => {
    const dir = tempDir()
    const crlf = path.join(dir, "crlf.txt")
    const lf = path.join(dir, "lf.txt")
    fs.writeFileSync(crlf, "a\r\nb\r\n")
    fs.writeFileSync(lf, "a\nb\n")
    const empty = path.join(dir, "empty.txt")
    fs.writeFileSync(empty, "")
    // An empty file has no text for an edit to replace: like a creation, it stays a write.
    expect(hostToolForCursorEdit(empty, new Set(["edit", "write"]))).toBe("write")
    expect(hostToolForCursorEdit(empty, new Set(["edit"]))).toBeUndefined()
    expect(hostToolForCursorEdit(empty, new Set(["write", "patch"]))).toBe("write")
    expect(hostToolForCursorEdit(empty, new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(empty, new Set(["apply_patch"]))).toBe("apply_patch")
    // A missing file is a creation: it stays a write, else becomes the patch tool's Add File.
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["edit", "write"]))).toBe("write")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["edit"]))).toBeUndefined()
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["write", "patch"]))).toBe("write")
    expect(hostToolForCursorEdit(lf, new Set(["edit", "write"]))).toBe("edit")
    expect(hostToolForCursorEdit(crlf, new Set(["edit", "patch"]))).toBe("edit")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["apply_patch"]))).toBe("apply_patch")
    expect(hostToolForCursorEdit(crlf, new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit(crlf, new Set(["apply_patch"]))).toBe("apply_patch")
    expect(hostToolForCursorEdit(lf, new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(dir, new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit("relative.txt", new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit(lf, new Set(["write"]))).toBeUndefined()
  })
})

describe("cursorEditReadAnswer", () => {
  it("answers workspace files and missing targets itself, and leaves outside or ineligible files to the host", () => {
    const workspace = tempDir()
    const inside = path.join(workspace, "inside.txt")
    const empty = path.join(workspace, "empty.txt")
    const subdir = path.join(workspace, "dir")
    const huge = path.join(workspace, "huge.bin")
    fs.writeFileSync(inside, "one\n")
    fs.writeFileSync(empty, "")
    fs.mkdirSync(subdir)
    // Sparse: one byte over Cursor's 50 MB edit limit without writing it.
    fs.writeFileSync(huge, "")
    fs.truncateSync(huge, 50 * 1024 * 1024 + 1)
    const outsideDir = tempDir()
    const outside = path.join(outsideDir, "outside.txt")
    fs.writeFileSync(outside, "one\n")
    const linkOut = path.join(workspace, "link-out.txt")
    const linkIn = path.join(outsideDir, "link-in.txt")
    const dangling = path.join(workspace, "dangling.txt")
    fs.symlinkSync(outside, linkOut)
    fs.symlinkSync(inside, linkIn)
    fs.symlinkSync(path.join(outsideDir, "gone.txt"), dangling)
    const rootLink = path.join(tempDir(), "workspace-link")
    fs.symlinkSync(workspace, rootLink)

    const cases: Array<[string, string, string, ReturnType<typeof cursorEditReadAnswer>, boolean]> = [
      ["regular workspace file", inside, workspace, "complete", false],
      ["empty workspace file", empty, workspace, "complete", false],
      ["workspace file through a symlinked root", path.join(rootLink, "inside.txt"), rootLink, "complete", false],
      ["outside symlink into the workspace", linkIn, workspace, "complete", false],
      ["missing workspace file", path.join(workspace, "new.txt"), workspace, "empty", false],
      ["missing outside file", path.join(outsideDir, "new.txt"), workspace, "empty", false],
      ["existing outside file", outside, workspace, "external", true],
      ["the workspace's parent", path.dirname(workspace), workspace, "external", false],
      ["workspace symlink to an outside file", linkOut, workspace, "external", true],
      // The handshake leaves it to the host; missing-target validation answers it first.
      ["dangling workspace symlink", dangling, workspace, "external", false],
      ["workspace directory", subdir, workspace, "host", false],
      ["file over the edit limit", huge, workspace, "host", true],
      ["path through a file", path.join(inside, "child"), workspace, "host", false],
    ]
    for (const [label, target, root, answer, reachesHost] of cases) {
      expect({ label, answer: cursorEditReadAnswer(target, root) }).toEqual({ label, answer })
      expect({ label, reachesHost: cursorEditReadReachesHost(target, root) }).toEqual({ label, reachesHost })
    }
  })

  it.skipIf(!canChmod)("leaves a workspace file the provider cannot read to the host", () => {
    const workspace = tempDir()
    const locked = path.join(workspace, "locked.txt")
    fs.writeFileSync(locked, "secret\n")
    fs.chmodSync(locked, 0o000)
    expect(cursorEditReadAnswer(locked, workspace)).toBe(lockedFileAnswer(locked))
    expect(cursorEditReadReachesHost(locked, workspace)).toBe(true)
  })
})

describe("early edit rows", () => {
  it("opens only while the step can wait for the exec", () => {
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(true)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: true,
      emittedHostTools: 2,
      owedPending: 1,
    })).toBe(true)
    expect(shouldOpenEarlyRow({
      allowTools: false,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(false)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: true,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(false)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 1,
      owedPending: 0,
    })).toBe(false)
    expect(cursorEditAnnouncement({
      call_id: "task-1",
      tool_call: { task_tool_call: { args: { description: "look" } } },
    })).toBeUndefined()
    // Cursor call ids can hold a newline (seen live with grok-4.7); the row id stays opaque and bounded.
    const liveCallId = "call-4e1f2d3b-b444-4c6f-8ee9-02b61bd2da60-0\nfc_05d8d1a5-117d-961c-95f3-ed00349cd3e3_0"
    const id = earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", liveCallId)
    expect(id).toMatch(/^cursor-early_2e64e80f-746e-413e-a3f2-27a0b7645ad8_[0-9a-f]{12}$/)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", liveCallId)).toBe(id)
    expect(earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", "other")).not.toBe(id)
    expect(parseEarlyRowToolCallId(earlyRowToolCallId("sess", "toolu_01_x")))
      .toEqual({ sessionId: "sess", execId: UNBOUND_EXEC_ID })
    expect(parseEarlyRowToolCallId("cursor_sess_4")).toBeUndefined()
    expect(parseEarlyRowToolCallId("cursor-early_sess")).toBeUndefined()
    expect(parseEarlyRowToolCallId("cursor-early_sess_")).toBeUndefined()
  })

  it("binds the announced row to the exec and routes its result", async () => {
    const dir = tempDir()
    const target = path.join(dir, "notes.txt")
    fs.writeFileSync(target, "line one\nline two\n")
    const callId = "edit-1"
    const { session, parts } = pumpSession([
      partial(callId, target),
      encodeMessage("AgentServerMessage", {
        interaction_update: {
          tool_call_started: {
            call_id: callId,
            tool_call: { edit_tool_call: { args: { path: target } } },
          },
        },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 17, read_args: { path: target, tool_call_id: callId } },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: {
          id: 18,
          write_args: {
            path: target,
            file_text: "edited one\nline two\n",
            tool_call_id: callId,
          },
        },
      }),
    ], [
      { name: "read", description: "Read" },
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const call = parts.find((part) => part.type === "tool-call" && !part.providerExecuted)
    expect(start?.toolName).toBe("edit")
    expect(call?.toolCallId).toBe(start?.id)
    expect(call?.toolCallId.startsWith("cursor-early_")).toBe(true)
    expect(parts.filter((part) => part.type === "tool-call" && !part.providerExecuted)).toHaveLength(1)
    expect(parts.findIndex((part) => part.type === "tool-input-start"))
      .toBeLessThan(parts.findIndex((part) => part.type === "tool-input-end"))
    const prompt = [
      { role: "assistant", content: [{ type: "text", text: "editing" }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: "edit",
          output: { type: "text", value: "ok" },
        }],
      },
    ] as never
    const continued = extractTrailingToolResults(prompt)
    expect(continued).toMatchObject([{ sessionId: session.sessionId, execId: 18 }])

    // A result that arrives after the Run closed still names its exec, so the
    // turn rebuilds from host history instead of dropping the completed edit.
    sessionManager.close(session, "hard-cap-expired")
    const late = extractTrailingToolResults(prompt)
    expect(late).toMatchObject([{ sessionId: session.sessionId, execId: 18 }])
    expect(findContinuationSession(late)).toBeUndefined()
    expect(sessionManager.classify(session.sessionId, 18)).toEqual({ kind: "terminal", reason: "hard-cap-expired" })

    // After a restart the route is gone; the id is still recognized as this provider's.
    sessionManager.dispose()
    expect(extractTrailingToolResults(prompt)).toMatchObject([{ sessionId: session.sessionId, execId: UNBOUND_EXEC_ID }])
  })

  it("binds a new file's announced row to its write instead of showing a failed edit", async () => {
    const dir = tempDir()
    const target = path.join(dir, "big.txt")
    const callId = "edit-new"
    const { session, parts } = pumpSession([
      partial(callId, target),
      encodeMessage("AgentServerMessage", {
        exec_server_message: {
          id: 5,
          write_args: { path: target, file_text: "line 1\n", tool_call_id: callId },
        },
      }),
    ], [
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const calls = parts.filter((part) => part.type === "tool-call")
    expect(start?.toolName).toBe("write")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolCallId: start?.id, toolName: "write" })
    expect(calls[0].providerExecuted).toBeUndefined()
    sessionManager.resolve(session.sessionId, 5)
  })

  // The 1.x and 2.0 file-tool catalogs an edit can be remapped onto.
  const mutationCatalogs = {
    "edit and write": ["read", "edit", "write"],
    "OpenCode 1.x apply_patch": ["read", "apply_patch"],
    "OpenCode 2 patch": ["read", "patch", "write"],
  } as const
  type MutationCatalog = keyof typeof mutationCatalogs
  const catalogTools = (catalog: MutationCatalog) => mutationCatalogs[catalog].map((name) => ({ name, description: name }))

  // #106: these reads go to OpenCode's permission-aware `read` and end the
  // step, so a row opened for the edit could only close as a failed edit.
  const hostReadTargets: Array<{
    label: string
    skip?: boolean
    setup(workspace: string): string
    /** Only a read whose containment is unproven is upgraded once the host authorizes it. */
    authorizes(file: string): boolean
  }> = [
    {
      label: "an existing file outside the workspace",
      setup() {
        const outside = path.join(tempDir(), "outside.txt")
        fs.writeFileSync(outside, "one\n")
        return outside
      },
      authorizes: () => true,
    },
    {
      label: "a workspace symlink to an outside file",
      setup(workspace) {
        const outside = path.join(tempDir(), "outside.txt")
        fs.writeFileSync(outside, "one\n")
        const link = path.join(workspace, "link.txt")
        fs.symlinkSync(outside, link)
        return link
      },
      authorizes: () => true,
    },
    {
      label: "a workspace file the provider cannot read",
      skip: !canChmod,
      setup(workspace) {
        const locked = path.join(workspace, "locked.txt")
        fs.writeFileSync(locked, "secret\n")
        fs.chmodSync(locked, 0o000)
        return locked
      },
      authorizes: (file) => lockedFileAnswer(file) === "external",
    },
  ]
  for (const target of hostReadTargets) {
    for (const catalog of Object.keys(mutationCatalogs) as MutationCatalog[]) {
      it.skipIf(!!target.skip)(`opens no row before the host read of ${target.label} (${catalog})`, async () => {
        const workspace = tempDir()
        const file = target.setup(workspace)
        const callId = "edit-host-read"
        const { session, parts } = pumpSession(editHandshake(callId, file, 3), catalogTools(catalog))
        session.requestContext.env = { workspace_paths: [workspace] }
        await run(session, parts)

        expect(parts.filter((part) => part.type === "tool-input-start")).toEqual([])
        expect(parts.filter((part) => part.type === "tool-call" && part.providerExecuted)).toEqual([])
        expect(parts.filter((part) => part.type === "tool-result" && part.isError)).toEqual([])
        const calls = parts.filter((part) => part.type === "tool-call")
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ toolName: "read" })
        expect(calls[0].toolCallId.startsWith("cursor_")).toBe(true)
        // The exec handler made the same decision from the same predicate.
        expect(session.pending.get(3)?.resultMetadata?.correlatedEditCallId)
          .toBe(target.authorizes(file) ? callId : undefined)
        sessionManager.resolve(session.sessionId, 3)
      })
    }
  }

  // The provider answers each of these reads, so the row binds to the edit's mutation.
  const providerReadTargets: Array<{
    label: string
    setup(workspace: string): { root: string; file: string }
    tool: Record<MutationCatalog, string>
  }> = [
    {
      label: "a regular workspace file",
      setup(workspace) {
        const file = path.join(workspace, "notes.txt")
        fs.writeFileSync(file, "one\n")
        return { root: workspace, file }
      },
      tool: { "edit and write": "edit", "OpenCode 1.x apply_patch": "apply_patch", "OpenCode 2 patch": "patch" },
    },
    {
      label: "a workspace file through a symlinked workspace root",
      setup(workspace) {
        fs.writeFileSync(path.join(workspace, "notes.txt"), "one\n")
        const root = path.join(tempDir(), "workspace-link")
        fs.symlinkSync(workspace, root)
        return { root, file: path.join(root, "notes.txt") }
      },
      tool: { "edit and write": "edit", "OpenCode 1.x apply_patch": "apply_patch", "OpenCode 2 patch": "patch" },
    },
    {
      // An empty file has no text to replace, so its whole-file write stays a write.
      label: "an empty workspace file",
      setup(workspace) {
        const file = path.join(workspace, "empty.txt")
        fs.writeFileSync(file, "")
        return { root: workspace, file }
      },
      tool: { "edit and write": "write", "OpenCode 1.x apply_patch": "apply_patch", "OpenCode 2 patch": "write" },
    },
    {
      label: "a new file outside the workspace",
      setup(workspace) {
        return { root: workspace, file: path.join(tempDir(), "new.txt") }
      },
      tool: { "edit and write": "write", "OpenCode 1.x apply_patch": "apply_patch", "OpenCode 2 patch": "write" },
    },
    {
      // Missing-target validation answers its read; Cursor then creates the file.
      label: "a dangling workspace symlink",
      setup(workspace) {
        const file = path.join(workspace, "dangling.txt")
        fs.symlinkSync(path.join(tempDir(), "gone.txt"), file)
        return { root: workspace, file }
      },
      tool: { "edit and write": "write", "OpenCode 1.x apply_patch": "apply_patch", "OpenCode 2 patch": "write" },
    },
  ]
  for (const target of providerReadTargets) {
    for (const catalog of Object.keys(mutationCatalogs) as MutationCatalog[]) {
      it(`keeps the row for ${target.label} and binds it to the edit (${catalog})`, async () => {
        const { root, file } = target.setup(tempDir())
        const callId = "edit-provider-read"
        const { session, parts } = pumpSession(editHandshake(callId, file, 17, "edited\n"), catalogTools(catalog))
        session.requestContext.env = { workspace_paths: [root] }
        await run(session, parts)

        const start = parts.find((part) => part.type === "tool-input-start")
        const calls = parts.filter((part) => part.type === "tool-call")
        expect(start?.toolName).toBe(target.tool[catalog])
        expect(start?.id.startsWith("cursor-early_")).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ toolCallId: start?.id, toolName: target.tool[catalog] })
        expect(calls[0].providerExecuted).toBeUndefined()
        expect(parts.filter((part) => part.type === "tool-result" && part.isError)).toEqual([])
        sessionManager.resolve(session.sessionId, 18)
      })
    }
  }

  it("closes the row when the exec is a different tool", async () => {
    const file = existingFile()
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 4, shell_args: { command: "pwd", tool_call_id: "shell-1" } },
      }),
    ], [
      { name: "edit", description: "Edit" },
      { name: "bash", description: "Shell" },
    ])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)
    const start = parts.find((part) => part.type === "tool-input-start")
    const closed = parts.find((part) => part.type === "tool-call" && part.providerExecuted)
    const shell = parts.find((part) => part.type === "tool-call" && part.toolName === "bash")
    expect(start?.toolName).toBe("edit")
    expect(closed?.toolCallId).toBe(start?.id)
    expect(shell?.toolCallId.startsWith("cursor_")).toBe(true)
    expect(parts.findIndex((part) => part === closed)).toBeLessThan(parts.findIndex((part) => part === shell))
    expect(parts.at(-1)?.type).toBe("finish")
    sessionManager.resolve(session.sessionId, 4)
  })

  it("stays open across later text and closes before the step finishes", async () => {
    const file = existingFile()
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "still writing" } } }),
      turnEnded(),
    ], [{ name: "edit", description: "Edit" }])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)
    const startAt = parts.findIndex((part) => part.type === "tool-input-start")
    const textAt = parts.findIndex((part) => part.type === "text-delta")
    const textEndAt = parts.findIndex((part) => part.type === "text-end")
    const closedAt = parts.findIndex((part) => part.type === "tool-call" && part.providerExecuted)
    const finishAt = parts.findIndex((part) => part.type === "finish")
    expect(startAt).toBeGreaterThanOrEqual(0)
    expect(textAt).toBeGreaterThan(startAt)
    // Open text ends before the closing tool-call, as at every other tool-call.
    expect(textEndAt).toBeGreaterThan(textAt)
    expect(closedAt).toBeGreaterThan(textEndAt)
    expect(finishAt).toBeGreaterThan(closedAt)
  })

  it("does not open a row a patch conversion would refuse, or on a tool-less turn", async () => {
    const dir = tempDir()
    const crlf = path.join(dir, "crlf.txt")
    fs.writeFileSync(crlf, "a\r\nb\r\n")
    const refused = pumpSession([
      partial("edit-1", crlf),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "no row" } } }),
      turnEnded(),
    ], [{ name: "patch", description: "Patch" }])
    refused.session.requestContext.env = { workspace_paths: [dir] }
    await run(refused.session, refused.parts)
    expect(refused.parts.some((part) => part.type === "tool-input-start")).toBe(false)

    const lifecycle = pumpSession([
      partial("edit-1", crlf),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "title" } } }),
      turnEnded(),
    ], [{ name: "edit", description: "Edit" }])
    lifecycle.session.requestContext.env = { workspace_paths: [dir] }
    lifecycle.session.allowTools = false
    await run(lifecycle.session, lifecycle.parts)
    expect(lifecycle.parts.some((part) => part.type === "tool-input-start")).toBe(false)
  })
})
