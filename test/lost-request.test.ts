import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  carryLostRequest,
  dropLostRequest,
  noteCheckpoint,
  rememberLostRequest,
  resetLostRequestsForTests,
} from "../src/lost-request.js"
import {
  hydrateConversationState,
  persistConversationState,
} from "../src/protocol/conversation-state.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetFrozenRequestContextsForTests, setFrozenRequestContext } from "../src/context/frozen.js"

const roots: string[] = []

afterEach(() => {
  resetLostRequestsForTests()
})

function remember(sessionKey: string, conversationId: string, checkpoint: Uint8Array | undefined, text: string): void {
  rememberLostRequest({ sessionKey, conversationId, checkpoint, text })
}

describe("lost requests", () => {
  it("prepends text Cursor never checkpointed, and drops it on a newer checkpoint, stop, or history rebuild", () => {
    const checkpoint = Uint8Array.from([1, 2, 3])
    remember("ses", "conv", checkpoint, "first request")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "second request",
      rebuildFromHistory: false,
    })).toBe("first request\n\nsecond request")
    remember("ses", "conv", checkpoint, "first request\n\nsecond request")

    noteCheckpoint("ses", Uint8Array.from([9]))
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "third",
      rebuildFromHistory: false,
    })).toBe("third")

    remember("ses", "conv", checkpoint, "kept")
    dropLostRequest("ses")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "after stop",
      rebuildFromHistory: false,
    })).toBe("after stop")

    remember("ses", "conv", checkpoint, "in history")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "rebuilt",
      rebuildFromHistory: true,
    })).toBe("rebuilt")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "again",
      rebuildFromHistory: false,
    })).toBe("again")
  })

  it("does not double an exact retry, and keeps both messages across a second failure", () => {
    const checkpoint = Uint8Array.from([4])
    remember("ses", "conv", checkpoint, "hello")
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "hello",
      rebuildFromHistory: false,
    })).toBe("hello")
    const combined = carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "next",
      rebuildFromHistory: false,
    })
    expect(combined).toBe("hello\n\nnext")
    remember("ses", "conv", checkpoint, combined)
    expect(carryLostRequest({
      sessionKey: "ses",
      conversationId: "conv",
      checkpoint,
      text: "third",
      rebuildFromHistory: false,
    })).toBe("hello\n\nnext\n\nthird")
  })

  it("restores the record from the conversation snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-lost-request-"))
    roots.push(root)
    const sessionKey = "ses_lost"
    const conversationId = "conv-lost"
    const checkpoint = Uint8Array.from([7, 7])
    const requestContext = { rules_info_complete: true }
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, checkpoint)
    setFrozenRequestContext(conversationId, requestContext)
    remember(sessionKey, conversationId, checkpoint, "uncheckpointed")
    await persistConversationState(root, { sessionKey, conversationId, requestContext })

    resetLostRequestsForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetConversationPersistenceForTests()
    resetFrozenRequestContextsForTests()
    const hydrated = await hydrateConversationState(root, sessionKey)
    expect(hydrated?.conversationId).toBe(conversationId)
    expect(carryLostRequest({
      sessionKey,
      conversationId,
      checkpoint,
      text: "after restart",
      rebuildFromHistory: false,
    })).toBe("uncheckpointed\n\nafter restart")
    await rm(root, { recursive: true, force: true })
  })
})
