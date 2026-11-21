# Testing

The test suite uses Node.js's built-in test runner (`node:test`). It needs no test framework dependency.

## Running Tests

```bash
npm run build   # tests run against the compiled output in dist/
npm test        # node --test dist/test.js
```

Expected result: 4 tests, all passing.

## Test Strategy

Tests exercise the server through its public surface rather than through internal helpers alone:

- MantisBT HTTP calls are replaced with a stub of the global `fetch`. No network access and no real MantisBT instance are needed.
- The MCP server is created in memory and tools are invoked through the MCP protocol, so schema validation and result shaping are covered.
- Vector store tests write to a temporary file path (`MANTIS_VECTOR_DB_PATH`), so the real `.mantis-vector-store.json` is never touched.

## Test Cases

| # | Test | Covers |
|---|------|--------|
| 1 | `normalizeIssueForLLM` normalizes issue fields and strips binary payload bloat | Data normalization and attachment handling |
| 2 | MCP server registers all 25 tools and `get_my_unresolved_assigned_context` aggregates unresolved assigned issues | Tool registration, collection logic, status and handler filtering |
| 3 | `normalizeMantisUrls` and automatic `/api/rest/index.php` fallback handle servers without mod_rewrite | URL normalization and the 404 fallback |
| 4 | Vector store sync, semantic search, and project efficiency analytics work end-to-end via MCP tools | Persistence, embeddings, similarity search, and the efficiency report |

Test 2 also acts as a guard on the tool count. If a tool is added or removed, update the expected count and the [Tool Reference](TOOLS.md).

## Type Checking

`npm run build` runs `tsc` with the project's `tsconfig.json`. A clean build is a precondition for the tests, which execute `dist/`.

## Adding Tests

- Put new tests in `src/test.ts`, using `node:test` (`test(...)`) and `node:assert/strict`.
- Give each test a descriptive name that states the behavior under test, for example `returns empty array when no issues match the filter`.
- Stub `fetch` for any new MantisBT endpoint, and restore it after the test.
- Use a temporary vector store path for any test that writes to disk.

## Manual Verification

For a live check against a real MantisBT instance, call `check_mantis_connection` from the MCP client. It validates the URL, the token, and the REST API path, and reports whether the `index.php` fallback was used.
