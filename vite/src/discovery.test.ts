import { describe, expect, it } from "vitest";
import { llmsTxt, mcpDiscoveryJson, type McpDiscoveryDocument } from "./discovery.ts";

describe("llmsTxt", () => {
  it("writes the title, summary and links in the supplied order", () => {
    expect(
      llmsTxt({
        title: "Example",
        summary: "Read and update tasks.\nSign in before making changes.",
        sections: [
          {
            title: "Reference",
            links: [
              {
                title: "Connect",
                url: "https://example.com/docs/mcp",
                description: "Set up access.",
              },
              { title: "Full reference", url: "https://example.com/llms-full.txt" },
            ],
          },
        ],
      }),
    ).toBe(
      "# Example\n\n" +
        "> Read and update tasks.\n> Sign in before making changes.\n\n" +
        "## Reference\n\n" +
        "- [Connect](https://example.com/docs/mcp): Set up access.\n" +
        "- [Full reference](https://example.com/llms-full.txt)\n",
    );
  });

  it("keeps app-owned Markdown and writes exactly one final newline", () => {
    const body = '## Tools\n\n```json\n{"name":"list_tasks"}\n```\n\n';
    expect(llmsTxt({ title: "Example", body })).toBe(`# Example\n\n${body.trimEnd()}\n`);
    expect(llmsTxt({ title: "Example" })).toBe("# Example\n");
  });

  it("refuses an empty title", () => {
    expect(() => llmsTxt({ title: " " })).toThrow(/title.*empty.*Name/);
  });
});

const DOCUMENT: McpDiscoveryDocument = {
  name: "Example",
  homepage: "https://example.com",
  documentation: "https://example.com/docs/mcp",
  llmsTxt: "https://example.com/llms.txt",
  llmsFullTxt: "https://example.com/llms-full.txt",
  openApi: "https://api.example.com/openapi.json",
  servers: [
    {
      name: "full",
      transport: "streamable-http",
      url: "https://api.example.com/mcp",
      authentication: [
        {
          type: "oauth2",
          protectedResourceMetadata:
            "https://api.example.com/.well-known/oauth-protected-resource/mcp",
        },
        { type: "api-key", in: "header", name: "Authorization", prefix: "Bearer " },
      ],
      tools: [
        {
          name: "update_task",
          title: "Update a task",
          description: "Change a task's title.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string", minLength: 1 } },
            required: ["id", "title"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
      ],
    },
    {
      name: "read-only",
      transport: "streamable-http",
      url: "https://api.example.com/mcp/read",
      authentication: [{ type: "none" }],
      tools: ["list_tasks"],
    },
    {
      name: "local",
      transport: "stdio",
      command: "bunx",
      args: ["example-mcp"],
      authentication: [
        { type: "session", description: "Connect the local app before you run a tool." },
        { type: "api-key", in: "environment", name: "EXAMPLE_API_KEY" },
      ],
    },
  ],
};

describe("mcpDiscoveryJson", () => {
  it("keeps per-server transports, access methods and full tool cards unchanged", () => {
    const output = mcpDiscoveryJson(DOCUMENT);
    expect(JSON.parse(output)).toEqual(DOCUMENT);
    expect(output.startsWith('{\n  "name": "Example",')).toBe(true);
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
    expect(output).not.toContain('"url": "stdio');
    expect(output).not.toContain('"tools": []');
  });

  it("refuses empty names, server lists or access declarations", () => {
    expect(() => mcpDiscoveryJson({ ...DOCUMENT, name: " " })).toThrow(/name.*empty/);
    expect(() => mcpDiscoveryJson({ ...DOCUMENT, servers: [] })).toThrow(/servers.*empty/);
    expect(() =>
      mcpDiscoveryJson({
        ...DOCUMENT,
        servers: [{ name: "local", transport: "stdio", command: "bunx", authentication: [] }],
      }),
    ).toThrow(/local.*no authentication.*Declare/);
  });
});
