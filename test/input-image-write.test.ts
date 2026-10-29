import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { getHostCacheDirOverride, opencodeProjectDir, setHostCacheDirOverride } from "../src/context/paths.js"
import { IMAGE_PERMISSION_DENIED_PREFIX } from "../src/image-save.js"
import { imageContentHash } from "../src/image-input.js"
import {
  clearPendingCursorImages,
  distinctInputImagePath,
  stageCursorImage,
} from "../src/image-staging.js"
import { deliverContinuationResults, pump, resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { CURSOR_IMAGE_SAVE_TOOL } from "../src/protocol/generate-image.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  heldHistoryImageHashes,
  noteHistoryImagesSent,
  resetHeldHistoryImagesForTests,
  runHasHistoryImage,
  runHistoryImages,
} from "../src/protocol/sent-history-images.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { sessionManager, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

const HOST_SESSION = "ses_input_image"
const PNG_A = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1)
const PNG_B = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2)

const tempDirs: string[] = []
let previousCache: string | undefined

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-input-image-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await settleRunSavesForTests()
  sessionManager.dispose()
  clearPendingCursorImages()
  resetToolRequestsListedSeenForTests()
  resetTurnStateForTests()
  resetHeldHistoryImagesForTests()
  setHostCacheDirOverride(previousCache)
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function frame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

const ended = () => frame({ interaction_update: { turn_ended: {} } })
const checkpoint = (bytes: Uint8Array) => frame({ conversation_checkpoint_update: bytes })
const completed = (call_id: string) => frame({ interaction_update: { tool_call_completed: { call_id } } })
// Cursor's copy of an image, and a generated image's write, both name no call.
const imageWrite = (id: number, data: Uint8Array, file = "/elsewhere/assets/cvs.png") => frame({
  exec_server_message: { id, write_args: { path: file, file_bytes: data } },
})
const generateImageStarted = (call_id: string) => frame({ interaction_update: { tool_call_started: {
  call_id, tool_call: { generate_image_tool_call: { args: { description: "a red fox in the snow" } } },
} } })

