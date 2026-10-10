import { describe, expect, it } from "bun:test"
import { writeDrainTimeoutMs } from "../src/language-model.js"

describe("writeDrainTimeoutMs", () => {
  it("keeps the 5s floor for ordinary frames", () => {
    expect(writeDrainTimeoutMs(0)).toBe(5_000)
    expect(writeDrainTimeoutMs(64 * 1024)).toBe(5_000)
  })

  it("gives image-heavy requests time to upload", () => {
    const twentyMb = 20 * 1024 * 1024
    expect(writeDrainTimeoutMs(twentyMb)).toBeGreaterThan(5 * 60_000)
  })
})
