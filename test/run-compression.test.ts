import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { mapAvailableModelsResponse, writeCache } from "../src/models.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { decodeFramePayload, encodeFrame, FLAG_GZIP, streamFrames, type Frame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager } from "../src/session.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  isCompressionRejection,
  resetRunCompressionForTests,
  RUN_COMPRESS_MIN_BYTES,
} from "../src/transport/connect.js"

const ORIGIN = "https://agentn.compression-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const UNSUPPORTED = { code: "unimplemented", message: "unknown compression \"gzip\": supported encodings are identity" }
const realConnect = http2.connect
const savedProxy: Record<string, string | undefined> = {}
const savedClientVersion = process.env.CURSOR_CLIENT_VERSION

const endStream = (payload: unknown) =>
  encodeFrame(0x02, new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload)))
const serverFrame = (message: Record<string, unknown>) => encodeFrame(0x00, encodeMessage("AgentServerMessage", message))

async function listen(server: http2.Http2Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as net.AddressInfo).port
}

// The provider's own connect call, over plain TCP to `port`.
function routeConnectionsTo(port: number): void {
  ;(http2 as { connect: unknown }).connect = (origin: string, options?: http2.ClientSessionOptions) =>
    realConnect(origin, { ...options, createConnection: () => net.connect(port, "127.0.0.1") })
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}

beforeAll(() => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CURSOR_CLIENT_VERSION = "cli-compression-test-1"
  resetClientVersionCache()
})

afterAll(() => {
  ;(http2 as { connect: unknown }).connect = realConnect
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
  if (savedClientVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
  else process.env.CURSOR_CLIENT_VERSION = savedClientVersion
  resetClientVersionCache()
})

describe("isCompressionRejection", () => {
  it("recognizes how a server without gzip refuses it", () => {
    expect(isCompressionRejection({ httpStatus: 415 })).toBe(true)
    expect(isCompressionRejection(UNSUPPORTED)).toBe(true)
    expect(isCompressionRejection({ code: "unimplemented" })).toBe(true)
    expect(isCompressionRejection({ code: "12", message: "grpc: Decompressor is not installed for grpc-encoding \"gzip\"" })).toBe(true)
    expect(isCompressionRejection({ code: "invalid_argument", message: "decompress: gzip: invalid header" })).toBe(true)
    expect(isCompressionRejection({ code: "13", message: "sent compressed message without compression support" })).toBe(true)
  })

  it("does not blame compression for other failures", () => {
    for (const status of [
      { httpStatus: 200 },
      { httpStatus: 400 },
      { code: "0" },
      { code: "internal" },
      { code: "internal", message: "upstream model error" },
      { code: "invalid_argument", message: "conversation_state is too large" },
      { code: "unavailable", message: "gzip" },
      { code: "resource_exhausted" },
      {},
    ]) {
      expect(isCompressionRejection(status)).toBe(false)
    }
  })
})

type Answer = "ok" | "unimplemented" | "decompress" | "unrelated" | "garbage" | "http-415" | "grpc-headers" | "grpc-trailers"

describe("Run stream compression", () => {
  const streams: Array<{ headers: http2.IncomingHttpHeaders; frames: Frame[] }> = []
  const answers: Answer[] = []
  let server: http2.Http2Server

  beforeAll(async () => {
    server = http2.createServer()
    server.on("stream", (stream, headers) => {
      const record = { headers, frames: [] as Frame[] }
      streams.push(record)
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
        record.frames = [...streamFrames(new Uint8Array(Buffer.concat(chunks)))]
      })
      stream.on("error", () => {})
      const ok = { ":status": 200, "content-type": "application/connect+proto" }
      switch (answers.shift() ?? "ok") {
        case "ok":
          stream.respond(ok)
          stream.write(encodeFrame(0x00, new Uint8Array([1])))
          break
        case "unimplemented":
          stream.respond(ok)
          stream.end(endStream({ error: UNSUPPORTED }))
          break
        case "decompress":
          stream.respond(ok)
          stream.end(endStream({ error: { code: "internal", message: "failed to decompress gzip message" } }))
          break
        case "unrelated":
          stream.respond(ok)
          stream.end(endStream({ error: { code: "internal", message: "upstream model error" } }))
          break
        case "garbage":
          stream.respond(ok)
          stream.end(endStream("not json"))
          break
        case "http-415":
          stream.respond({ ":status": 415 }, { endStream: true })
          break
        case "grpc-headers":
          stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "12" }, { endStream: true })
          break
        case "grpc-trailers":
          stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true })
          stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "12", "grpc-message": "unknown encoding gzip" }))
          stream.end()
          break
      }
    })
    routeConnectionsTo(await listen(server))
  })

  beforeEach(() => {
    resetRunCompressionForTests()
  })

  afterEach(() => {
    closeCachedHttp2SessionsForTests()
    resetRunCompressionForTests()
    streams.length = 0
    answers.length = 0
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  async function drain(run: { frames(): AsyncIterable<unknown> }): Promise<void> {
    try {
      for await (const _ of run.frames()) { /* until the Run ends */ }
    } catch { /* a refused Run ends with its error */ }
  }

  it("announces gzip and compresses only messages of 1 KiB or more", async () => {
    const tiny = new Uint8Array([9, 9, 9])
    const under = new Uint8Array(RUN_COMPRESS_MIN_BYTES - 1).fill(7)
    const at = new Uint8Array(RUN_COMPRESS_MIN_BYTES).fill(7)
    const large = new Uint8Array(200 * 1024).map((_, i) => i % 13)
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    for (const message of [tiny, under, at, large]) run.write(message)
    await until(() => streams[0]?.frames.length === 4)

    const [stream] = streams
    expect(stream!.headers["connect-content-encoding"]).toBe("gzip")
    expect(stream!.frames.map((frame) => frame.flags)).toEqual([0x00, 0x00, FLAG_GZIP, FLAG_GZIP])
    expect(stream!.frames[0]!.payload).toEqual(tiny)
    expect(stream!.frames[1]!.payload).toEqual(under)
    expect(new Uint8Array(gunzipSync(stream!.frames[2]!.payload))).toEqual(at)
    expect(new Uint8Array(gunzipSync(stream!.frames[3]!.payload))).toEqual(large)
    expect(stream!.frames[3]!.payload.length).toBeLessThan(large.length / 4)
    expect(run.compressionRejected?.()).toBe(false)
    run.end()
  })

  it.each(["unimplemented", "decompress", "http-415", "grpc-headers", "grpc-trailers"] as const)(
    "sends the origin's later Runs uncompressed after Cursor refuses a gzip Run (%s)",
    async (refusal) => {
      answers.push(refusal)
      const large = new Uint8Array(8 * 1024).fill(3)
      const first = await bidiRunStream("token", { baseURL: ORIGIN })
      first.write(large)
      await drain(first)
      expect(first.compressionRejected?.()).toBe(true)

      const second = await bidiRunStream("token", { baseURL: ORIGIN })
      second.write(large)
      await until(() => streams[1]?.frames.length === 1)

      expect(streams[0]!.headers["connect-content-encoding"]).toBe("gzip")
      expect(streams[1]!.headers["connect-content-encoding"]).toBeUndefined()
      expect(streams[1]!.frames[0]!.flags).toBe(0x00)
      expect(streams[1]!.frames[0]!.payload).toEqual(large)
      expect(second.compressionRejected?.()).toBe(false)
      second.end()
    },
  )

  it.each(["unrelated", "garbage"] as const)("keeps compressing after a failure unrelated to compression (%s)", async (failure) => {
    answers.push(failure)
    const first = await bidiRunStream("token", { baseURL: ORIGIN })
    first.write(new Uint8Array(8 * 1024).fill(3))
    await drain(first)
    expect(first.compressionRejected?.()).toBe(false)

    const second = await bidiRunStream("token", { baseURL: ORIGIN })
    second.write(new Uint8Array(8 * 1024).fill(3))
    await until(() => streams[1]?.frames.length === 1)
    expect(streams[1]!.headers["connect-content-encoding"]).toBe("gzip")
    expect(streams[1]!.frames[0]!.flags).toBe(FLAG_GZIP)
    second.end()
  })
})

