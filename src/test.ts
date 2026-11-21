import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { computeEmbedding } from "./vectorStore.js";
import { createMantisMcpServer, mantisRequest, normalizeIssueForLLM, normalizeMantisUrls } from "./index.js";

test("normalizeIssueForLLM normalizes issue fields and strips binary payload bloat", () => {
  process.env.MANTIS_BASE_URL = "https://mantis.example.com";
  const normalized = normalizeIssueForLLM({
    id: 42,
    summary: "Corrigir timeout na API",
    description: "Timeout after 30s",
    project: { id: 1, name: "Core" },
    status: { id: 50, name: "assigned", label: "assigned" },
    priority: { id: 40, name: "high", label: "alta" },
    severity: { id: 60, name: "major", label: "maior" },
    handler: { id: 7, name: "alice", real_name: "alice" },
    attachments: [
      { id: 9, filename: "trace.log", size: 2048, content_type: "text/plain", created_at: "2026-11-09T00:00:00Z" },
    ],
    notes: [
      { id: 100, reporter: { id: 7, name: "alice" }, text: "Investigating root cause" },
    ],
  });

  assert.equal(normalized.id, 42);
  assert.equal(normalized.url, "https://mantis.example.com/view.php?id=42");
  assert.equal(normalized.assigned_to?.id, 7);
  assert.equal(normalized.attachments.length, 1);
  assert.equal(normalized.attachments[0]?.filename, "trace.log");
  assert.equal(normalized.notes[0]?.text, "Investigating root cause");
});

