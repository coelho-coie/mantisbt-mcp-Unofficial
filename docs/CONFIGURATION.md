# Configuration

The server is configured through environment variables. Values can come from the MCP client's `env` block, from the shell, or from a `.env` file.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MANTIS_BASE_URL` | Yes | none | MantisBT base URL. Accepts the site root, `/api/rest`, or `/api/rest/index.php`. See [ARCHITECTURE.md](ARCHITECTURE.md#mantisbt-url-normalization). |
| `MANTIS_API_TOKEN` | Yes | none | MantisBT API token, sent as the `Authorization` header. Create one in your MantisBT account settings. |
| `MANTIS_RESOLVED_THRESHOLD` | No | `80` | Status ID at or above which an issue counts as resolved. MantisBT uses `80` for *resolved* and `90` for *closed*. |
| `MANTIS_VECTOR_DB_PATH` | No | `.mantis-vector-store.json` in the working directory | File path of the local vector store. |
| `MANTIS_EMBEDDING_API_URL` | No | unset | OpenAI-compatible `/embeddings` endpoint. When unset, the local 256-dimension embedder is used. |
| `MANTIS_EMBEDDING_API_KEY` | No | unset | API key for the embedding endpoint. |
| `MANTIS_EMBEDDING_MODEL` | No | `text-embedding-3-small` | Model name sent to the embedding endpoint. |
| `MANTIS_ALLOW_DELETE` | No | `false` | Set to `true` to allow DELETE calls (delete issue, note, relationship, tag removal). |
| `MANTIS_ALLOW_HTTP` | No | `false` | Set to `true` to allow a non-https `MANTIS_BASE_URL` on a non-localhost host. The token is then sent in clear text. |

## Resolution Order

For each variable, the server uses the first value found in this order:

1. `process.env`, if the value is non-empty and is not an unexpanded placeholder such as `${MANTIS_API_TOKEN}`.
2. A `.env` file in the project root (the parent of `dist/`), then one in the current working directory.
3. The default from the table above.

Placeholder detection matters because some MCP clients pass `${VAR}` literally when the variable is not set in their environment. The server then falls back to `.env` instead of using the placeholder as a value.

## Example `.env`

```dotenv
MANTIS_BASE_URL=https://mantis.example.com
MANTIS_API_TOKEN=your_token_here
MANTIS_RESOLVED_THRESHOLD=80
MANTIS_VECTOR_DB_PATH=.mantis-vector-store.json

# Optional: dense embeddings instead of the local hashing embedder
# MANTIS_EMBEDDING_API_URL=https://api.openai.com/v1/embeddings
# MANTIS_EMBEDDING_API_KEY=sk-...
# MANTIS_EMBEDDING_MODEL=text-embedding-3-small
```

A template is provided in `.env.example`. Never commit `.env`. It is listed in `.gitignore`.

## MCP Client Configuration

Pass the variables through the client's `env` block so they do not depend on the working directory:

```json
{
  "mcpServers": {
    "mantisbt": {
      "command": "node",
      "args": ["C:/path/to/Mantis-MCP/dist/index.js"],
      "env": {
        "MANTIS_BASE_URL": "https://mantis.example.com",
        "MANTIS_API_TOKEN": "your_token_here",
        "MANTIS_VECTOR_DB_PATH": "C:/path/to/Mantis-MCP/.mantis-vector-store.json"
      }
    }
  }
}
```

## Files Created at Runtime

| File | Created by | Git-ignored | Contains |
|------|-----------|-------------|----------|
| `.mantis-vector-store.json` | `sync_issues_to_vector_store` | Yes | Issue titles, descriptions, and vectors. Treat as confidential. |
| `dist/` | `npm run build` | Yes | Compiled JavaScript. |

## Security Notes

- The API token grants whatever access the MantisBT account has. Use a dedicated account with the minimum permissions needed.
- With `MANTIS_EMBEDDING_API_URL` set, issue text is sent to that endpoint. Use it only if the provider is approved for your data.
- Error messages include the first 300 characters of the MantisBT response body. Do not expose the server's stderr to untrusted users.
- Issue text is untrusted input to your AI client. Require human approval for write tools and keep `MANTIS_ALLOW_DELETE` off unless needed.
- `MANTIS_EMBEDDING_API_URL` must be https (localhost excepted). Redirects are rejected and requests time out after 15 seconds.
- Configuration is read from the process environment, then `.env` next to the package, then `.env` in the working directory. Run the server from a trusted directory.