/** A Run whose conversation holds `inputImages`, with `cursor_image_save` advertised. */
function imageRun(frames: Frame[], inputImages: readonly Uint8Array[] = []) {
  previousCache = getHostCacheDirOverride()
  setHostCacheDirOverride(tempDir())
  const workspace = tempDir()
  const writes: Uint8Array[] = []
  const iterator: AsyncIterator<Frame> = {
    next: async () => {
      const value = frames.shift()
      return value ? { done: false, value } : { done: true, value: undefined }
    },
  }
  const tools = [{ name: CURSOR_IMAGE_SAVE_TOOL, description: "Save an image" }]
  const historyImages = runHistoryImages()
  noteHistoryImagesSent(historyImages, inputImages.map(imageContentHash), 0)
  const session = sessionFixture({
    sessionId: "input-image-run", conversationId: "input-image-conversation", openCodeSessionId: HOST_SESSION,
    stream: {
      write(data) { writes.push(data) }, end() {}, destroy() {}, isClosed: () => false,
      onTerminal: () => () => {},
      frames: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
    frames: iterator, pending: new Map(), displayToolCalls: new Map(),
    nextBridgedExecId: 900_000, blobs: new Map(), toolCatalog: tools,
    toolDescriptors: toolsToDescriptors(tools, "opencode"),
    requestContext: { env: { workspace_paths: [workspace] } },
    allowTools: true, pumpActive: false, heartbeat: null, historyImages,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
  })
  return { session, writes, frames, assets: path.join(opencodeProjectDir(workspace), "assets") }
}

function collect() {
  const parts: LanguageModelV3StreamPart[] = []
  const controller = {
    desiredSize: 1, close() {},
    enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
    error(error: unknown) { throw error },
  } as ReadableStreamDefaultController<LanguageModelV3StreamPart>
  return { parts, controller }
}

const ids = { textId: "text", reasoningId: "reasoning" }

/** Pump to the save step, answer it with `outcome`, and return the save call. */
async function saveStep(run: ReturnType<typeof imageRun>, execId: number, outcome: "saved" | "denied" | "failed") {
  const first = collect()
  await pump(run.session, first.controller, ids)
  const save = first.parts.find((part) => part.type === "tool-call")
  expect(save).toMatchObject({ toolName: CURSOR_IMAGE_SAVE_TOOL })
  const error = outcome === "denied" ? `${IMAGE_PERMISSION_DENIED_PREFIX} rejected by the user`
    : outcome === "failed" ? "Could not save the generated image: disk full" : undefined
  const metadata = run.session.pending.get(execId)?.resultMetadata
  expect(await deliverContinuationResults(run.session, [{
    sessionId: run.session.sessionId, execId, toolCallId: save!.type === "tool-call" ? save!.toolCallId : "",
    toolName: CURSOR_IMAGE_SAVE_TOOL, output: error ?? "Saved the generated image", ...(error ? { error } : {}),
  }])).toBe(run.session)
  return metadata
}

describe("Cursor's input-image writes", () => {
  it.each(["saved", "denied", "failed"] as const)(
    "let later checkpoints resume the Run once %s, and the turn ends holding the image",
    async outcome => {
      const resume = Uint8Array.of(10, 2, 7, 7)
      const run = imageRun([imageWrite(1, PNG_A), checkpoint(resume), ended()], [PNG_A])
      const metadata = await saveStep(run, 1, outcome)
      expect(metadata).toMatchObject({ inputImage: true })
      expect(metadata?.generateImageCallId).toBeUndefined()
      expect(run.session.unacknowledgedHostResults ?? []).toEqual([])
      await pump(run.session, collect().controller, ids)

      expect(run.session.resumeCheckpoint).toEqual(resume)
      // So the next Run skips the image and Cursor does not write it again.
      expect(heldHistoryImageHashes(HOST_SESSION, run.session.conversationId, resume))
        .toEqual(new Set([imageContentHash(PNG_A)]))
    },
  )

  it("does not count a checkpoint from before the save", async () => {
    const early = Uint8Array.of(10, 2, 1, 1)
    const run = imageRun([checkpoint(early), imageWrite(1, PNG_A), ended()], [PNG_A])
    await saveStep(run, 1, "saved")
    await pump(run.session, collect().controller, ids)
    expect(run.session.resumeCheckpoint).toBeUndefined()
    expect(heldHistoryImageHashes(HOST_SESSION, run.session.conversationId, early)).toBeUndefined()
  })

  it("keeps waiting for any other uncorrelated write, which no completion can acknowledge", async () => {
    const later = Uint8Array.of(10, 2, 3, 3)
    const run = imageRun([imageWrite(1, PNG_B), checkpoint(later), ended()], [PNG_A])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.inputImage).toBeUndefined()
    expect(run.session.unacknowledgedHostResults).toEqual([{ callId: undefined, afterFrame: expect.any(Number) }])
    await pump(run.session, collect().controller, ids)
    expect(run.session.resumeCheckpoint).toBeUndefined()
  })

  it("does not take a model's own write of matching bytes for Cursor's copy", async () => {
    const run = imageRun([frame({ exec_server_message: { id: 1, write_args: {
      path: "/elsewhere/assets/cvs.png", file_bytes: PNG_A, tool_call_id: "model-write",
    } } }), ended()], [PNG_A])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.inputImage).toBeUndefined()
    expect(metadata?.path).toEndWith(`${path.sep}cvs.png`)
  })

  it("saves a same-named different image beside the first and reports that path to Cursor", async () => {
    const run = imageRun([imageWrite(1, PNG_B), ended()], [PNG_B])
    fs.mkdirSync(run.assets, { recursive: true })
    fs.writeFileSync(path.join(run.assets, "cvs.png"), PNG_A)
    const hashed = path.join(run.assets, `cvs-${imageContentHash(PNG_B).slice(0, 12)}.png`)
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.path).toBe(hashed)
    const result = run.writes
      .map((bytes) => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message?.write_result)
      .find(Boolean)
    expect(result.success).toMatchObject({ path: hashed, file_size: PNG_B.length })
    expect(fs.readFileSync(path.join(run.assets, "cvs.png"))).toEqual(Buffer.from(PNG_A))
  })
})

