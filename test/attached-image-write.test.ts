import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { imageContentHash } from "../src/image-input.js"
import { opencodeProjectDir, setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe])

function fakeSession(
  payloads: Uint8Array[],
  writes: Uint8Array[],
  workspaceRoot: string,
  attached: Uint8Array[],
): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () =>
      index < payloads.length
        ? { done: false, value: { flags: 0, payload: payloads[index++] } }
        : { done: true, value: undefined },
  }
  const definitions = [
    { name: "read", description: "Read" },
    { name: "cursor_image_save", description: "Save image" },
  ]
  const tools = toolsToDescriptors(definitions, "opencode", [])
  return {
    sessionId: "attached-image-session",
    conversationId: "attached-image-conversation",
    stream: {
      write(data: Uint8Array) {
        writes.push(data)
      },
      end() {},
      destroy() {},
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    attachedImageHashes: new Set(attached.map(imageContentHash)),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: definitions,
    knownMcpServers: [],
    toolDescriptors: tools,
    requestContext: { tools, env: { workspace_paths: [workspaceRoot] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

function binaryWrite(id: number, target: string, data: Uint8Array): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    exec_server_message: { id, write_args: { path: target, file_bytes: data } },
  })
}

const turnEnded = encodeMessage("AgentServerMessage", {
  interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } },
})

describe("attached image writes", () => {
  let cacheRoot = ""

  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
    setHostCacheDirOverride(undefined)
    if (cacheRoot) fs.rmSync(cacheRoot, { recursive: true, force: true })
  })

  async function run(attached: Uint8Array[], written: Uint8Array) {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-attached-image-"))
    setHostCacheDirOverride(cacheRoot)
    const workspaceRoot = path.join(cacheRoot, "workspace")
    fs.mkdirSync(workspaceRoot)
    const target = path.join(opencodeProjectDir(workspaceRoot), "assets", "image-1.png")
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession([binaryWrite(4, target, written), turnEnded], writes, workspaceRoot, attached)
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as ReadableStreamDefaultController<any>
    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    return { target, writes, parts }
  }

  it("stores Cursor's copy of an attached image without a host tool call", async () => {
    const { target, writes, parts } = await run([PNG], PNG)

    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(0)
    expect(parts.find((part) => part.type === "finish")?.finishReason.unified).toBe("stop")
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG)
    const reply = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
    expect(reply.id).toBe(4)
    expect(reply.write_result.success).toMatchObject({ path: target, file_size: PNG.length })
  })

  it("still routes other binary writes through cursor_image_save", async () => {
    const generated = Uint8Array.from([...PNG, 0x42])
    const { target, parts } = await run([PNG], generated)

    const toolCalls = parts.filter((part) => part.type === "tool-call")
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].toolName).toBe("cursor_image_save")
    expect(fs.existsSync(target)).toBe(false)
  })
})
