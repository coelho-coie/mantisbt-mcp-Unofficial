# MantisBT MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that connects AI assistants to [MantisBT](https://mantisbt.org/), the open-source bug tracker. It exposes 25 tools covering the MantisBT REST API, a context-aggregation tool for an assignee's open work, and a local vector store that powers semantic search and engineering efficiency analytics.

## Features

- **Full REST coverage.** Issues, notes, time tracking, relationships, tags, attachments, monitoring, projects, versions, filters, users, and server configuration.
- **LLM-ready context.** `get_my_unresolved_assigned_context` gathers every unresolved issue assigned to a user, including notes, history, and custom fields, and summarizes them by project, priority, and status. Binary attachments are excluded and can be downloaded on demand.
- **Works around API limits.** MantisBT's REST API cannot filter by assignee and status together. The server combines native filters with a bounded paginated scan and client-side filtering.
- **Deployment-friendly URLs.** Accepts the site root, `/api/rest`, or `/api/rest/index.php`, and falls back automatically on servers without `mod_rewrite`.
- **Local semantic search.** Issues are embedded into 256-dimension vectors on your machine (no model download, no network), stored in one JSON file, and searched by cosine similarity. An OpenAI-compatible embedding endpoint can be used instead.
- **Engineering efficiency analytics.** Computes throughput, lead time (mean, P50, P90), reopen rate, assignment ping-pong, stagnant and overdue work, per-assignee breakdown, recurring semantic clusters of problems, and a deterministic 0–100 efficiency score with diagnostics.

## About the vector store (optional)

The vector store is a local index of your MantisBT issues. Every other tool works without it.

**What it is for**

- **Semantic search** (`search_vector_issues`): describe a problem and get the most similar issues by cosine similarity. Useful for finding duplicates and earlier bugs with the same cause, without scanning the API on every question.
- **Recurring-problem clusters** (`analyze_project_efficiency`): groups similar issues, such as several "payment timeout" reports, to show where the team repeats work. The same report adds throughput, lead time (mean, P50, P90), reopen rate, assignment ping-pong, stagnant and overdue work, and a 0-100 score. Most of those metrics are plain calculations on MantisBT data; only the clustering and search use similarity.
- **Offline and fast:** vectors live in one local JSON file, with no model download and no network. Fill it with `sync_issues_to_vector_store`.

**Limits**

- The default embedder hashes words and character trigrams. It matches shared words and patterns, not meaning, so "slow" and "lag" may not match. An OpenAI-compatible embedding endpoint can replace it, at the cost of sending issue text to a third party.
- The file is loaded fully into memory. It suits thousands of issues, not millions.
- It contains issue text, so treat it as confidential. It is git-ignored and written with owner-only permissions.
- Changing the embedding mode requires running `sync_issues_to_vector_store` again.
## Requirements

- Node.js 18 or later (uses the global `fetch`)
- A MantisBT instance with the REST API enabled
- A MantisBT API token for an account with the permissions you need

## Quick Start

```bash
git clone <repository-url> Mantis-MCP
cd Mantis-MCP
npm install
npm run build
npm test
```

Create a `.env` file from the template:

```bash
cp .env.example .env
```

Then set `MANTIS_BASE_URL` and `MANTIS_API_TOKEN`. Connect the server to your MCP client:

