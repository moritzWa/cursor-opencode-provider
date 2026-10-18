import { afterEach, describe, expect, it } from "bun:test"
import { CursorRetryExhaustedError, CursorServerError, CursorTransportError, hostFacingError } from "../src/errors.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"
import { endlessRetriesEnabled, forgetRetryBudget, newRetryBudget, reserveRetry, resetRetryBudgetsForTests, retryCategory, turnRetryBudget } from "../src/retry-budget.js"

const savedEndless = process.env.CURSOR_ENDLESS_RETRIES
afterEach(() => {
  if (savedEndless === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
  else process.env.CURSOR_ENDLESS_RETRIES = savedEndless
  resetRetryBudgetsForTests()
})

const transport = () => new CursorTransportError("Connection reset", { transient: true, replaySafe: true, code: "ECONNRESET" })
const server = () => new CursorServerError("unavailable", { transient: true, replaySafe: true })
const stall = () => new CursorTransportError("Stalled", { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })

describe("Cursor CLI retry budgets", () => {
  it("allows ten transport retries and three server retries independently", () => {
    delete process.env.CURSOR_ENDLESS_RETRIES
    const budget = newRetryBudget()
    for (let i = 0; i < 10; i++) reserveRetry(budget, transport())
    for (let i = 0; i < 3; i++) reserveRetry(budget, server())
    for (const failure of [transport(), server()]) {
      expect(() => reserveRetry(budget, failure)).toThrow(CursorRetryExhaustedError)
    }
    expect(budget.retries).toBe(13)
  })

  it("uses the server budget for early EOF and read-idle, and transport for stalls", () => {
    expect(retryCategory(new CursorRunInterruptedError())).toBe("server")
    expect(retryCategory(new CursorTransportError("idle", { code: "CURSOR_READ_IDLE_TIMEOUT", transient: true, replaySafe: true }))).toBe("server")
    expect(retryCategory(stall())).toBe("transport")
  })

  it("retains the allowance across module copies, host retries and tool steps, until completion or Stop", async () => {
    const first = turnRetryBudget("session", "turn")
    reserveRetry(first, server())
    const copy = await import(`../src/retry-budget.js?copy=${crypto.randomUUID()}`)
    expect(copy.turnRetryBudget("session", "turn")).toBe(first)
    expect(turnRetryBudget("other", "turn").retries).toBe(0)
    const helper = turnRetryBudget("session", "helper")
    forgetRetryBudget("session", helper)
    expect(turnRetryBudget("session", "turn")).toBe(first)
    forgetRetryBudget("session")
    expect(turnRetryBudget("session", "turn").retries).toBe(0)
  })

  it("enforces an explicit total attempt ceiling across categories", () => {
    delete process.env.CURSOR_ENDLESS_RETRIES
    const budget = newRetryBudget()
    reserveRetry(budget, transport(), 2)
    let failure: unknown
    try { reserveRetry(budget, server(), 2) } catch (error) { failure = error }
    expect(hostFacingError(failure)).toMatchObject({ isRetryable: false, statusCode: 400, responseHeaders: { "x-should-retry": "false" } })
  })

  it("opts into endless counts only with 1 or true", () => {
    for (const value of ["", "0", "false", "TRUE", "yes"]) {
      process.env.CURSOR_ENDLESS_RETRIES = value
      expect(endlessRetriesEnabled()).toBe(false)
    }
    for (const value of ["1", "true"]) {
      process.env.CURSOR_ENDLESS_RETRIES = value
      const budget = newRetryBudget()
      for (let i = 0; i < 25; i++) {
        reserveRetry(budget, server(), 1)
        reserveRetry(budget, transport(), 1)
      }
      expect(budget.retries).toBe(50)
    }
  })

  it("keeps the 180 second consecutive-stall retry window even in endless mode", () => {
    process.env.CURSOR_ENDLESS_RETRIES = "true"
    const budget = newRetryBudget()
    reserveRetry(budget, stall(), undefined, 100)
    reserveRetry(budget, stall(), undefined, 180_099)
    expect(() => reserveRetry(budget, stall(), undefined, 180_100)).toThrow(CursorRetryExhaustedError)
    reserveRetry(budget, server(), undefined, 180_101)
    reserveRetry(budget, stall(), undefined, 180_102)
    expect(budget.stallStartedAt).toBe(180_102)
  })
})
