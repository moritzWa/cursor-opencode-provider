import { CursorRetryExhaustedError, type CursorProviderError } from "./errors.js"
import { processShared } from "./process-shared.js"

/** Plain data shared by the plugin and SDK copies, for one logical user turn. */
export type RetryBudget = {
  server: number
  transport: number
  retries: number
  stallStartedAt?: number
}

const budgets = () => processShared("run-retry-budgets.v1", () => new Map<string, Map<string, RetryBudget>>())
const MAX_SESSIONS = 1_024
const MAX_TURNS_PER_SESSION = 16

export function newRetryBudget(): RetryBudget {
  return { server: 0, transport: 0, retries: 0 }
}

/** A host retry or tool continuation must not mint a fresh retry allowance. */
export function turnRetryBudget(sessionKey: string | undefined, turnKey: string): RetryBudget {
  if (!sessionKey) return newRetryBudget()
  const sessions = budgets()
  let turns = sessions.get(sessionKey)
  if (!turns) {
    turns = new Map()
  }
  sessions.delete(sessionKey)
  sessions.set(sessionKey, turns)
  let budget = turns.get(turnKey)
  if (!budget) {
    budget = newRetryBudget()
  }
  turns.delete(turnKey)
  turns.set(turnKey, budget)
  // Abandoned host retries and ephemeral helpers never reach turn_ended.
  // Bound their lookup records; live recovery loops retain their budget object.
  while (turns.size > MAX_TURNS_PER_SESSION) turns.delete(turns.keys().next().value!)
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
  return budget
}

export function forgetRetryBudget(sessionKey: string | undefined, budget?: RetryBudget): void {
  if (!sessionKey) return
  const sessions = budgets()
  const turns = sessions.get(sessionKey)
  if (!turns) return
  if (!budget) sessions.delete(sessionKey)
  else {
    for (const [key, value] of turns) if (value === budget) turns.delete(key)
    if (turns.size === 0) sessions.delete(sessionKey)
  }
}

export function endlessRetriesEnabled(): boolean {
  return process.env.CURSOR_ENDLESS_RETRIES === "1" || process.env.CURSOR_ENDLESS_RETRIES === "true"
}

/** Cursor CLI counts early EOF / read-idle as server failures, stalls as transport. */
export function retryCategory(failure: CursorProviderError): "server" | "transport" {
  return failure.origin === "transport"
    && failure.code !== "CURSOR_STREAM_CLOSED_EARLY"
    && failure.code !== "CURSOR_READ_IDLE_TIMEOUT" ? "transport" : "server"
}

/** Reserve one retry before either reopening locally or handing it to OpenCode. */
export function reserveRetry(budget: RetryBudget, failure: CursorProviderError, maxAttempts?: number, now = Date.now()): void {
  const category = retryCategory(failure)
  const stalled = failure.code === "CURSOR_SEMANTIC_IDLE_TIMEOUT"
  if (!stalled) budget.stallStartedAt = undefined
  const stallExpired = stalled && budget.stallStartedAt !== undefined && now - budget.stallStartedAt >= 180_000
  if (stallExpired || (!endlessRetriesEnabled() && (
    budget[category] >= (category === "server" ? 3 : 10)
    || (maxAttempts !== undefined && budget.retries >= maxAttempts - 1)
  ))) throw new CursorRetryExhaustedError(budget.retries + 1, failure)
  if (stalled) budget.stallStartedAt ??= now
  budget[category]++
  budget.retries++
}

export function resetRetryBudgetsForTests(): void {
  budgets().clear()
}