```json
{
  "mcpServers": {
    "mantisbt": {
      "command": "node",
      "args": ["/absolute/path/to/Mantis-MCP/dist/index.js"],
      "env": {
        "MANTIS_BASE_URL": "https://mantis.example.com",
        "MANTIS_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

Restart the client and run `check_mantis_connection` to confirm the setup.

## Installation Tutorial for Agents

This section is written for an AI agent (for example, a coding assistant) that installs the server on behalf of a user. Run each step in order. After each step, check the stated expected result before continuing. If a check fails, stop and report the output to the user. Do not skip steps or invent values.

### Step 1: Check prerequisites

Run:

```bash
node -v
npm -v
```

Expected: Node.js major version 18 or higher. npm is installed with Node.js.

If Node.js is missing or older than 18, stop and ask the user to install Node.js 18 or later. Do not install it silently.

### Step 2: Get the code

If the repository is not already on disk:

```bash
git clone <repository-url> Mantis-MCP
cd Mantis-MCP
```

If it is already on disk, change into its directory. The directory must contain `package.json` and `src/`.

### Step 3: Install dependencies

```bash
npm install
```

Expected: the command exits with code 0. Dependencies are `@modelcontextprotocol/sdk` and `zod`. Development dependencies are `typescript` and `@types/node`.

### Step 4: Build

```bash
npm run build
```

Expected: the command exits with code 0 and creates `dist/index.js`. Verify the file exists before continuing.

### Step 5: Run the tests

```bash
npm test
```

Expected output includes `# pass 4` and `# fail 0`. The tests do not contact MantisBT, so they pass without credentials. If any test fails, stop and report the failing test name and its output.

### Step 6: Create the configuration file

Copy the template:

```bash
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env`.

Then ask the user for two values. Do not invent them:

| Variable | What to ask the user for |
|----------|--------------------------|
| `MANTIS_BASE_URL` | The MantisBT site URL, for example `https://mantis.example.com`. |
| `MANTIS_API_TOKEN` | An API token created in MantisBT under the user's account settings. |

Edit `.env` and replace the two placeholder values. Leave the other variables at their defaults unless the user asks for a change. Never print the token in chat output, and never commit `.env`.

### Step 7: Register the server in the MCP client

Use the client's own MCP configuration. The entry must start the compiled server with Node.js. Use an absolute path to `dist/index.js`:

```json
{
  "mcpServers": {
    "mantisbt": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/dist/index.js"],
      "env": {
        "MANTIS_BASE_URL": "<value from .env>",
        "MANTIS_API_TOKEN": "<value from .env>"
      }
    }
  }
}
```

Replace `<absolute-path-to-repo>` with the full path to the repository on this machine. Replace the two `<value from .env>` placeholders with the actual values. Where the client accepts it, the `env` block can be omitted if the server reads `.env` from the repository root (not from the working directory). The server does this automatically.

Where the config file lives depends on the client. Look up the client's documentation for MCP server configuration instead of guessing a path. Save the change, then restart or reload the client so it starts the server.

### Step 8: Verify the connection

From the MCP client, call the tool `check_mantis_connection` with no arguments.

Expected: the result reports a successful connection and the authenticated user. If the result has `isError: true`, use the troubleshooting table below. Report the error text to the user.

Then call `get_current_user`. Expected: the profile of the token's user. This confirms the token works for user-specific endpoints.

### Step 9 (optional): Build the vector index

Only do this if the user wants semantic search or efficiency analytics:

1. Call `sync_issues_to_vector_store` with `max_pages: 2` to test on a small set.
2. If that succeeds, the index can be grown with larger `max_pages` values.

The index is written to `.mantis-vector-store.json` in the repository directory, or to the path in `MANTIS_VECTOR_DB_PATH`.

### Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| `npm install` fails | Node.js and npm versions, network access | Upgrade Node.js to 18 or later. Retry. |
| `npm run build` fails | Output of `tsc` | Report the TypeScript error. Do not edit source files to make it pass without the user's approval. |
| `Set MANTIS_BASE_URL and MANTIS_API_TOKEN ...` | `.env` exists and has real values; client `env` block | Fix the values in `.env` or the client `env` block. |
| `HTTP 401` | Token value | Ask the user to create a new token in MantisBT and update it. |
| `HTTP 404` on every call | `MANTIS_BASE_URL` value | The server already tries `/api/rest` and then `/api/rest/index.php`. Confirm the site URL is correct and that the REST API is enabled. |
| Client shows no tools | Path in client config is absolute and correct; client was restarted | Fix the path, then restart the client. |
| `node: command not found` in the client | `node` is not on the client's PATH | Put the full path to the `node` executable in `command`. |

### Installation checklist