type SeenRun = { encoding?: string; flags: number[]; request?: Uint8Array; state?: Uint8Array }
type Refusal = "after-request" | "before-reading" | "after-output" | undefined

describe("Cursor refusing a gzip Run through the provider", () => {
  const seen: SeenRun[] = []
  let refusal: Refusal
  let refuseOnlyWarm = false
  let slowResend = false
  let server: http2.Http2Server
  let directory: string

  const checkpoint = encodeMessage("ConversationStateStructure", { root_prompt_messages_json: ["turn-1"] })
  const answer = (stream: http2.ServerHttp2Stream) => {
    stream.write(serverFrame({ interaction_update: { text_delta: { text: "Done." } } }))
    stream.write(serverFrame({ conversation_checkpoint_update: checkpoint }))
    stream.write(serverFrame({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } }))
  }

  beforeAll(async () => {
    server = http2.createServer()
    server.on("stream", (stream, headers) => {
      const run: SeenRun = { flags: [] }
      if (typeof headers["connect-content-encoding"] === "string") run.encoding = headers["connect-content-encoding"]
      seen.push(run)
      stream.on("error", () => {})
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
      const refusing = run.encoding === "gzip" && refusal !== undefined
      if (refusing && refusal === "before-reading") {
        // A Connect server without gzip refuses from the headers and never reads the body.
        stream.end(endStream({ error: UNSUPPORTED }), () => {
          try { stream.close(http2.constants.NGHTTP2_NO_ERROR) } catch { /* already closed */ }
        })
        return
      }
      if (slowResend && run.encoding === undefined) {
        stream.pause()
        setTimeout(() => stream.resume(), 400)
      }
      let pending = Buffer.alloc(0)
      stream.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 5) {
          const length = pending.readUInt32BE(1)
          if (pending.length < 5 + length) break
          const flags = pending[0]!
          const payload = decodeFramePayload({ flags, payload: pending.subarray(5, 5 + length) })
          pending = pending.subarray(5 + length)
          run.flags.push(flags)
          const message = decodeMessage<{ run_request?: { conversation_state?: Uint8Array } }>("AgentClientMessage", payload)
          if (!message.run_request || run.request) continue
          run.request = payload
          run.state = message.run_request.conversation_state
          if (refusing && (!refuseOnlyWarm || run.state?.length)) {
            if (refusal === "after-output") stream.write(serverFrame({ interaction_update: { text_delta: { text: "partial" } } }))
            stream.end(endStream({ error: UNSUPPORTED }))
            return
          }
          answer(stream)
        }
      })
    })
    routeConnectionsTo(await listen(server))
  })

  beforeEach(async () => {
    resetRunCompressionForTests()
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-run-compression-"))
    const models = mapAvailableModelsResponse({ models: [{ name: "gzip-fixture" }] })
    await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
  })

  afterEach(async () => {
    await settleRunSavesForTests()
    sessionManager.dispose()
    resetTurnStateForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    setHostCacheDirOverride(undefined)
    closeCachedHttp2SessionsForTests()
    resetRunCompressionForTests()
    await fs.rm(directory, { recursive: true, force: true })
    seen.length = 0
    refusal = undefined
    refuseOnlyWarm = false
    slowResend = false
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  async function turn(
    texts: string[],
    sessionKey: string,
    continuation?: { heartbeatMs: number; semanticIdleMs: number },
  ): Promise<LanguageModelV3StreamPart[]> {
    const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: directory, continuation })
      .languageModel("gzip-fixture")
    const prompt = texts.flatMap((text, index) => [
      ...(index > 0 ? [{ role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }] : []),
      { role: "user" as const, content: [{ type: "text" as const, text }] },
    ])
    // One advertised tool makes this a main Run rather than a lifecycle helper.
    const { stream } = await model.doStream({
      prompt,
      tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-opencode-session-id": sessionKey },
    })
    const parts: LanguageModelV3StreamPart[] = []
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return parts
        parts.push(value)
      }
    } catch (error) {
      parts.push({ type: "error", error })
      return parts
    }
  }

  const textOf = (parts: LanguageModelV3StreamPart[]) =>
    parts.filter((part) => part.type === "text-delta").map((part) => (part as { delta: string }).delta).join("")
  const errors = (parts: LanguageModelV3StreamPart[]) => parts.filter((part) => part.type === "error")

  it("sends the Run's request once more uncompressed when Cursor refuses it after it went out", async () => {
    refusal = "after-request"
    const parts = await turn(["Say done."], "ses_gzip_after_request")

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined])
    expect(seen[0]!.flags).toContain(FLAG_GZIP)
    expect(seen[1]!.flags.every((flags) => flags === 0)).toBe(true)
    expect(seen[1]!.request).toEqual(seen[0]!.request!)

    // Later turns go uncompressed from the start.
    await turn(["Say done.", "Again."], "ses_gzip_after_request")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined, undefined])
  })

  it("keeps the Run through heartbeats and its idle window while the uncompressed resend uploads", async () => {
    refusal = "after-request"
    slowResend = true
    const large = `Summarize this: ${randomBytes(3_000_000).toString("base64")}`
    // The resend's upload stalls for 400 ms, past both.
    const parts = await turn([large], "ses_gzip_slow_resend", { heartbeatMs: 20, semanticIdleMs: 300 })

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined])
    expect(seen[1]!.request).toEqual(seen[0]!.request!)
  }, 30_000)

  it("sends the Run's request once more uncompressed when Cursor refuses it while it uploads", async () => {
    refusal = "before-reading"
    const large = `Summarize this: ${randomBytes(4_500_000).toString("base64")}`
    const parts = await turn([large], "ses_gzip_before_reading")

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined])
    expect(seen[0]!.request).toBeUndefined()
    expect(seen[1]!.flags.every((flags) => flags === 0)).toBe(true)
    expect(new TextDecoder().decode(seen[1]!.request)).toContain(large)
  }, 30_000)

  it("keeps a refused warm turn on its conversation and checkpoint", async () => {
    refusal = "after-request"
    refuseOnlyWarm = true
    expect(textOf(await turn(["First."], "ses_gzip_warm"))).toBe("Done.")
    const parts = await turn(["First.", "Second."], "ses_gzip_warm")

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", "gzip", undefined])
    expect(seen[1]!.state).toEqual(checkpoint)
    expect(seen[2]!.request).toEqual(seen[1]!.request!)
  })

  it("does not resend a refused Run after it showed output", async () => {
    refusal = "after-output"
    const parts = await turn(["Say done."], "ses_gzip_after_output")

    expect(errors(parts)).not.toEqual([])
    expect(seen).toHaveLength(1)
  })
})
