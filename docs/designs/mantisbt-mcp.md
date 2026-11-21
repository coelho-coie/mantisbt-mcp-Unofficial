# Design Specification: MantisBT MCP Server

## 1. Context & Objective
Provide a Model Context Protocol (MCP) server for MantisBT (`https://mantisbt.org/`) enabling full platform coverage via its REST API (`/api/rest/*`), with a primary aggregation tool (`get_my_unresolved_assigned_context`) that collects and normalizes all unresolved issues assigned to a user for LLM consumption.

## 2. Structural Goldfish Findings & Mitigations

1. **Ad-hoc Filtering Limitation in MantisBT REST API**
   - *Finding*: `GET /api/rest/issues` only accepts `project_id`, `filter_id`, `page`, and `page_size`. It does not natively filter by arbitrary `handler_id` + `status < 80` query parameters.
   - *Mitigation*: Hybrid collection in `get_my_unresolved_assigned_context`: tries `filter_id` (explicit or built-in `"assigned"` when querying the authenticated user), falls back to bounded paginated scanning, and enforces deterministic client-side filtering (`issue.handler.id === targetUserId && issue.status.id < resolved_status_threshold`).

2. **Context Window Overflow from Attachments & History**
   - *Finding*: Dumping binary Base64 attachments or unnormalized JSON into LLM context degrades token budget.
   - *Mitigation*: `normalizeIssueForLLM` emits structured metadata for attachments (`id`, `filename`, `size_bytes`, `content_type`, `created_at`) while `get_issue_attachment` retrieves attachment payloads on demand.

## 3. Architecture
- **Runtime**: Node.js >= 18 (native `fetch`), TypeScript (`ES2022` / `Node16`).
- **SDK**: `@modelcontextprotocol/sdk` (`McpServer`, `StdioServerTransport`) + `zod`.
- **Entrypoint**: `src/index.ts` -> compiled to `dist/index.js`.