- [ ] Node.js 18 or later is installed
- [ ] `npm install` exits with code 0
- [ ] `npm run build` exits with code 0 and `dist/index.js` exists
- [ ] `npm test` reports 4 passing tests
- [ ] `.env` exists with real `MANTIS_BASE_URL` and `MANTIS_API_TOKEN`
- [ ] The MCP client config points to the absolute path of `dist/index.js`
- [ ] The client was restarted
- [ ] `check_mantis_connection` succeeds

## Tools at a Glance

| Group | Tools |
|-------|-------|
| Context for LLMs | `get_my_unresolved_assigned_context` |
| Vector store and analytics | `sync_issues_to_vector_store`, `search_vector_issues`, `analyze_project_efficiency` |
| Issues | `get_issue_full_context`, `list_issues`, `create_issue`, `update_issue`, `delete_issue` |
| Notes and time tracking | `add_issue_note`, `delete_issue_note` |
| Relationships, tags, attachments, monitoring | `add_issue_relationship`, `delete_issue_relationship`, `get_issue_attachment`, `add_issue_attachment`, `attach_issue_tags`, `detach_issue_tag`, `monitor_issue` |
| Projects, versions, filters, users, settings | `check_mantis_connection`, `list_projects`, `get_project`, `create_project_version`, `list_filters`, `get_current_user`, `get_mantis_config` |

Parameters and examples for every tool are in [docs/TOOLS.md](docs/TOOLS.md).

## Tutorial for LLMs

This section is written for the AI assistant that calls these tools. Follow it to pick the right tool, call it with valid arguments, and report results accurately.

### 1. Ground rules

- **Check the connection first** when a call fails or when you are unsure the server is configured. Call `check_mantis_connection`. If it returns an error, report the error text to the user. Do not guess a fix.
- **Use IDs, not names, in write calls.** `issue_id`, `project_id`, `handler_id`, and `user_id` are integers. Look them up with `list_projects`, `get_current_user`, or `list_issues` first.
- **Prefer the narrowest tool.** Use `get_issue_full_context` for one issue, not `list_issues` followed by many reads.
- **Keep payloads small.** Download attachments only when the content is needed, with `get_issue_attachment`.
- **Treat errors as data.** A result with `isError: true` contains `{"error": "..."}`. Quote the message to the user and stop that branch. Do not retry the same call unchanged.
- **Confirm before destructive actions.** `delete_issue` and `delete_issue_note` cannot be undone. Ask the user first unless they clearly asked for the deletion.

### 2. Choose a tool by intent

| The user asks for... | Call |
|----------------------|------|
| "What do I have to work on?" | `get_my_unresolved_assigned_context` |
| "What's going on with issue #42?" | `get_issue_full_context` |
| "Show open bugs in project 3" | `list_issues` with `project_id` and `only_unresolved` |
| "Have we seen this problem before?" | `sync_issues_to_vector_store`, then `search_vector_issues` |
| "How healthy is project 3?" | `analyze_project_efficiency` |
| "Open a bug for X" | `create_issue` |
| "Mark #42 as in progress for Ana" | `update_issue` |
| "Log 1h30 on #42" | `add_issue_note` with `time_tracking_duration` |
| "Is #42 a duplicate of #17?" | `add_issue_relationship` with `relationship_type: "duplicate-of"` |

### 3. Workflows

**A. Daily triage of my work**

1. Call `get_my_unresolved_assigned_context`. Use the executive summary for an overview.
2. For the top items, call `get_issue_full_context` with each `issue_id` to read the description and notes.
3. Report the list grouped by priority. Do not invent details missing from the result.

```json
{ "name": "get_my_unresolved_assigned_context", "arguments": { "project_id": 3, "max_pages": 5 } }
```

**B. Investigate a bug**

1. `get_issue_full_context` with `issue_id`.
2. `search_vector_issues` with `query` set to the issue summary, and `only_unresolved: false` to find past solutions. Results need a prior `sync_issues_to_vector_store`. If the store is empty, the result contains an explanatory message.
3. Report the closest matches with their `id` and similarity score. Say that the match is semantic, not proof of a duplicate.