describe("a generated image's write", () => {
  it.each([
    ["is acknowledged by its GenerateImage completion", true],
    ["refuses a checkpoint until its GenerateImage completes", false],
  ] as const)("%s", async (_name, completesFirst) => {
    const resume = Uint8Array.of(10, 2, 9, 9)
    const after = completesFirst ? [completed("gen-1"), checkpoint(resume)] : [checkpoint(resume), completed("gen-1")]
    const run = imageRun([generateImageStarted("gen-1"), imageWrite(1, PNG_B), ...after, ended()])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata).toMatchObject({ generateImageCallId: "gen-1" })
    expect(metadata?.inputImage).toBeUndefined()
    expect(run.session.unacknowledgedHostResults).toEqual([{ callId: "gen-1", afterFrame: expect.any(Number) }])
    await pump(run.session, collect().controller, ids)
    expect(run.session.unacknowledgedHostResults).toEqual([])
    expect(run.session.resumeCheckpoint).toEqual(completesFirst ? resume : undefined)
  })

  it("stays uncorrelated while two GenerateImage calls are open", async () => {
    const run = imageRun([generateImageStarted("gen-1"), generateImageStarted("gen-2"), imageWrite(1, PNG_B), ended()])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.generateImageCallId).toBeUndefined()
    expect(run.session.unacknowledgedHostResults).toEqual([{ callId: undefined, afterFrame: expect.any(Number) }])
  })

  it("is not taken for an input image that happens to match", async () => {
    const run = imageRun([generateImageStarted("gen-1"), imageWrite(1, PNG_A), ended()], [PNG_A])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata).toMatchObject({ generateImageCallId: "gen-1" })
    expect(metadata?.inputImage).toBeUndefined()
  })
})

describe("distinctInputImagePath", () => {
  const hash = imageContentHash(PNG_B)
  const hashedName = `cvs-${hash.slice(0, 12)}.png`

  it("keeps a free target or one already holding the same bytes", () => {
    const dir = tempDir()
    const target = path.join(dir, "cvs.png")
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(target)
    fs.writeFileSync(target, PNG_B)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(target)
  })

  it("moves aside from other bytes on disk, a link, or a directory", () => {
    const dir = tempDir()
    const target = path.join(dir, "cvs.png")
    fs.writeFileSync(target, PNG_A)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(dir, hashedName))
    fs.rmSync(target)
    fs.writeFileSync(path.join(dir, "real.png"), PNG_B)
    fs.symlinkSync(path.join(dir, "real.png"), target)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(dir, hashedName))
    fs.rmSync(target)
    fs.mkdirSync(target)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(dir, hashedName))
  })

  it.skipIf(process.getuid?.() === 0)("moves aside from a same-size file it cannot read", () => {
    const target = path.join(tempDir(), "cvs.png")
    fs.writeFileSync(target, PNG_A, { mode: 0o000 })
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(path.dirname(target), hashedName))
  })

  it("moves aside from a different image staged for the same name and not yet saved", () => {
    const target = path.join(tempDir(), "cvs.png")
    stageCursorImage({ path: target, mime: "image/png", data: PNG_A })
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(path.dirname(target), hashedName))
    expect(distinctInputImagePath(target, PNG_A, imageContentHash(PNG_A))).toBe(target)
  })

  it("keeps an extensionless name readable", () => {
    const target = path.join(tempDir(), "cvs")
    fs.writeFileSync(target, PNG_A)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(`${target}-${hash.slice(0, 12)}`)
  })
})

describe("runHasHistoryImage", () => {
  it("finds held, checkpointed and sent images", () => {
    const run = runHistoryImages(new Set(["held"]))
    run.checkpointed.push("checkpointed")
    noteHistoryImagesSent(run, ["sent"], 0)
    expect(["held", "checkpointed", "sent", "other"].map((hash) => runHasHistoryImage(run, hash)))
      .toEqual([true, true, true, false])
  })
})
