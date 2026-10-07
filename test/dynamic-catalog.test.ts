import { describe, expect, it } from "bun:test"
import {
  buildDynamicCatalogRoutingInstruction,
  listAdvertisedMcpServers,
} from "../src/context/dynamic-catalog.js"

describe("listAdvertisedMcpServers", () => {
  it("names only configured servers that own an advertised tool", () => {
    expect(
      listAdvertisedMcpServers(
        [
          "skill",
          "read",
          "apply_patch",
          "cursor_image_save",
          "foo_bar",
          "context7_query-docs",
          "codesearch_find",
          "todowrite",
          "github_create_pull_request",
        ],
        ["github", "context7", "codesearch", "unused"],
      ),
    ).toEqual(["context7", "codesearch", "github"])
  })

  it("never infers servers from underscores without config", () => {
    expect(listAdvertisedMcpServers(["apply_patch", "foo_bar", "context7_query-docs"])).toEqual([])
  })

  it("resolves sanitized and prefix-overlapping server ids like the descriptors", () => {
    expect(
      listAdvertisedMcpServers(["my_docs_search", "git_hub_issue", "git_log"], ["my.docs", "git", "git_hub"]),
    ).toEqual(["my_docs", "git_hub", "git"])
  })
})

describe("buildDynamicCatalogRoutingInstruction", () => {
  it("returns undefined without skill or configured MCP tools", () => {
    expect(
      buildDynamicCatalogRoutingInstruction({
        toolNames: ["read", "grep", "custom_websearch", "apply_patch"],
      }),
    ).toBeUndefined()
  })

  it("names skill and configured MCP servers for GetDynamicTools routing", () => {
    const line = buildDynamicCatalogRoutingInstruction({
      toolNames: ["skill", "context7_query-docs", "read"],
      knownMcpServers: ["context7"],
    })
    expect(line).toContain("including `skill` and MCP servers such as `context7`")
    expect(line).toContain("GetDynamicTools / CallDynamicTool")
    expect(line).toContain("before Grep/Shell fallbacks")
    expect(line).toContain("Use the `skill` tool to load a skill when a task matches its description")
    expect(line).toContain("does not need to be invoked again")
    expect(line).toContain("Host tools are in namespace `opencode` and MCP tools in their server's namespace; namespace `cursor` holds only Cursor's built-in tools.")
  })

  it("names the host tool namespace without MCP servers", () => {
    const line = buildDynamicCatalogRoutingInstruction({ toolNames: ["skill", "read"] })
    expect(line).toContain("Host tools are in namespace `opencode`; namespace `cursor` holds only Cursor's built-in tools.")
  })

  it("reports servers beyond the listed limit", () => {
    const servers = Array.from({ length: 10 }, (_, i) => `srv${i}`)
    const line = buildDynamicCatalogRoutingInstruction({
      toolNames: servers.map((server) => `${server}_tool`),
      knownMcpServers: servers,
    })
    expect(line).toContain("`srv7` (+2 more)")
    expect(line).not.toContain("`srv8`")
  })
})
