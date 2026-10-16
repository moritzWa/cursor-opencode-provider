import { createHash } from "node:crypto"
import { processShared } from "./process-shared.js"

export type LostRequest = {
  conversationId: string
  checkpointKey: string
  text: string
}

const records = () => processShared("lost-request.v1", () => new Map<string, LostRequest>())

export function checkpointKey(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return "none"
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Prepend a user message whose Run never received a newer checkpoint.
 * A history rebuild already contains it, so that path drops the record.
 * An exact retry of the same text is left as-is.
 */
export function carryLostRequest(input: {
  sessionKey: string
  conversationId: string
  checkpoint: Uint8Array | undefined
  text: string
  rebuildFromHistory: boolean
}): string {
  const map = records()
  const record = map.get(input.sessionKey)
  if (!record) return input.text
  const key = checkpointKey(input.checkpoint)
  if (
    input.rebuildFromHistory
    || record.conversationId !== input.conversationId
    || record.checkpointKey !== key
  ) {
    map.delete(input.sessionKey)
    return input.text
  }
  if (input.text === record.text || input.text.startsWith(`${record.text}\n\n`)) return input.text
  map.delete(input.sessionKey)
  return `${record.text}\n\n${input.text}`
}

export function rememberLostRequest(input: {
  sessionKey: string
  conversationId: string
  checkpoint: Uint8Array | undefined
  text: string
}): void {
  if (!input.sessionKey || !input.text || input.text === ".") return
  records().set(input.sessionKey, {
    conversationId: input.conversationId,
    checkpointKey: checkpointKey(input.checkpoint),
    text: input.text,
  })
}

/** A checkpoint other than the one this turn was sent on means Cursor kept the turn. */
export function noteCheckpoint(sessionKey: string | undefined, bytes: Uint8Array): void {
  if (!sessionKey) return
  const map = records()
  const record = map.get(sessionKey)
  if (!record) return
  if (checkpointKey(bytes) !== record.checkpointKey) map.delete(sessionKey)
}

export function dropLostRequest(sessionKey: string | undefined): void {
  if (sessionKey) records().delete(sessionKey)
}

export function serializeLostRequest(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  const record = records().get(sessionKey)
  return record ? JSON.stringify(record) : undefined
}

export function restoreLostRequest(sessionKey: string, raw: string | undefined): void {
  if (!raw || records().has(sessionKey)) return
  let parsed: Partial<LostRequest>
  try {
    parsed = JSON.parse(raw) as Partial<LostRequest>
  } catch {
    return
  }
  if (
    typeof parsed.conversationId !== "string"
    || typeof parsed.checkpointKey !== "string"
    || typeof parsed.text !== "string"
    || parsed.text.length === 0
  ) return
  records().set(sessionKey, {
    conversationId: parsed.conversationId,
    checkpointKey: parsed.checkpointKey,
    text: parsed.text,
  })
}

export function resetLostRequestsForTests(): void {
  records().clear()
}
