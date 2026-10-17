import { describe, expect, it } from "bun:test"
import {
  CURSOR_VARIANT_PARAMETERS_KEY,
  mapAvailableModelsResponse,
  resolveVariantMaxMode,
  resolveVariantParameters,
  type ModelInfo,
  type ModelVariant,
} from "../src/models.js"
import { modelsToConfig } from "../src/model-config.js"
import { getCursorModelCost, wireModelIdForPricing } from "../src/pricing.js"
import { modelsToCatalogModelMap } from "../src/opencode2/catalog.js"

function variant(context: string, effort: string, fast = false): ModelVariant {
  return {
    key: `${context}-${effort}-${fast}`,
    displayName: `${context} ${effort} ${fast}`,
    isDefaultNonMax: context === "256k" && effort === "high" && fast,
    isDefaultMax: context !== "256k" && effort === "high" && fast,
    isMaxMode: context !== "256k",
    parameterValues: [
      { id: "context", value: context },
      { id: "reasoning_effort", value: effort },
      { id: "fast", value: String(fast) },
    ],
  }
}

describe("adversarial model selection", () => {
  it("derives context limits from marked tiers when default flags are absent", () => {
    const [model] = mapAvailableModelsResponse({ models: [{ name: "tiered", variants: [
      variant("500k", "low"), variant("256k", "low"),
    ] }] })
    expect(model?.maxContext).toBe(256_000)
    expect(model?.maxContextForMaxMode).toBe(500_000)
  })

  it("skips contextless variants when deriving tier limits", () => {
    const contextless = { ...variant("256k", "low"), parameterValues: [] }
    const [model] = mapAvailableModelsResponse({ models: [{ name: "tiered", variants: [
      contextless, variant("500k", "low"), variant("256k", "low"),
    ] }] })
    expect(model?.maxContext).toBe(256_000)
  })

  it("materializes the 500k max tier with matching limits, defaults and pricing", () => {
    const model: ModelInfo = {
      id: "grok-4.7", maxContext: 256_000, maxContextForMaxMode: 500_000,
      variants: ["256k", "500k"].flatMap((context) =>
        ["low", "high"].flatMap((effort) => [false, true].map((fast) => variant(context, effort, fast))),
      ),
    }
    const config = modelsToConfig([model])
    expect(config["grok-4.7"].limit.context).toBe(256_000)
    expect(config["grok-4.7-500k"].limit.context).toBe(500_000)
    expect(config["grok-4.7-500k-fast"].limit.context).toBe(500_000)
    expect(config["grok-4.7-500k"].options[CURSOR_VARIANT_PARAMETERS_KEY])
      .toEqual(variant("500k", "high").parameterValues)
    expect(Object.values(config["grok-4.7"].variants)).toHaveLength(2)
    expect(Object.values(config["grok-4.7-500k"].variants)).toHaveLength(2)
    expect(config["grok-4.7-500k"].cost).toEqual(getCursorModelCost("grok-4.7"))
    const catalog2 = modelsToCatalogModelMap([model])
    expect(catalog2["grok-4.7-500k"]).toMatchObject({
      modelID: "grok-4.7", limit: { context: 500_000 },
      settings: { [CURSOR_VARIANT_PARAMETERS_KEY]: variant("500k", "high").parameterValues },
    })
    expect(catalog2["grok-4.7-500k-fast"]?.cost).toHaveLength(2)
    expect(wireModelIdForPricing("grok-4.7-500k-fast")).toEqual({
      baseId: "grok-4.7-fast", longContextEntry: true,
    })
    expect(getCursorModelCost("grok-4.7-500k-2-fast")).toEqual(getCursorModelCost("grok-4.7-fast"))
    const colliding = modelsToConfig([model, { id: "grok-4.7-500k", variants: [] },
      { id: "grok-4.7-500k-fast", variants: [] }])
    expect(colliding["grok-4.7-500k-2"].limit.context).toBe(500_000)
    expect(colliding["grok-4.7-500k-2-fast"].limit.context).toBe(500_000)
  })

  it("keeps an intrinsic marked context on its original model id", () => {
    const model: ModelInfo = { id: "intrinsic", maxContext: 500_000,
      variants: [variant("500k", "high")] }
    const catalog = modelsToConfig([model])
    expect(Object.keys(catalog)).toEqual(["intrinsic"])
    expect(catalog.intrinsic.limit.context).toBe(500_000)
  })

  it("uses each advertised context limit when there are multiple max tiers", () => {
    const model: ModelInfo = { id: "multi-tier", maxContext: 256_000, maxContextForMaxMode: 500_000,
      variants: [variant("256k", "high"), variant("500k", "high"), variant("1m", "high")] }
    const catalog = modelsToConfig([model])
    expect(catalog["multi-tier-1m"].limit.context).toBe(1_000_000)
    expect(catalog["multi-tier-500k"].limit.context).toBe(500_000)
  })

  it("keeps effort-only selection in the base tier even when max is listed first", () => {
    const base = variant("256k", "high")
    const model: ModelInfo = { id: "tiered", variants: [variant("500k", "high"), base] }
    const params = resolveVariantParameters(model, { reasoningEffort: "high" })
    expect(params).toEqual(base.parameterValues)
    expect(resolveVariantMaxMode(params, { model })).toBe(false)
  })

  it("selects a Fast-only max tier before applying the non-Fast preference", () => {
    const max = variant("500k", "high", true)
    const model: ModelInfo = { id: "tiered", variants: [variant("256k", "low"), max] }
    for (const reasoningEffort of [undefined, "high"]) {
      const params = resolveVariantParameters(model, { maxMode: true, reasoningEffort })
      expect(params).toEqual(max.parameterValues)
      expect(resolveVariantMaxMode(params, { model, maxMode: true })).toBe(true)
    }
  })

  it("keeps a valid default tuple when the requested effort exists only in max mode", () => {
    const base = { ...variant("256k", "low"), isDefaultNonMax: true }
    const model: ModelInfo = { id: "tiered", variants: [variant("500k", "high"), base] }
    expect(resolveVariantParameters(model, { reasoningEffort: "high" })).toEqual(base.parameterValues)
  })
})
