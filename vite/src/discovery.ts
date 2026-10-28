/** Static discovery files. Content, addresses and access rules stay in the app. */

export interface LlmsLink {
  title: string;
  url: string;
  description?: string;
}

export interface LlmsSection {
  title: string;
  links: readonly LlmsLink[];
}

export interface LlmsTxtOptions {
  title: string;
  /** A short description, written as a blockquote. */
  summary?: string;
  /** Markdown kept as supplied. Use this for the text in llms-full.txt. */
  body?: string;
  sections?: readonly LlmsSection[];
}

/** llms.txt or llms-full.txt, as Markdown with a trailing newline. */
export function llmsTxt({ title, summary, body, sections = [] }: LlmsTxtOptions): string {
  if (title.trim() === "") throw new Error("llms: `title` is empty. Name the site or package.");
  const parts = [`# ${title}`];
  if (summary)
    parts.push(
      summary
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n"),
    );
  if (body) parts.push(body);
  for (const section of sections) {
    parts.push(`## ${section.title}`);
    parts.push(
      section.links
        .map(
          (link) =>
            `- [${link.title}](${link.url})${link.description ? `: ${link.description}` : ""}`,
        )
        .join("\n"),
    );
  }
  return `${parts.join("\n\n").trimEnd()}\n`;
}

/** Declare each accepted method. This is documentation, not an access check. */
export type McpDiscoveryAuthentication = (
  | { type: "oauth2"; protectedResourceMetadata: string }
  | { type: "api-key"; in: "header" | "environment"; name: string; prefix?: string }
  | { type: "none" }
  | { type: "session"; description: string }
) & { description?: string; documentation?: string };

/** A tool as this server exposes it, not the combined catalog of every server. */
export interface McpDiscoveryTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: object;
  annotations?: object;
}

export type McpDiscoveryServer = {
  name: string;
  /** Several entries mean the server accepts any one of these methods. */
  authentication: readonly McpDiscoveryAuthentication[];
  tools?: readonly (string | McpDiscoveryTool)[];
} & (
  | { transport: "streamable-http"; url: string }
  | { transport: "stdio"; command: string; args?: readonly string[] }
);

export interface McpDiscoveryDocument {
  name: string;
  description?: string;
  homepage: string;
  documentation: string;
  llmsTxt?: string;
  llmsFullTxt?: string;
  openApi?: string;
  servers: readonly McpDiscoveryServer[];
}

/**
 * /.well-known/mcp.json, as JSON with a trailing newline. This is a discovery convention,
 * not a standard client configuration or a replacement for MCP tools/list.
 * No transport, access rule or tool is inferred, and supplied schemas and annotations are kept.
 */
export function mcpDiscoveryJson(document: McpDiscoveryDocument): string {
  if (document.name.trim() === "")
    throw new Error("mcp discovery: `name` is empty. Name the site or package.");
  if (document.servers.length === 0)
    throw new Error("mcp discovery: `servers` is empty. List the servers this file describes.");
  for (const server of document.servers)
    if (server.authentication.length === 0)
      throw new Error(
        `mcp discovery: "${server.name}" has no authentication entry. Declare how access works, including type "none" when it is public.`,
      );
  return `${JSON.stringify(document, null, 2)}\n`;
}
