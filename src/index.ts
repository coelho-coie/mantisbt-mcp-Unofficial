#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MantisVectorStore } from "./vectorStore.js";

const indexPhpFallbackRoots = new Set<string>();
const MAX_ERROR_BODY_CHARS = 300;
let dotEnvCache: Record<string, string> | null = null;

function readDotEnvFallback(): Record<string, string> {
  if (dotEnvCache) return dotEnvCache;
  dotEnvCache = {};
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Only the package root: a .env in process.cwd() could be planted to redirect the base URL/token.
    path.resolve(moduleDir, "..", ".env"),
  ];
  for (const envPath of candidates) {
    try {
      if (!fsSync.existsSync(envPath)) continue;
      const content = fsSync.readFileSync(envPath, "utf-8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key && val && !(key in dotEnvCache)) {
          dotEnvCache[key] = val;
        }
      }
    } catch {
      // Ignore unreadable .env files
    }
  }
  return dotEnvCache;
}

function resolveEnvVar(name: string, defaultVal = ""): string {
  const raw = (process.env[name] || "").trim();
  if (raw && !/^\$\{[^}]+\}$/.test(raw)) {
    return raw;
  }
  const fallback = readDotEnvFallback()[name];
  return fallback !== undefined ? fallback : defaultVal;
}

export function normalizeMantisUrls(rawBaseUrl: string): { webRootUrl: string; apiRootUrl: string } {
  const cleaned = rawBaseUrl.trim().replace(/\/+$/, "");
  if (!cleaned) {
    return { webRootUrl: "", apiRootUrl: "" };
  }

  const webRootUrl = cleaned.replace(/\/api\/rest(?:\/index\.php)?$/i, "");

  let apiRootUrl: string;
  if (/\/api\/rest\/index\.php$/i.test(cleaned)) {
    apiRootUrl = cleaned;
  } else if (/\/api\/rest$/i.test(cleaned)) {
    apiRootUrl = indexPhpFallbackRoots.has(webRootUrl) ? `${cleaned}/index.php` : cleaned;
  } else {
    apiRootUrl = indexPhpFallbackRoots.has(webRootUrl)
      ? `${webRootUrl}/api/rest/index.php`
      : `${webRootUrl}/api/rest`;
  }

  return { webRootUrl, apiRootUrl };
}

export function getMantisEnv() {
  const rawBaseUrl = resolveEnvVar("MANTIS_BASE_URL", "");
  const { webRootUrl, apiRootUrl } = normalizeMantisUrls(rawBaseUrl);
  const apiToken = resolveEnvVar("MANTIS_API_TOKEN", "");
  const resolvedThreshold = Number(resolveEnvVar("MANTIS_RESOLVED_THRESHOLD", "80") || "80");
  return { baseUrl: webRootUrl, webRootUrl, apiRootUrl, apiToken, resolvedThreshold };
}

export interface MantisEntityRef {
  id: number;
  name?: string;
  label?: string;
  real_name?: string;
  email?: string;
}

export interface MantisIssue {
  id: number;
  summary: string;
  description?: string;
  steps_to_reproduce?: string;
  additional_information?: string;
  project?: MantisEntityRef;
  category?: MantisEntityRef;
  version?: MantisEntityRef;
  fixed_in_version?: MantisEntityRef;
  target_version?: MantisEntityRef;
  reporter?: MantisEntityRef;
  handler?: MantisEntityRef;
  status?: MantisEntityRef;
  resolution?: MantisEntityRef;
  priority?: MantisEntityRef;
  severity?: MantisEntityRef;
  reproducibility?: MantisEntityRef;
  view_state?: MantisEntityRef;
  sticky?: boolean;
  created_at?: string;
  updated_at?: string;
  due_date?: string;
  tags?: MantisEntityRef[];
  custom_fields?: Array<{ field: MantisEntityRef; value: string }>;
  notes?: Array<{
    id: number;
    reporter?: MantisEntityRef;
    text?: string;
    view_state?: MantisEntityRef;
    time_tracking?: { duration?: string };
    created_at?: string;
    updated_at?: string;
  }>;
  attachments?: Array<{
    id: number;
    filename: string;
    size: number;
    content_type: string;
    created_at?: string;
  }>;
  relationships?: Array<{
    id: number;
    type?: MantisEntityRef;
    issue?: { id: number; summary?: string; status?: MantisEntityRef };
  }>;
  history?: Array<{
    created_at?: string;
    user?: MantisEntityRef;
    field?: { name?: string; label?: string };
    type?: { id?: number; name?: string };
    old_value?: unknown;
    new_value?: unknown;
    message?: string;
  }>;
}