```json
{ "name": "search_vector_issues", "arguments": { "query": "timeout in PIX payment webhook", "top_k": 5, "min_similarity": 0.1 } }
```

**C. Build the vector index**

1. `sync_issues_to_vector_store` with `project_id` and `max_pages`. Start small (`max_pages: 2`) to check the result.
2. Report what the result says about the sync. Re-run after large changes in MantisBT.

```json
{ "name": "sync_issues_to_vector_store", "arguments": { "project_id": 3, "max_pages": 5 } }
```

**D. Project efficiency review**

1. `analyze_project_efficiency` with `project_id`. Leave `auto_sync` at `true` unless the user says not to sync.
2. Report the Efficiency Score, the throughput and lead time figures, and the `diagnostics` list in that order.
3. Use `top_stale_unresolved_issues` and `assignee_efficiency` to suggest concrete next steps. Do not change any issue without the user's approval.

```json
{ "name": "analyze_project_efficiency", "arguments": { "project_id": 3, "stale_threshold_hours": 168 } }
```

**E. Create and update an issue**

1. Confirm the `project_id` and `category_name` with `list_projects`, which returns categories.
2. `create_issue` with a clear `summary` and a full `description`. Include `steps_to_reproduce` when the user provides them.
3. Use the returned `id` in later calls. Use `update_issue` only for fields the user asked to change.

```json
{ "name": "create_issue", "arguments": { "project_id": 3, "category_name": "Bug", "summary": "Checkout fails with 504 on PIX QR code", "description": "Observed on staging after the last deploy.", "priority_name": "high" } }
```

**F. Log work and comment**

1. `add_issue_note` with `text`, `view_state` (`public` unless the user says private), and `time_tracking_duration` in `HH:MM` format when the user gives hours.
2. Report the result to the user and quote any ID it returns.

```json
{ "name": "add_issue_note", "arguments": { "issue_id": 42, "text": "Root cause found in the connection pool.", "view_state": "public", "time_tracking_duration": "01:30" } }
```

**G. Read an attachment**

1. `get_issue_full_context` lists attachment metadata (`id`, `filename`, `size_bytes`, `content_type`).
2. Call `get_issue_attachment` with `issue_id` and `attachment_id` only if the content is needed. Do not download binary files just to describe them.

### 4. Reporting results

- Lead with the answer, then the supporting figures.
- Quote issue IDs and summaries exactly as returned.
- Mark anything inferred, such as a semantic match or a suggested next step, as an inference.
- If a call fails, say which tool failed, the error message, and what the user can check (URL, token, permissions, IDs).

### 5. Common errors

| Error text contains | Likely cause | What to tell the user |
|---------------------|--------------|-----------------------|
| `Set MANTIS_BASE_URL and MANTIS_API_TOKEN` | Configuration missing | Add both variables to the MCP client `env` block or the server `.env`. |
| `HTTP 401` | Token invalid or expired | Create a new API token in MantisBT. |
| `HTTP 403` | Account lacks permission | The token's account cannot perform this action. |
| `HTTP 404` | Wrong ID, or REST path issue | Verify the ID with `list_issues` or `list_projects`. Run `check_mantis_connection`. |
| `Issue #N not found.` | ID does not exist | Ask the user to confirm the ID. |
| "No issues found in the vector store" | Index is empty | Run `sync_issues_to_vector_store` first. |

## Configuration

| Variable | Required | Default |
|----------|----------|---------|
| `MANTIS_BASE_URL` | Yes | none |
| `MANTIS_API_TOKEN` | Yes | none |
| `MANTIS_RESOLVED_THRESHOLD` | No | `80` |
| `MANTIS_VECTOR_DB_PATH` | No | `.mantis-vector-store.json` |
| `MANTIS_EMBEDDING_API_URL` | No | local embedder |
| `MANTIS_EMBEDDING_API_KEY` | No | none |
| `MANTIS_EMBEDDING_MODEL` | No | `text-embedding-3-small` |
| `MANTIS_ALLOW_EXTERNAL_EMBEDDINGS` | No | `false` (external embeddings need this opt-in) |
| `MANTIS_ALLOW_DELETE` | No | `false` (all DELETE calls blocked) |
| `MANTIS_ALLOW_HTTP` | No | `false` (non-https URLs rejected, except localhost) |
| `MANTIS_READ_ONLY` | No | `false` (set `true` to block all write calls: POST, PATCH, PUT, DELETE) |

