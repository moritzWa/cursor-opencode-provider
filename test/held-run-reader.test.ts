import { afterEach, describe, expect, it } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { readHeldRun } from "../src/language-model.js"
import { readSessionFrame, SessionManager, sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

afterEach(() => sessionManager.dispose())

/** A Run whose inbound frames arrive only when the test sends them. */
function heldRun(register = true): { session: CursorSession; send: (message: Record<string, unknown>) => void; written: Array<Record<string, any>> } {
  const queued: Frame[] = []
  const waiting: Array<(result: IteratorResult<Frame>) => void> = []
  const frames: AsyncIterator<Frame> = {
    next: () => {
      const frame = queued.shift()
      if (frame) return Promise.resolve({ done: false, value: frame })
      return new Promise((resolve) => waiting.push(resolve))
    },
  }
  const written: Array<Record<string, any>> = []
  const session = sessionFixture({
    sessionId: `held-${Math.random().toString(16).slice(2)}`,
    conversationId: `conv-held-${Math.random().toString(16).slice(2)}`,
    stream: {
      write(bytes: Uint8Array) {
        written.push(decodeMessage<Record<string, any>>("AgentClientMessage", bytes))
        return true
      },
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
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    heartbeatCancel: null,
    closed: false,
  })
  if (register) sessionManager.registerSession(session)
  const send = (message: Record<string, unknown>) => {
    const frame = { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
    const resolve = waiting.shift()
    if (resolve) resolve({ done: false, value: frame })
    else queued.push(frame)
  }
  return { session, send, written }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const kvSet = (id: number) => ({
  kv_server_message: { id, set_blob_args: { blob_id: new Uint8Array(32).fill(id), blob_data: Uint8Array.from([1, 2, 3]) } },
})
const heartbeat = { interaction_update: { heartbeat: {} } }

describe("held Run reader", () => {
  it("answers KV and applies an abort while the host runs the tool, then leaves the next frame for the pump", async () => {
    const { session, send, written } = heldRun()
    sessionManager.registerPending(0, session, "shell_result", "bash", false)
    readHeldRun(session)

    send(heartbeat)
    send(kvSet(7))
    await settle()
    expect(written.map((message) => message.kv_client_message?.id)).toEqual([7])
    expect(written[0]!.kv_client_message.set_blob_result).toBeDefined()

    // Exec 0 is the first exec of a Run; its id is absent on the wire.
    send({ exec_server_control_message: { abort: { id: 0 } } })
    await settle()
    expect(session.pending.get(0)?.aborted).toBe(true)

    send({ interaction_update: { text_delta: { text: "after the abort" } } })
    send(kvSet(8))
    await settle()
    // The reader stopped at the text: the KV request behind it waits for the pump, in order.
    expect(written).toHaveLength(1)
    const next = await readSessionFrame(session)
    expect(next.done).toBe(false)
    const text = decodeMessage<Record<string, any>>("AgentServerMessage", (next.value as Frame).payload)
    expect(text.interaction_update.text_delta.text).toBe("after the abort")
    const after = await readSessionFrame(session)
    expect(decodeMessage<Record<string, any>>("AgentServerMessage", (after.value as Frame).payload).kv_server_message.id).toBe(8)
  })

  it("leaves a frame to a pump that started while the reader waited", async () => {
    const { session, send, written } = heldRun()
    sessionManager.registerPending(1, session, "read_result", "read", false)
    readHeldRun(session)
    await settle()

    const owner = Symbol("continuation pump")
    sessionManager.beginPump(session, owner)
    send(kvSet(9))
    const frame = await readSessionFrame(session)
    await settle()
    expect(written).toHaveLength(0)
    expect(decodeMessage<Record<string, any>>("AgentServerMessage", (frame.value as Frame).payload).kv_server_message.id).toBe(9)
    sessionManager.endPump(session, owner)
  })

  it("does not read a Run that owes nothing, is pumping, or has a frame pushed back", async () => {
    const idle = heldRun()
    readHeldRun(idle.session)
    idle.send(kvSet(1))
    await settle()
    expect(idle.written).toHaveLength(0)

    const pushed = heldRun()
    sessionManager.registerPending(2, pushed.session, "read_result", "read", false)
    pushed.session.pushbackFrame = { flags: 0, payload: encodeMessage("AgentServerMessage", heartbeat) }
    readHeldRun(pushed.session)
    pushed.send(kvSet(2))
    await settle()
    expect(pushed.written).toHaveLength(0)
  })

  it("does not let an exec Cursor aborted keep its Run from the open-session cap", () => {
    const manager = new SessionManager({ maxOpenSessions: 1 })
    const waiting = heldRun(false).session
    manager.registerSession(waiting)
    manager.registerPending(3, waiting, "read_result", "read", false)
    const aborted = heldRun(false).session
    manager.registerSession(aborted)
    manager.registerPending(4, aborted, "read_result", "read", false)
    expect(manager.markExecAborted(aborted, 4)).toBe(true)

    manager.registerSession(heldRun(false).session)
    // The Run still waiting on the host stays; the one Cursor released is the idle one.
    expect(waiting.closed).toBe(false)
    expect(aborted.closed).toBe(true)
    manager.dispose()
  })
})
