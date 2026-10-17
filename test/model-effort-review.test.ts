import { describe, expect, it } from "bun:test"
import { mapAvailableModelsResponse, normalizeModelCache, resolveVariantParameters, type ModelInfo, type ModelVariant } from "../src/models.js"

function variant(context: string, effort: string, fast = false): ModelVariant {
  return {
    key: `${context}-${effort}-${fast}`,
    displayName: `${context} ${effort} ${fast}`,
    isDefaultNonMax: context === "256k" && effort === "high" && fast,
    isDefaultMax: context !== "256k" && effort === "high" && fast,
    parameterValues: [
      { id: "context", value: context },
      { id: "reasoning_effort", value: effort },
      { id: "fast", value: String(fast) },
    ],
  }
}

describe("effort and tuple validation", () => {
  it.each(["effort", "reasoning", "reasoning_effort"])(
    "does not fabricate an unavailable %s tuple from an unsupported hint",
    (id) => {
      const declared = { ...variant("256k", "high"), isDefaultNonMax: true,
        parameterValues: [{ id, value: "high" }] }
      const model: ModelInfo = { id: "bounded-effort", variants: [declared] }
      expect(resolveVariantParameters(model, { reasoningEffort: "ultra" }))
        .toEqual(declared.parameterValues)
    },
  )

  it("rejects duplicate parameter ids before caching or matching a selection", () => {
    const malformed = { ...variant("256k", "high"), parameterValues: [
      { id: "effort", value: "high" }, { id: "effort", value: "high" },
    ] }
    const model: ModelInfo = { id: "duplicate-ids", variants: [malformed] }
    expect(normalizeModelCache({ models: [model], fetchedAt: 1 })).toBeNull()
    expect(() => mapAvailableModelsResponse({ models: [{ name: model.id, variants: [malformed] }] }))
      .toThrow(/invalid parameter/)
    expect(() => resolveVariantParameters(model, { picked: [
      { id: "effort", value: "high" }, { id: "fast", value: "false" },
    ] })).toThrow(/exact parameter tuple/)
  })

})