Resolution order, security notes, and examples are in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Project Structure

```
Mantis-MCP/
├── src/
│   ├── index.ts          # Entry point, configuration, MantisBT HTTP client, tool registration
│   ├── vectorStore.ts    # Embeddings, issue metrics, persistence, search, efficiency analytics
│   └── test.ts           # Integration tests (node:test) with a stubbed MantisBT API
├── docs/
│   ├── ARCHITECTURE.md   # Modules, request lifecycle, vector store internals, design decisions
│   ├── TOOLS.md          # Reference for all 25 tools
│   ├── CONFIGURATION.md  # Environment variables, resolution order, client setup
│   ├── TESTING.md        # Test strategy, cases, and how to add tests
│   └── designs/          # Design records for the MCP server and the analytics feature
├── .env.example          # Configuration template
├── package.json
└── tsconfig.json
```

Generated files (`dist/`, `.env`, `.mantis-vector-store.json`) are git-ignored.

## Documentation

| Document | Contents |
|----------|----------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the server is built and why |
| [TOOLS.md](docs/TOOLS.md) | Tool-by-tool parameter reference |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Setup and environment variables |
| [TESTING.md](docs/TESTING.md) | Running and extending the test suite |
| [designs/mantisbt-mcp.md](docs/designs/mantisbt-mcp.md) | Design specification for the MCP server |
| [designs/vector-efficiency-analytics.md](docs/designs/vector-efficiency-analytics.md) | Design specification for the vector store and analytics |

## Development

```bash
npm run dev     # TypeScript in watch mode
npm run build   # Compile src/ to dist/
npm start       # Run the compiled server
npm test        # Run the test suite
```

## Limitations

- The vector store is a single JSON file loaded into memory. It suits thousands of issues, not millions.
- The default embedder captures shared words and character patterns, not meaning. Use an external embedding endpoint if you need synonym-level matching.
- Changing the embedding mode requires re-running `sync_issues_to_vector_store`.
- The server exposes the MantisBT API as the authenticated user. Its permissions are the permissions of the token.

## Security

- **Issue content is untrusted.** Anyone who can file or comment on an issue can plant instructions that your AI client may follow (prompt injection). Require human approval for write tools (`update_issue`, `add_issue_note`, `add_issue_attachment`, `create_issue`).
- **Deletes are off by default.** `delete_issue`, `delete_issue_note`, `delete_issue_relationship`, and tag removal fail unless `MANTIS_ALLOW_DELETE=true`.
- **Read-only mode.** Set `MANTIS_READ_ONLY=true` to reject every write call; this is the strongest mitigation against prompt injection through issue text.
- **Use a least-privilege token**, ideally a dedicated read-only account.
- **Vector store is plaintext.** `.mantis-vector-store.json` holds issue content unencrypted; it is written with mode `0600` on POSIX and with an `icacls` ACL restricted to the current user on Windows (best effort). It is not encrypted.
- **https is required** for `MANTIS_BASE_URL` and `MANTIS_EMBEDDING_API_URL` (localhost excepted); redirects are not followed.
- **Embedding API is opt-in.** When configured, issue text leaves your machine.
- **The vector store holds issue text.** It is written with owner-only permissions and git-ignored; keep it out of shared folders.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Disclaimer

This is an unofficial, community project. It is not affiliated with or endorsed by MantisBT or its maintainers.

## License

[MIT](LICENSE). You may use, copy, and modify this project freely, including commercially, as long as the license notice is kept.

## Citation

If you use this project, please credit it with a link to the repository: <https://github.com/coelho-coie/mantisbt-mcp-Unofficial>. This is a request, not a license requirement; the license stays MIT.