export async function mantisRequest<T = unknown>(
  endpointPath: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  } = {}
): Promise<T> {
  const { webRootUrl, apiRootUrl, apiToken } = getMantisEnv();
  if (!apiRootUrl || !apiToken) {
    throw new Error(
      "Set MANTIS_BASE_URL and MANTIS_API_TOKEN in the MCP environment variables or in the Mantis-MCP server .env file."
    );
  }

  if (process.env.MANTIS_READ_ONLY === "true" && options.method && options.method !== "GET") {
    throw new Error("Write calls are disabled (MANTIS_READ_ONLY=true).");
  }
  if (options.method === "DELETE" && process.env.MANTIS_ALLOW_DELETE !== "true") {
    throw new Error("Destructive DELETE calls are disabled. Set MANTIS_ALLOW_DELETE=true to enable them.");
  }
  const parsedRoot = new URL(apiRootUrl);
  const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(parsedRoot.hostname);
  if (parsedRoot.protocol !== "https:" && !isLocalHost && process.env.MANTIS_ALLOW_HTTP !== "true") {
    throw new Error("MANTIS_BASE_URL must use https (the API token would be sent in clear text). Set MANTIS_ALLOW_HTTP=true to override.");
  }

  const normalizedPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  const buildUrl = (root: string) => {
    const u = new URL(`${root}${normalizedPath}`);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u;
  };

  const requestInit: RequestInit = {
    method: options.method || "GET",
    headers: {
      Authorization: apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    redirect: "error",
  };

  let url = buildUrl(apiRootUrl);
  let res = await fetch(url.toString(), requestInit);

  // Automatic fallback for MantisBT servers without Apache mod_rewrite (/api/rest/index.php)
  if (res.status === 404 && !apiRootUrl.toLowerCase().includes("index.php")) {
    const fallbackRoot = `${apiRootUrl}/index.php`;
    const fallbackUrl = buildUrl(fallbackRoot);
    const fallbackRes = await fetch(fallbackUrl.toString(), requestInit);
    if (fallbackRes.status !== 404) {
      indexPhpFallbackRoots.add(webRootUrl);
      url = fallbackUrl;
      res = fallbackRes;
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`MantisBT HTTP ${res.status} (${res.statusText}) at ${url.pathname}: ${errText.slice(0, MAX_ERROR_BODY_CHARS)}`);
  }

  if (res.status === 204) return {} as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function normalizeIssueForLLM(issue: MantisIssue, includeHistory = true) {
  const { baseUrl } = getMantisEnv();
  return {
    id: issue.id,
    url: baseUrl ? `${baseUrl}/view.php?id=${issue.id}` : `/view.php?id=${issue.id}`,
    summary: issue.summary,
    project: issue.project?.name ?? issue.project?.id,
    category: issue.category?.name,
    status: {
      id: issue.status?.id,
      name: issue.status?.name,
      label: issue.status?.label,
    },
    priority: {
      id: issue.priority?.id,
      name: issue.priority?.name,
      label: issue.priority?.label,
    },
    severity: {
      id: issue.severity?.id,
      name: issue.severity?.name,
      label: issue.severity?.label,
    },
    resolution: issue.resolution?.label ?? issue.resolution?.name,
    reproducibility: issue.reproducibility?.label ?? issue.reproducibility?.name,
    reporter: issue.reporter
      ? { id: issue.reporter.id, name: issue.reporter.name, real_name: issue.reporter.real_name }
      : null,
    assigned_to: issue.handler
      ? { id: issue.handler.id, name: issue.handler.name, real_name: issue.handler.real_name }
      : null,
    versions: {
      product_version: issue.version?.name,
      target_version: issue.target_version?.name,
      fixed_in_version: issue.fixed_in_version?.name,
    },
    dates: {
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      due_date: issue.due_date,
    },
    content: {
      description: issue.description || "",
      steps_to_reproduce: issue.steps_to_reproduce || "",
      additional_information: issue.additional_information || "",
    },
    tags: (issue.tags || []).map((t) => t.name || String(t.id)),
    custom_fields: (issue.custom_fields || []).map((cf) => ({
      field: cf.field?.name || String(cf.field?.id),
      value: cf.value,
    })),
    relationships: (issue.relationships || []).map((rel) => ({
      id: rel.id,
      type: rel.type?.label || rel.type?.name,
      related_issue_id: rel.issue?.id,
      related_issue_summary: rel.issue?.summary,
      related_issue_status: rel.issue?.status?.label || rel.issue?.status?.name,
    })),
    attachments: (issue.attachments || []).map((att) => ({
      id: att.id,
      filename: att.filename,
      size_bytes: att.size,
      content_type: att.content_type,
      created_at: att.created_at,
    })),
    notes: (issue.notes || []).map((n) => ({
      id: n.id,
      author: n.reporter?.real_name || n.reporter?.name || String(n.reporter?.id),
      created_at: n.created_at,
      updated_at: n.updated_at,
      visibility: n.view_state?.name,
      time_tracking: n.time_tracking?.duration,
      text: n.text || "",
    })),
    history: includeHistory
      ? (issue.history || []).map((h) => ({
          at: h.created_at,
          user: h.user?.name,
          field: h.field?.label || h.field?.name || h.type?.name,
          old_value: h.old_value,
          new_value: h.new_value,
          message: h.message,
        }))
      : undefined,
  };
}

function okJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errJson(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
  };
}

export function createMantisMcpServer(): McpServer {
  const server = new McpServer({
    name: "mantisbt-mcp",
    version: "1.0.0",
  });

  // ============================================================================
  // 1. MAIN FUNCTION: FULL COLLECTION OF ASSIGNED AND UNRESOLVED ISSUES
  // ============================================================================
  server.tool(
    "get_my_unresolved_assigned_context",
    "MAIN FUNCTION: Collects everything about all issues assigned to the user (or to a specific user) that are not yet resolved/closed. Returns the full description, steps to reproduce, additional information, complete notes/comments, custom fields, relationships, tags, attachment metadata, change history, and an executive summary grouped by project/priority/status to give the LLM full context.",
    {
      assignee_user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("ID of the assigned user. If omitted, automatically uses the authenticated user (/users/me)."),
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter by a specific project ID. If omitted, searches all projects."),
      filter_id: z
        .string()
        .optional()
        .describe("Saved filter ID in MantisBT or 'assigned' (default tries 'assigned' and falls back to a paginated scan)."),
      resolved_status_threshold: z
        .number()
        .int()
        .optional()
        .describe("Minimum status ID considered resolved in MantisBT (default 80 = resolved, 90 = closed)."),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of pages (50 issues each) to scan during collection."),
      include_history: z
        .boolean()
        .default(true)
        .describe("Include the audit/transition history of each issue."),
      hydrate_individual_issues: z
        .boolean()
        .default(false)
        .describe("If true, performs an individual GET /issues/{id} when the instance listing omits deep fields."),
    },
    async ({
      assignee_user_id,
      project_id,
      filter_id,
      resolved_status_threshold,
      max_pages,
      include_history,
      hydrate_individual_issues,
    }) => {
      try {
        const threshold = resolved_status_threshold ?? getMantisEnv().resolvedThreshold;
        const me = await mantisRequest<{ id: number; name: string; real_name?: string; email?: string }>("/users/me");
        const targetUserId = assignee_user_id ?? me.id;

        const collectedMap = new Map<number, MantisIssue>();

        const fetchPages = async (activeFilterId?: string) => {
          for (let page = 1; page <= max_pages; page++) {
            const resp = await mantisRequest<{ issues?: MantisIssue[] }>("/issues", {
              query: {
                project_id,
                filter_id: activeFilterId,
                page,
                page_size: 50,
              },
            });
            const batch = resp.issues || [];
            if (batch.length === 0) break;

            for (const issue of batch) {
              const handlerId = issue.handler?.id;
              const statusId = issue.status?.id ?? 0;
              if (handlerId === targetUserId && statusId < threshold) {
                collectedMap.set(issue.id, issue);
              }
            }
            if (batch.length < 50) break;
          }
        };

        if (filter_id) {
          await fetchPages(filter_id);
        } else if (targetUserId === me.id) {
          try {
            await fetchPages("assigned");
          } catch {
            // Silent fallback to a general scan when this MantisBT version does not support filter_id=assigned
          }
        }

        if (collectedMap.size === 0 && !filter_id) {
          await fetchPages(undefined);
        }

        let issuesList = Array.from(collectedMap.values());

        if (hydrate_individual_issues && issuesList.length > 0) {
          const hydrated: MantisIssue[] = [];
          for (const item of issuesList) {
            const detail = await mantisRequest<{ issues?: MantisIssue[] }>(`/issues/${item.id}`);
            hydrated.push(detail.issues?.[0] ?? item);
          }
          issuesList = hydrated;
        }

        issuesList.sort((a, b) => {
          const prioDiff = (b.priority?.id ?? 0) - (a.priority?.id ?? 0);
          if (prioDiff !== 0) return prioDiff;
          const sevDiff = (b.severity?.id ?? 0) - (a.severity?.id ?? 0);
          if (sevDiff !== 0) return sevDiff;
          return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
        });

        const byProject: Record<string, number> = {};
        const byPriority: Record<string, number> = {};
        const byStatus: Record<string, number> = {};

        const normalizedIssues = issuesList.map((iss) => {
          const pName = iss.project?.name || String(iss.project?.id || "Sem Projeto");
          const prioName = iss.priority?.label || iss.priority?.name || "normal";
          const stName = iss.status?.label || iss.status?.name || "open";
          byProject[pName] = (byProject[pName] || 0) + 1;
          byPriority[prioName] = (byPriority[prioName] || 0) + 1;
          byStatus[stName] = (byStatus[stName] || 0) + 1;
          return normalizeIssueForLLM(iss, include_history);
        });

        return okJson({
          generated_at: new Date().toISOString(),
          authenticated_user: {
            id: me.id,
            username: me.name,
            real_name: me.real_name,
            email: me.email,
          },
          target_assignee_id: targetUserId,
          resolved_status_threshold: threshold,
          summary_metrics: {
            total_unresolved_assigned: normalizedIssues.length,
            by_project: byProject,
            by_priority: byPriority,
            by_status: byStatus,
          },
          issues: normalizedIssues,
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // ============================================================================
  // 2. ISSUES (FULL CRUD + SEARCH + RELATIONSHIPS + ATTACHMENTS)
  // ============================================================================
  server.tool(
    "get_issue_full_context",
    "Gets all details of a specific issue by ID (description, notes, history, attachments, custom fields and relationships).",
    {
      issue_id: z.number().int().positive().describe("Issue ID in MantisBT."),
      include_history: z.boolean().default(true),
    },
    async ({ issue_id, include_history }) => {
      try {
        const data = await mantisRequest<{ issues?: MantisIssue[] }>(`/issues/${issue_id}`);
        const issue = data.issues?.[0];
        if (!issue) throw new Error(`Issue #${issue_id} not found.`);
        return okJson(normalizeIssueForLLM(issue, include_history));
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "list_issues",
    "Lists and filters MantisBT issues by project, saved filter, assignee (handler), reporter, status or text search.",
    {
      project_id: z.number().int().positive().optional(),
      filter_id: z.string().optional().describe("ID of a saved filter, or 'assigned', 'reported', 'monitored', 'unassigned'."),
      page: z.number().int().min(1).default(1),
      page_size: z.number().int().min(1).max(100).default(50),
      handler_id: z.number().int().positive().optional().describe("In-memory filter by assignee ID."),
      only_unresolved: z.boolean().default(false).describe("If true, returns only issues with status < 80."),
      search_text: z.string().optional().describe("Case-insensitive search in summary, description and notes."),
    },
    async ({ project_id, filter_id, page, page_size, handler_id, only_unresolved, search_text }) => {
      try {
        const threshold = getMantisEnv().resolvedThreshold;
        const data = await mantisRequest<{ issues?: MantisIssue[] }>("/issues", {
          query: { project_id, filter_id, page, page_size },
        });
        let issues = data.issues || [];
        if (handler_id !== undefined) {
          issues = issues.filter((i) => i.handler?.id === handler_id);
        }
        if (only_unresolved) {
          issues = issues.filter((i) => (i.status?.id ?? 0) < threshold);
        }
        if (search_text) {
          const q = search_text.toLowerCase();
          issues = issues.filter(
            (i) =>
              i.summary?.toLowerCase().includes(q) ||
              i.description?.toLowerCase().includes(q) ||
              (i.notes || []).some((n) => n.text?.toLowerCase().includes(q))
          );
        }
        return okJson({
          count: issues.length,
          issues: issues.map((i) => normalizeIssueForLLM(i, false)),
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "create_issue",
    "Creates a new issue in MantisBT.",
    {
      summary: z.string().min(1).describe("Issue title/summary."),
      description: z.string().min(1).describe("Detailed issue description."),
      project_id: z.number().int().positive().describe("Project ID."),
      category_name: z.string().default("General").describe("Category name in the project (e.g. 'General', 'Bug')."),
      priority_name: z.enum(["none", "low", "normal", "high", "urgent", "immediate"]).optional(),
      severity_name: z.enum(["feature", "trivial", "text", "tweak", "minor", "major", "crash", "block"]).optional(),
      handler_id: z.number().int().positive().optional().describe("ID of the user to assign the issue to."),
      steps_to_reproduce: z.string().optional(),
      additional_information: z.string().optional(),
      version: z.string().optional(),
      target_version: z.string().optional(),
      tags: z.array(z.string()).optional(),
      custom_fields: z
        .array(z.object({ field_id: z.number().int().positive(), value: z.string() }))
        .optional(),
    },
    async (input) => {
      try {
        const payload: Record<string, unknown> = {
          summary: input.summary,
          description: input.description,
          project: { id: input.project_id },
          category: { name: input.category_name },
        };
        if (input.priority_name) payload.priority = { name: input.priority_name };
        if (input.severity_name) payload.severity = { name: input.severity_name };
        if (input.handler_id) payload.handler = { id: input.handler_id };
        if (input.steps_to_reproduce) payload.steps_to_reproduce = input.steps_to_reproduce;
        if (input.additional_information) payload.additional_information = input.additional_information;
        if (input.version) payload.version = { name: input.version };
        if (input.target_version) payload.target_version = { name: input.target_version };
        if (input.tags) payload.tags = input.tags.map((name) => ({ name }));
        if (input.custom_fields) {
          payload.custom_fields = input.custom_fields.map((cf) => ({
            field: { id: cf.field_id },
            value: cf.value,
          }));
        }

        const res = await mantisRequest<{ issue?: MantisIssue }>("/issues", {
          method: "POST",
          body: payload,
        });
        return okJson(res.issue ? normalizeIssueForLLM(res.issue, false) : res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "update_issue",
    "Updates any field of an existing MantisBT issue (status, assignee/handler, priority, severity, resolution, texts, versions, tags or custom fields).",
    {
      issue_id: z.number().int().positive(),
      summary: z.string().optional(),
      description: z.string().optional(),
      steps_to_reproduce: z.string().optional(),
      additional_information: z.string().optional(),
      status_name: z
        .enum(["new", "feedback", "acknowledged", "confirmed", "assigned", "resolved", "closed"])
        .optional(),
      resolution_name: z
        .enum(["open", "fixed", "reopened", "unable to reproduce", "not fixable", "duplicate", "no change required", "suspended", "won't fix"])
        .optional(),
      priority_name: z.enum(["none", "low", "normal", "high", "urgent", "immediate"]).optional(),
      severity_name: z.enum(["feature", "trivial", "text", "tweak", "minor", "major", "crash", "block"]).optional(),
      handler_id: z.number().int().positive().optional().describe("ID of the new assignee."),
      category_name: z.string().optional(),
      target_version: z.string().optional(),
      fixed_in_version: z.string().optional(),
      custom_fields: z
        .array(z.object({ field_id: z.number().int().positive(), value: z.string() }))
        .optional(),
    },
    async ({ issue_id, ...fields }) => {
      try {
        const payload: Record<string, unknown> = {};
        if (fields.summary !== undefined) payload.summary = fields.summary;
        if (fields.description !== undefined) payload.description = fields.description;
        if (fields.steps_to_reproduce !== undefined) payload.steps_to_reproduce = fields.steps_to_reproduce;
        if (fields.additional_information !== undefined) payload.additional_information = fields.additional_information;
        if (fields.status_name) payload.status = { name: fields.status_name };
        if (fields.resolution_name) payload.resolution = { name: fields.resolution_name };
        if (fields.priority_name) payload.priority = { name: fields.priority_name };
        if (fields.severity_name) payload.severity = { name: fields.severity_name };
        if (fields.handler_id) payload.handler = { id: fields.handler_id };
        if (fields.category_name) payload.category = { name: fields.category_name };
        if (fields.target_version) payload.target_version = { name: fields.target_version };
        if (fields.fixed_in_version) payload.fixed_in_version = { name: fields.fixed_in_version };
        if (fields.custom_fields) {
          payload.custom_fields = fields.custom_fields.map((cf) => ({
            field: { id: cf.field_id },
            value: cf.value,
          }));
        }

        const res = await mantisRequest<{ issues?: MantisIssue[] }>(`/issues/${issue_id}`, {
          method: "PATCH",
          body: payload,
        });
        const updated = res.issues?.[0];
        return okJson(updated ? normalizeIssueForLLM(updated, false) : res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "delete_issue",
    "Deletes a MantisBT issue by ID.",
    { issue_id: z.number().int().positive() },
    async ({ issue_id }) => {
      try {
        await mantisRequest(`/issues/${issue_id}`, { method: "DELETE" });
        return okJson({ deleted: true, issue_id });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // ============================================================================
  // 3. NOTES / COMMENTS AND TIME TRACKING
  // ============================================================================
  server.tool(
    "add_issue_note",
    "Adds a note/comment to an issue in MantisBT, with visibility support (public/private) and time tracking.",
    {
      issue_id: z.number().int().positive(),
      text: z.string().min(1).describe("Note/comment text."),
      view_state: z.enum(["public", "private"]).default("public"),
      time_tracking_duration: z
        .string()
        .optional()
        .describe("Tempo gasto no formato HH:MM (ex: '01:30')."),
    },
    async ({ issue_id, text, view_state, time_tracking_duration }) => {
      try {
        const body: Record<string, unknown> = {
          text,
          view_state: { name: view_state },
        };
        if (time_tracking_duration) {
          body.time_tracking = { duration: time_tracking_duration };
        }
        const res = await mantisRequest(`/issues/${issue_id}/notes`, {
          method: "POST",
          body,
        });
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "delete_issue_note",
    "Removes a specific note/comment from an issue.",
    {
      issue_id: z.number().int().positive(),
      note_id: z.number().int().positive(),
    },
    async ({ issue_id, note_id }) => {
      try {
        await mantisRequest(`/issues/${issue_id}/notes/${note_id}`, { method: "DELETE" });
        return okJson({ deleted: true, issue_id, note_id });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // ============================================================================
  // 4. RELATIONSHIPS, MONITORING, TAGS AND ATTACHMENTS
  // ============================================================================
  server.tool(
    "add_issue_relationship",
    "Creates a relationship between two issues (e.g. related-to, duplicate-of, parent-of, child-of, has-duplicate).",
    {
      issue_id: z.number().int().positive(),
      target_issue_id: z.number().int().positive(),
      relationship_type: z
        .enum(["related-to", "duplicate-of", "has-duplicate", "parent-of", "child-of"])
        .default("related-to"),
    },
    async ({ issue_id, target_issue_id, relationship_type }) => {
      try {
        const res = await mantisRequest(`/issues/${issue_id}/relationships`, {
          method: "POST",
          body: {
            issue: { id: target_issue_id },
            type: { name: relationship_type },
          },
        });
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "delete_issue_relationship",
    "Removes a relationship between issues.",
    {
      issue_id: z.number().int().positive(),
      relationship_id: z.number().int().positive(),
    },
    async ({ issue_id, relationship_id }) => {
      try {
        await mantisRequest(`/issues/${issue_id}/relationships/${relationship_id}`, {
          method: "DELETE",
        });
        return okJson({ deleted: true, issue_id, relationship_id });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "get_issue_attachment",
    "Downloads the content (text or Base64) of a specific issue attachment for inspection by the LLM.",
    {
      issue_id: z.number().int().positive(),
      attachment_id: z.number().int().positive(),
    },
    async ({ issue_id, attachment_id }) => {
      try {
        const res = await mantisRequest(`/issues/${issue_id}/files/${attachment_id}`);
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "add_issue_attachment",
    "Adds an attachment file (Base64) to an existing issue.",
    {
      issue_id: z.number().int().positive(),
      filename: z.string().min(1),
      content_base64: z.string().min(1).describe("File content encoded in Base64."),
    },
    async ({ issue_id, filename, content_base64 }) => {
      try {
        await mantisRequest(`/issues/${issue_id}/files`, {
          method: "POST",
          body: {
            files: [{ name: filename, content: content_base64 }],
          },
        });
        return okJson({ uploaded: true, issue_id, filename });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "attach_issue_tags",
    "Attaches one or more tags to an issue.",
    {
      issue_id: z.number().int().positive(),
      tags: z.array(z.string().min(1)).min(1),
    },
    async ({ issue_id, tags }) => {
      try {
        const res = await mantisRequest(`/issues/${issue_id}/tags`, {
          method: "POST",
          body: { tags: tags.map((name) => ({ name })) },
        });
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "detach_issue_tag",
    "Removes a tag from an issue by tag ID.",
    {
      issue_id: z.number().int().positive(),
      tag_id: z.number().int().positive(),
    },
    async ({ issue_id, tag_id }) => {
      try {
        await mantisRequest(`/issues/${issue_id}/tags/${tag_id}`, { method: "DELETE" });
        return okJson({ detached: true, issue_id, tag_id });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "monitor_issue",
    "Adds a user (or the authenticated user if omitted) as a monitor/observer of an issue.",
    {
      issue_id: z.number().int().positive(),
      username: z.string().optional(),
    },
    async ({ issue_id, username }) => {
      try {
        const body = username ? { users: [{ name: username }] } : {};
        const res = await mantisRequest(`/issues/${issue_id}/monitors`, {
          method: "POST",
          body,
        });
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // ============================================================================
  // 5. PROJECTS, VERSIONS, CATEGORIES, SUBPROJECTS, FILTERS AND USERS
  // ============================================================================
  server.tool(
    "list_projects",
    "Lists all accessible MantisBT projects, including categories, versions and custom fields.",
    {},
    async () => {
      try {
        const res = await mantisRequest("/projects");
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "get_project",
    "Gets full details of a specific project by ID.",
    { project_id: z.number().int().positive() },
    async ({ project_id }) => {
      try {
        const res = await mantisRequest(`/projects/${project_id}`);
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "create_project_version",
    "Creates a new version within a MantisBT project.",
    {
      project_id: z.number().int().positive(),
      name: z.string().min(1),
      description: z.string().optional(),
      released: z.boolean().default(false),
      obsolete: z.boolean().default(false),
      timestamp: z.string().optional().describe("Version date in ISO-8601 format."),
    },
    async ({ project_id, name, description, released, obsolete, timestamp }) => {
      try {
        await mantisRequest(`/projects/${project_id}/versions`, {
          method: "POST",
          body: { name, description, released, obsolete, timestamp },
        });
        return okJson({ created: true, project_id, version: name });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "list_filters",
    "Lists all saved filters available to the user in MantisBT.",
    {},
    async () => {
      try {
        const res = await mantisRequest("/filters");
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "get_current_user",
    "Returns the full profile of the authenticated user (/users/me) in MantisBT.",
    {},
    async () => {
      try {
        const res = await mantisRequest("/users/me");
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "check_mantis_connection",
    "Validates connectivity and authentication with the MantisBT REST API (including automatic detection of /api/rest/index.php when mod_rewrite is disabled).",
    {},
    async () => {
      try {
        const user = await mantisRequest<{
          id: number;
          name: string;
          real_name?: string;
          email?: string;
          access_level?: MantisEntityRef;
          projects?: MantisEntityRef[];
        }>("/users/me");
        const env = getMantisEnv();
        return okJson({
          connected: true,
          web_root_url: env.webRootUrl,
          api_root_url: env.apiRootUrl,
          authenticated_user: {
            id: user.id,
            name: user.name,
            real_name: user.real_name,
            email: user.email,
            access_level: user.access_level?.label || user.access_level?.name,
            accessible_projects_count: (user.projects || []).length,
          },
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "get_mantis_config",
    "Gets configuration options from the MantisBT server (e.g. status_enum_string, priority_enum_string, workflows).",
    {
      options: z
        .array(z.string())
        .min(1)
        .describe("List of configuration keys (e.g. ['status_enum_string', 'priority_enum_string'])."),
      project_id: z.number().int().positive().optional(),
      user_id: z.number().int().positive().optional(),
    },
    async ({ options, project_id, user_id }) => {
      try {
        const query: Record<string, string | number | undefined> = {
          "option[]": options.join(","),
          project_id,
          user_id,
        };
        const res = await mantisRequest("/config", { query });
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // ============================================================================
  // 6. LOCAL VECTOR STORE & PROJECT EFFICIENCY ANALYSIS
  // ============================================================================
  async function collectIssuesForVectorSync(params: {
    project_id?: number;
    filter_id?: string;
    max_pages: number;
    hydrate_individual_issues: boolean;
  }): Promise<MantisIssue[]> {
    const collected = new Map<number, MantisIssue>();
    for (let page = 1; page <= params.max_pages; page++) {
      const resp = await mantisRequest<{ issues?: MantisIssue[] }>("/issues", {
        query: {
          project_id: params.project_id,
          filter_id: params.filter_id,
          page,
          page_size: 50,
        },
      });
      const batch = resp.issues || [];
      if (batch.length === 0) break;
      for (const iss of batch) {
        collected.set(iss.id, iss);
      }
      if (batch.length < 50) break;
    }

    let list = Array.from(collected.values());
    if (params.hydrate_individual_issues && list.length > 0) {
      const hydrated: MantisIssue[] = [];
      for (const item of list) {
        const detail = await mantisRequest<{ issues?: MantisIssue[] }>(`/issues/${item.id}`);
        hydrated.push(detail.issues?.[0] ?? item);
      }
      list = hydrated;
    }
    return list;
  }

  server.tool(
    "sync_issues_to_vector_store",
    "Collects MantisBT issues, computes vector embeddings (local 256d or external API) and lifecycle metrics (lead time, reopens, assignment ping-pong, stagnation), and persists everything to the local mini vector store for semantic search and efficiency analysis.",
    {
      project_id: z.number().int().positive().optional().describe("Filter collection by project ID."),
      filter_id: z.string().optional().describe("Saved filter ID in MantisBT."),
      max_pages: z.number().int().min(1).max(20).default(5).describe("Maximum number of pages (50 issues/page) to index."),
      hydrate_individual_issues: z
        .boolean()
        .default(false)
        .describe("If true, fetches GET /issues/{id} individually to ensure the complete transition history."),
    },
    async ({ project_id, filter_id, max_pages, hydrate_individual_issues }) => {
      try {
        const store = new MantisVectorStore();
        const issues = await collectIssuesForVectorSync({
          project_id,
          filter_id,
          max_pages,
          hydrate_individual_issues,
        });
        const threshold = getMantisEnv().resolvedThreshold;
        const stats = await store.upsertIssues(issues, threshold);
        return okJson(stats);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "search_vector_issues",
    "Runs a semantic search by cosine similarity over the MantisBT issue mini vector store, combining embeddings and metadata filters to find recurring bugs, similar root causes or technical history.",
    {
      query: z.string().min(1).describe("Natural-language semantic query (e.g. 'timeout in the payment queue')."),
      top_k: z.number().int().min(1).max(50).default(10),
      project_id: z.number().int().positive().optional(),
      handler_id: z.number().int().positive().optional(),
      only_unresolved: z.boolean().default(false),
      min_similarity: z.number().min(0).max(1).default(0.05),
    },
    async (input) => {
      try {
        const store = new MantisVectorStore();
        const results = await store.search(input);
        return okJson({
          query: input.query,
          count: results.length,
          results,
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  server.tool(
    "analyze_project_efficiency",
    "Analyzes project engineering efficiency via the MantisBT issue vector store: computes resolution rate, mean/P50/P90 lead time, rework rate (reopens), assignee ping-pong, stagnant/overdue issues, efficiency per developer, semantic clusters of recurring bottlenecks, and an Efficiency Score (0-100) with actionable diagnostics.",
    {
      project_id: z.number().int().positive().optional().describe("Filter the analysis by a specific project."),
      handler_id: z.number().int().positive().optional().describe("Filter the analysis by a specific assignee."),
      auto_sync: z
        .boolean()
        .default(true)
        .describe("If true (or if the vector store is empty), syncs issues from the MantisBT API before analyzing."),
      max_sync_pages: z.number().int().min(1).max(20).default(5),
      stale_threshold_hours: z
        .number()
        .positive()
        .default(168)
        .describe("Hours without update after which an open issue is considered stagnant (default 168h = 7 days)."),
      cluster_similarity_threshold: z
        .number()
        .min(0.1)
        .max(0.95)
        .default(0.38)
        .describe("Cosine similarity threshold (0.1 to 0.95) for grouping recurring issues into semantic clusters."),
    },
    async ({
      project_id,
      handler_id,
      auto_sync,
      max_sync_pages,
      stale_threshold_hours,
      cluster_similarity_threshold,
    }) => {
      try {
        const store = new MantisVectorStore();
        const data = await store.load();
        const hasRecords = Object.keys(data.records).length > 0;

        if (auto_sync || !hasRecords) {
          const issues = await collectIssuesForVectorSync({
            project_id,
            max_pages: max_sync_pages,
            hydrate_individual_issues: false,
          });
          if (issues.length > 0) {
            await store.upsertIssues(issues, getMantisEnv().resolvedThreshold);
          }
        }

        const report = await store.analyzeEfficiency({
          project_id,
          handler_id,
          stale_threshold_hours,
          cluster_similarity_threshold,
        });
        return okJson(report);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  return server;
}

async function main() {
  const server = createMantisMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Fatal error starting MantisBT MCP:", err);
    process.exit(1);
  });
}
