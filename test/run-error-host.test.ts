import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { CursorAuthError, CursorRetryExhaustedError, CursorServerError } from "../src/errors.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"

const ORIGIN = "https://agentn.run-error-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
// ErrorDetails{error:13, details{title, detail, is_retryable:false, analytics}, is_expected:true}, as Cursor sent it.
const POLICY_BLOCK = "CA0SlgEKHFJlcXVlc3QgYmxvY2tlZCBieSBBbnRocm9waWMSXVdlIGFyZSB1bmFibGUgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0IGJlY2F1c2UgaXQgd2FzIGJsb2NrZWQgdW5kZXIgQW50aHJvcGljJ3MgVXNhZ2UgUG9saWN5LiAAUhUKE2N5YmVyX3BvbGljeV9yZXZpZXcYAQ"

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let trailer: Record<string, unknown> = {}
let runs = 0
let partialOutput = false
let scripted: ((stream: http2.ServerHttp2Stream, message: Record<string, unknown>) => void) | undefined
const savedProxy: Record<string, string | undefined> = {}

function frame(payload: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

beforeAll(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.on("error", () => {})
    let pending = Buffer.alloc(0)
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<Record<string, unknown>>("AgentClientMessage", pending.subarray(5, 5 + length))
        pending = pending.subarray(5 + length)
        if (scripted) { scripted(stream, message); continue }
        if (!message.run_request) continue
        runs++
        if (partialOutput) {
          stream.write(frame(encodeMessage("AgentServerMessage", {
            interaction_update: { thinking_delta: { text: "Already delivered" } },
          })))
        }
        stream.write(frame(Buffer.from(JSON.stringify(trailer)), 2))
        stream.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as net.AddressInfo
  client = http2.connect(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve())
    client.once("error", reject)
  })
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
})

afterEach(() => {
  setHostCacheDirOverride(undefined)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  runs = 0
  partialOutput = false
  scripted = undefined
})

async function streamError(sessionKey: string): Promise<unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-run-error-"))
  cacheHttp2SessionForTests(ORIGIN, client)
  try {
    const model = createCursor({
      name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })
      .languageModel("composer-2.5")
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      headers: { "x-opencode-session-id": sessionKey },
    } as LanguageModelV3CallOptions)
    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) return undefined
    }
  } catch (error) {
    return error
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("checkpoint eligibility across host results", () => {
  for (const afterResult of [false, true]) {
    it(`only resumes a checkpoint received after the result (after: ${afterResult})`, async () => {
      const checkpoint = Uint8Array.of(10, 1, 7)
      let resumed = false
      scripted = (stream, message) => {
        const send = (message: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", message)))
        if (message.run_request) {
          runs++
          resumed = !!(message.run_request as { action?: { resume_action?: unknown } }).action?.resume_action
          if (resumed) {
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
          } else {
            send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo done", tool_call_id: "command" } } })
            // This frame arrives while the host tool is outstanding. The held
            // reader may queue it until after the host has delivered its result.
            if (!afterResult) send({ conversation_checkpoint_update: checkpoint })
          }
        } else if (message.exec_client_message) {
          if (afterResult) send({ conversation_checkpoint_update: checkpoint })
          send({ interaction_update: { thinking_delta: { text: "after the command" } } })
          stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
        }
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-result-checkpoint-"))
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({
          name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root,
          retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run echo done" }] }]
        const options = {
          prompt,
          tools: [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
          headers: { "x-opencode-session-id": `ses_result_checkpoint_${afterResult}` },
        }
        const read = async (options: LanguageModelV3CallOptions) => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return parts
            parts.push(value)
          }
        }
        const first = await read(options)
        const call = first.find(part => part.type === "tool-call")
        if (!call || call.type !== "tool-call") throw new Error("Expected the shell call")
        await new Promise<void>(resolve => setImmediate(resolve))
        prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
        prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "done" } }] })
        if (afterResult) {
          const parts = await read(options)
          expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(resumed).toBe(true)
          expect(runs).toBe(2)
        } else {
          const error = await read(options).catch((error: unknown) => error)
          expect(error).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
          expect(resumed).toBe(false)
          expect(runs).toBe(1)
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
})

describe("Run errors as the host sees them", () => {
  for (const method of ["doStream", "doGenerate"] as const) {
    for (const failure of ["empty token", "rejected login"] as const) {
      it(`ends ${method} on a pre-stream ${failure} without opening a Run`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-run-auth-error-"))
        let requests = 0
        const authError = new CursorAuthError("Cursor login expired; sign in again")
        try {
          const model = createCursor({
            name: "cursor",
            cacheDir: root,
            getAccessToken: async () => {
              requests++
              if (failure === "rejected login") throw authError
              return ""
            },
          }).languageModel("composer-2.5")
          let caught: unknown
          try {
            await model[method]({
              prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
              headers: { "x-opencode-session-id": `ses_auth_${method}_${failure}` },
            })
          } catch (error) {
            caught = error
          }
          expect(APICallError.isInstance(caught)).toBe(true)
          expect(caught).toMatchObject({
            statusCode: 401,
            isRetryable: false,
            responseHeaders: { "x-should-retry": "false" },
          })
          expect((caught as APICallError).cause).toBeInstanceOf(CursorAuthError)
          if (failure === "rejected login") expect((caught as APICallError).cause).toBe(authError)
          expect(requests).toBe(1)
          expect(runs).toBe(0)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }

  it("reports a request Cursor declared not retryable as a 400 APICallError, without a provider retry", async () => {
    trailer = {
      error: { code: "invalid_argument", message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: POLICY_BLOCK }] },
    }
    const error = await streamError("ses_policy_block")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ statusCode: 400, isRetryable: false })
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument): Request blocked by Anthropic " +
      "We are unable to complete this request because it was blocked under Anthropic's Usage Policy.")
    expect(runs).toBe(1)
  }, 30_000)

  it("keeps an error without a Cursor verdict as the provider error", async () => {
    trailer = { error: { code: "invalid_argument" } }
    const error = await streamError("ses_plain_error")

    expect(APICallError.isInstance(error)).toBe(false)
    expect(error).toBeInstanceOf(CursorServerError)
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument)")
    expect(runs).toBe(1)
  }, 30_000)

  it("stops host retries after the Run retry budget is spent", async () => {
    trailer = { error: { code: "unavailable" } }
    const error = await streamError("ses_terminal_budget")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({
      statusCode: 400,
      isRetryable: false,
      responseHeaders: { "x-should-retry": "false" },
    })
    const cause = (error as APICallError).cause
    expect(cause).toBeInstanceOf(CursorRetryExhaustedError)
    expect(cause).toMatchObject({ transient: false, replaySafe: false, code: "unavailable" })
    expect(runs).toBe(2)
  }, 30_000)

  // Cursor CLI sends the same action again. The provider cannot, because the
  // host already shows the reasoning, so the host retries the turn.
  it("leaves the retry to the host after output only, before any checkpoint", async () => {
    trailer = { error: { code: "unavailable" } }
    partialOutput = true
    const error = await streamError("ses_host_retry")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({
      statusCode: undefined,
      isRetryable: true,
      responseHeaders: { "x-should-retry": "true" },
    })
    expect((error as Error).message).not.toContain("automatic retry unsafe")
    const cause = (error as APICallError).cause
    expect(cause).toMatchObject({ hostRetryable: true, transient: false, replaySafe: false, code: "unavailable" })
    expect(runs).toBe(1)
  }, 30_000)
})