test("MCP server registers all 25 tools and get_my_unresolved_assigned_context aggregates unresolved assigned issues", async () => {
  process.env.MANTIS_BASE_URL = "https://mantis.example.com";
  process.env.MANTIS_API_TOKEN = "test-token";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/rest/users/me")) {
      return new Response(JSON.stringify({ id: 7, name: "alice", real_name: "alice", email: "alice@example.com" }), {
        status: 200,
      });
    }
    if (url.includes("/api/rest/issues")) {
      return new Response(
        JSON.stringify({
          issues: [
            {
              id: 101,
              summary: "Open assigned issue",
              project: { id: 1, name: "Backend" },
              handler: { id: 7, name: "alice" },
              status: { id: 50, name: "assigned", label: "assigned" },
              priority: { id: 50, name: "urgent", label: "urgent" },
              severity: { id: 60, name: "major", label: "major" },
              description: "Details of issue 101",
            },
            {
              id: 102,
              summary: "Already resolved issue (must be filtered)",
              project: { id: 1, name: "Backend" },
              handler: { id: 7, name: "alice" },
              status: { id: 80, name: "resolved", label: "resolved" },
            },
            {
              id: 103,
              summary: "Issue of another user (must be filtered)",
              project: { id: 1, name: "Backend" },
              handler: { id: 99, name: "outro" },
              status: { id: 50, name: "assigned", label: "assigned" },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const server = createMantisMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const toolsList = await client.listTools();
    assert.equal(toolsList.tools.length, 25);
    assert.ok(toolsList.tools.some((t) => t.name === "get_my_unresolved_assigned_context"));
    assert.ok(toolsList.tools.some((t) => t.name === "check_mantis_connection"));
    assert.ok(toolsList.tools.some((t) => t.name === "sync_issues_to_vector_store"));
    assert.ok(toolsList.tools.some((t) => t.name === "search_vector_issues"));
    assert.ok(toolsList.tools.some((t) => t.name === "analyze_project_efficiency"));

    const result = await client.callTool({
      name: "get_my_unresolved_assigned_context",
      arguments: { max_pages: 1 },
    });

    const content = (result.content as Array<{ type: string; text: string }>)[0];
    assert.ok(content);
    const parsed = JSON.parse(content.text);
    assert.equal(parsed.summary_metrics.total_unresolved_assigned, 1);
    assert.equal(parsed.issues[0].id, 101);
    assert.equal(parsed.issues[0].summary, "Open assigned issue");

    await client.close();
    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeMantisUrls and automatic /api/rest/index.php fallback handle servers without mod_rewrite", async () => {
  assert.deepEqual(normalizeMantisUrls("http://203.0.113.10/api/rest/index.php"), {
    webRootUrl: "http://203.0.113.10",
    apiRootUrl: "http://203.0.113.10/api/rest/index.php",
  });

  process.env.MANTIS_ALLOW_HTTP = "true"; // plain-http host is only a fixture
  process.env.MANTIS_BASE_URL = "http://mantis-no-rewrite.example.com/";
  process.env.MANTIS_API_TOKEN = "test-token";

  const requestedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const u = String(input);
    requestedUrls.push(u);
    if (u === "http://mantis-no-rewrite.example.com/api/rest/users/me") {
      return new Response("Not Found", { status: 404 });
    }
    if (u === "http://mantis-no-rewrite.example.com/api/rest/index.php/users/me") {
      return new Response(
        JSON.stringify({ id: 25, name: "Alice Example", real_name: "Alice Example", projects: [{ id: 1, name: "Demo" }] }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const server = createMantisMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: "check_mantis_connection", arguments: {} });
    const payload = JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text);
    assert.equal(payload.connected, true);
    assert.equal(payload.api_root_url, "http://mantis-no-rewrite.example.com/api/rest/index.php");
    assert.equal(payload.authenticated_user.id, 25);
    assert.equal(requestedUrls.length, 2);

    await client.close();
    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Vector store sync, semantic search, and project efficiency analytics work end-to-end via MCP tools", async () => {
  const tmpStorePath = path.join(os.tmpdir(), `mantis-vector-test-${Date.now()}.json`);
  process.env.MANTIS_BASE_URL = "https://mantis.example.com";
  process.env.MANTIS_API_TOKEN = "test-token";
  process.env.MANTIS_VECTOR_DB_PATH = tmpStorePath;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/rest/issues")) {
      return new Response(
        JSON.stringify({
          issues: [
            {
              id: 201,
              summary: "Timeout in the PIX payment gateway when validating QRCode",
              description: "Connection expires after 30s in the PIX payment integration at checkout.",
              project: { id: 10, name: "Pagamentos" },
              category: { id: 1, name: "PIX" },
              handler: { id: 7, name: "alice", real_name: "alice" },
              status: { id: 50, name: "assigned", label: "assigned" },
              priority: { id: 50, name: "urgent", label: "urgent" },
              severity: { id: 70, name: "crash", label: "crash" },
              created_at: "2026-10-20T10:00:00Z",
              updated_at: "2026-10-22T10:00:00Z",
              notes: [{ id: 1, text: "Error 504 on the PIX QRCode endpoint", time_tracking: { duration: "02:30" } }],
              history: [
                { field: { name: "handler_id" }, old_value: 3, new_value: 7 },
                { field: { name: "status" }, old_value: 80, new_value: 50, created_at: "2026-10-21T12:00:00Z" },
              ],
            },
            {
              id: 202,
              summary: "Timeout failure in the PIX QRCode payment webhook",
              description: "Slowness and 30s timeout when confirming PIX payment at checkout.",
              project: { id: 10, name: "Pagamentos" },
              category: { id: 1, name: "PIX" },
              handler: { id: 7, name: "alice", real_name: "alice" },
              status: { id: 80, name: "resolved", label: "resolved" },
              priority: { id: 40, name: "high", label: "high" },
              severity: { id: 60, name: "major", label: "major" },
              created_at: "2026-11-01T10:00:00Z",
              updated_at: "2026-11-02T10:00:00Z",
              notes: [{ id: 2, text: "Adjusted PIX connection pool", time_tracking: { duration: "01:30" } }],
              history: [
                { field: { name: "status" }, old_value: 50, new_value: 80, created_at: "2026-11-02T10:00:00Z" },
              ],
            },
            {
              id: 203,
              summary: "CSS alignment error in the admin panel footer",
              description: "Button misaligned on mobile screens.",
              project: { id: 10, name: "Pagamentos" },
              category: { id: 2, name: "Frontend" },
              handler: { id: 12, name: "ana", real_name: "Ana" },
              status: { id: 80, name: "resolved", label: "resolved" },
              priority: { id: 20, name: "low", label: "low" },
              severity: { id: 20, name: "trivial", label: "trivial" },
              created_at: "2026-11-05T08:00:00Z",
              updated_at: "2026-11-05T14:00:00Z",
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const server = createMantisMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // 1. Sync issues to vector store
    const syncRes = await client.callTool({
      name: "sync_issues_to_vector_store",
      arguments: { max_pages: 1 },
    });
    const syncPayload = JSON.parse((syncRes.content as Array<{ type: string; text: string }>)[0]!.text);
    assert.equal(syncPayload.indexed_count, 3);
    assert.equal(syncPayload.total_in_store, 3);

    // 2. Semantic search for PIX timeout
    const searchRes = await client.callTool({
      name: "search_vector_issues",
      arguments: { query: "timeout pagamento PIX QRCode", top_k: 2 },
    });
    const searchPayload = JSON.parse((searchRes.content as Array<{ type: string; text: string }>)[0]!.text);
    assert.equal(searchPayload.results.length, 2);
    const topIds = searchPayload.results.map((r: { id: number }) => r.id);
    assert.ok(topIds.includes(201) && topIds.includes(202));

    // 3. Analyze project efficiency
    const effRes = await client.callTool({
      name: "analyze_project_efficiency",
      arguments: { auto_sync: false, cluster_similarity_threshold: 0.35 },
    });
    const effPayload = JSON.parse((effRes.content as Array<{ type: string; text: string }>)[0]!.text);
    assert.equal(effPayload.total_issues_analyzed, 3);
    assert.equal(effPayload.throughput_and_lead_time.resolved_count, 2);
    assert.equal(effPayload.throughput_and_lead_time.unresolved_count, 1);
    assert.equal(effPayload.throughput_and_lead_time.total_time_tracked_hours, 4);
    assert.equal(effPayload.friction_and_quality.reopened_issues_count, 1);
    assert.equal(effPayload.friction_and_quality.total_reassignments, 1);
    assert.ok(effPayload.recurring_semantic_clusters.length >= 1);
    assert.deepEqual(effPayload.recurring_semantic_clusters[0].issue_ids.sort(), [201, 202]);
    assert.equal(typeof effPayload.efficiency_score, "number");

    await client.close();
    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tmpStorePath, { force: true }).catch(() => {});
  }
});

test("computeEmbedding stays local unless MANTIS_ALLOW_EXTERNAL_EMBEDDINGS=true", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
  };
  try {
    process.env.MANTIS_EMBEDDING_API_URL = "https://embed.example.com/v1/embeddings";
    process.env.MANTIS_EMBEDDING_API_KEY = "k";
    delete process.env.MANTIS_ALLOW_EXTERNAL_EMBEDDINGS;
    const local = await computeEmbedding("timeout na API");
    assert.match(local.mode, /^local-/);
    assert.equal(fetchCalls, 0);
    process.env.MANTIS_ALLOW_EXTERNAL_EMBEDDINGS = "true";
    const remote = await computeEmbedding("timeout na API");
    assert.match(remote.mode, /^api:/);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = saved;
  }
});

test("mantisRequest blocks every non-GET call when MANTIS_READ_ONLY=true", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  };
  try {
    process.env.MANTIS_BASE_URL = "https://mantis.example.com";
    process.env.MANTIS_API_TOKEN = "test-token";
    process.env.MANTIS_ALLOW_DELETE = "true";
    process.env.MANTIS_READ_ONLY = "true";
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      await assert.rejects(mantisRequest("/issues/1", { method }), /MANTIS_READ_ONLY/);
    }
    assert.equal(fetchCalls, 0);
    await mantisRequest("/issues/1");
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = saved;
  }
});

test("mantisRequest blocks DELETE by default and rejects plain-http hosts", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  };
  try {
    process.env.MANTIS_BASE_URL = "https://mantis.example.com";
    process.env.MANTIS_API_TOKEN = "test-token";
    delete process.env.MANTIS_ALLOW_DELETE;
    await assert.rejects(mantisRequest("/issues/1", { method: "DELETE" }), /DELETE calls are disabled/);

    delete process.env.MANTIS_ALLOW_HTTP;
    process.env.MANTIS_BASE_URL = "http://mantis.example.com";
    await assert.rejects(mantisRequest("/users/me"), /must use https/);
    assert.equal(fetchCalls, 0);

    process.env.MANTIS_ALLOW_DELETE = "true";
    process.env.MANTIS_BASE_URL = "https://mantis.example.com";
    await mantisRequest("/issues/1", { method: "DELETE" });
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = saved;
  }
});