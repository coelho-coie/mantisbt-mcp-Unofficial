import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { MantisIssue } from "./index.js";

const DEFAULT_VECTOR_DIM = 256;
const execFileAsync = promisify(execFile);

// POSIX modes (0o600) are ignored on Windows, so restrict the ACL to the current user instead.
// Best effort: a failure is logged but does not block saving.
async function restrictToCurrentUser(filePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await execFileAsync("icacls", [filePath, "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`]);
  } catch (err) {
    console.error(`[mantisbt-mcp] Could not restrict permissions on ${filePath}: ${(err as Error).message}`);
  }
}

// Stopwords. The project was developed first in Portuguese, so the Portuguese
// words are kept on purpose: they filter the Portuguese issue text that the
// local vectorizer indexes. Translating them would change the embeddings and
// therefore the search and clustering behavior.
const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "um", "uma",
  "para", "por", "com", "sem", "sob", "sobre", "que", "se", "ao", "aos", "as",
  "os", "e", "ou", "mas", "foi", "ser", "esta", "este", "isso", "the", "and",
  "for", "with", "from", "that", "this", "are", "was", "were", "have", "has",
  "had", "not", "but", "into", "when", "where", "which", "who", "will", "can",
]);

export interface IssueEfficiencyMetrics {
  is_resolved: boolean;
  lead_time_hours: number | null;
  open_age_hours: number;
  staleness_hours: number;
  reopen_count: number;
  reassignment_count: number;
  note_count: number;
  time_tracking_minutes: number;
  is_overdue: boolean;
}

export interface VectorIssueRecord {
  id: number;
  project_id: number | null;
  project_name: string;
  category: string;
  summary: string;
  status_id: number;
  status_name: string;
  priority_id: number;
  priority_name: string;
  severity_id: number;
  severity_name: string;
  handler_id: number | null;
  handler_name: string | null;
  reporter_id: number | null;
  reporter_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  due_date: string | null;
  tags: string[];
  metrics: IssueEfficiencyMetrics;
  document_text: string;
  vector: number[];
  indexed_at: string;
}

export interface VectorStoreData {
  version: 1;
  updated_at: string;
  embedding_mode: string;
  dimensions: number;
  records: Record<string, VectorIssueRecord>;
}

export interface VectorSearchOptions {
  query: string;
  top_k?: number;
  project_id?: number;
  handler_id?: number;
  only_unresolved?: boolean;
  min_similarity?: number;
}

export interface VectorSearchResult {
  id: number;
  similarity: number;
  summary: string;
  project_name: string;
  category: string;
  status_name: string;
  priority_name: string;
  severity_name: string;
  handler_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  tags: string[];
  metrics: IssueEfficiencyMetrics;
}

export interface EfficiencyAnalysisOptions {
  project_id?: number;
  handler_id?: number;
  stale_threshold_hours?: number;
  cluster_similarity_threshold?: number;
  max_cluster_items?: number;
}

function fnv1aHash(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_+#.-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export function computeLocalEmbedding(text: string, dimensions = DEFAULT_VECTOR_DIM): number[] {
  const vec = new Float64Array(dimensions);
  const tokens = tokenizeText(text);
  if (tokens.length === 0) return Array.from(vec);

  const featureCounts = new Map<string, number>();
  const addFeature = (feat: string, weight: number) => {
    featureCounts.set(feat, (featureCounts.get(feat) || 0) + weight);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    addFeature(`w:${tok}`, 1.0);
    if (i + 1 < tokens.length) {
      addFeature(`b:${tok}_${tokens[i + 1]!}`, 1.25);
    }
    if (tok.length >= 4) {
      for (let j = 0; j <= tok.length - 3; j++) {
        addFeature(`c:${tok.slice(j, j + 3)}`, 0.35);
      }
    }
  }

  for (const [feat, rawCount] of featureCounts.entries()) {
    const tf = 1 + Math.log(rawCount);
    const h1 = fnv1aHash(feat, 2166136261);
    const h2 = fnv1aHash(feat, 374761393);
    const idx = h1 % dimensions;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * tf;
  }

  let normSq = 0;
  for (let i = 0; i < dimensions; i++) {
    normSq += vec[i]! * vec[i]!;
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vec[i] = Number((vec[i]! / norm).toFixed(6));
    }
  }
  return Array.from(vec);
}

const EMBEDDING_TIMEOUT_MS = 15000;

export async function computeEmbedding(text: string, dimensions = DEFAULT_VECTOR_DIM): Promise<{ vector: number[]; mode: string }> {
  const apiUrl = process.env.MANTIS_EMBEDDING_API_URL;
  const apiKey = process.env.MANTIS_EMBEDDING_API_KEY;
  const model = process.env.MANTIS_EMBEDDING_MODEL || "text-embedding-3-small";

  if (apiUrl && apiKey && process.env.MANTIS_ALLOW_EXTERNAL_EMBEDDINGS !== "true") {
    console.error("[mantisbt-mcp] External embeddings are configured but MANTIS_ALLOW_EXTERNAL_EMBEDDINGS is not 'true'; using local embeddings (issue text is not sent out).");
  } else if (apiUrl && apiKey) {
    const parsed = new URL(apiUrl);
    const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !isLocalHost) {
      throw new Error("MANTIS_EMBEDDING_API_URL must use https (issue text and API key would be sent in clear text).");
    }
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: text, model }),
      redirect: "error",
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    }).catch((err: unknown) => {
      console.error(`[mantisbt-mcp] Embedding API failed (${(err as Error).message}); using local embeddings.`);
      return null;
    });
    if (res && !res.ok) {
      console.error(`[mantisbt-mcp] Embedding API returned HTTP ${res.status}; using local embeddings.`);
    }
    if (res?.ok) {
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const emb = json.data?.[0]?.embedding;
      if (Array.isArray(emb) && emb.length > 0) {
        return { vector: emb, mode: `api:${model}` };
      }
    }
  }

  return { vector: computeLocalEmbedding(text, dimensions), mode: `local-feature-hash-${dimensions}d` };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function parseDurationMinutes(duration?: string): number {
  if (!duration) return 0;
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(duration.trim());
  if (!m) return 0;
  const hours = Number(m[1] || 0);
  const mins = Number(m[2] || 0);
  return hours * 60 + mins;
}

function safeParseMs(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function buildIssueDocumentText(issue: MantisIssue): string {
  const parts: string[] = [
    issue.summary || "",
    issue.category?.name ? `category:${issue.category.name}` : "",
    issue.description || "",
    issue.steps_to_reproduce || "",
    issue.additional_information || "",
    ...(issue.tags || []).map((t) => `tag:${t.name || t.id}`),
    ...(issue.custom_fields || []).map((cf) => `${cf.field?.name || "field"}:${cf.value || ""}`),
    ...(issue.notes || []).map((n) => n.text || ""),
  ];
  return parts.filter(Boolean).join("\n");
}

export function extractIssueMetrics(
  issue: MantisIssue,
  resolvedThreshold = 80,
  nowMs = Date.now()
): IssueEfficiencyMetrics {
  const statusId = issue.status?.id ?? 0;
  const isResolved = statusId >= resolvedThreshold;
  const createdMs = safeParseMs(issue.created_at);
  const updatedMs = safeParseMs(issue.updated_at) ?? createdMs;
  const dueMs = safeParseMs(issue.due_date);

  let reopenCount = 0;
  let reassignmentCount = 0;
  let resolvedAtMs: number | null = null;

  for (const h of issue.history || []) {
    const fieldName = (h.field?.name || h.type?.name || "").toLowerCase();
    if (fieldName.includes("handler") || fieldName.includes("assign")) {
      if (h.old_value !== undefined && h.old_value !== null && h.old_value !== "" && h.old_value !== 0) {
        reassignmentCount++;
      }
    }
    if (fieldName === "status") {
      const oldStatus = typeof h.old_value === "object" && h.old_value !== null
        ? (h.old_value as { id?: number }).id
        : Number(h.old_value);
      const newStatus = typeof h.new_value === "object" && h.new_value !== null
        ? (h.new_value as { id?: number }).id
        : Number(h.new_value);

      if (!Number.isNaN(oldStatus) && !Number.isNaN(newStatus)) {
        if ((oldStatus ?? 0) >= resolvedThreshold && (newStatus ?? 0) < resolvedThreshold) {
          reopenCount++;
        }
        if ((newStatus ?? 0) >= resolvedThreshold) {
          const hMs = safeParseMs(h.created_at);
          if (hMs !== null) resolvedAtMs = hMs;
        }
      }
    }
    if (fieldName === "resolution") {
      const newValStr = JSON.stringify(h.new_value || "").toLowerCase();
      if (newValStr.includes("reopen")) {
        reopenCount++;
      }
    }
  }

  if (isResolved && resolvedAtMs === null && updatedMs !== null) {
    resolvedAtMs = updatedMs;
  }

  const leadTimeHours =
    isResolved && createdMs !== null && resolvedAtMs !== null && resolvedAtMs >= createdMs
      ? Number(((resolvedAtMs - createdMs) / 3_600_000).toFixed(2))
      : null;

  const openAgeHours =
    createdMs !== null ? Number((Math.max(0, (isResolved && resolvedAtMs ? resolvedAtMs : nowMs) - createdMs) / 3_600_000).toFixed(2)) : 0;

  const stalenessHours =
    updatedMs !== null ? Number((Math.max(0, nowMs - updatedMs) / 3_600_000).toFixed(2)) : 0;

  let timeTrackingMinutes = 0;
  for (const n of issue.notes || []) {
    timeTrackingMinutes += parseDurationMinutes(n.time_tracking?.duration);
  }

  const isOverdue = !isResolved && dueMs !== null && nowMs > dueMs;

  return {
    is_resolved: isResolved,
    lead_time_hours: leadTimeHours,
    open_age_hours: openAgeHours,
    staleness_hours: stalenessHours,
    reopen_count: reopenCount,
    reassignment_count: reassignmentCount,
    note_count: (issue.notes || []).length,
    time_tracking_minutes: timeTrackingMinutes,
    is_overdue: isOverdue,
  };
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Number(sortedValues[lo]!.toFixed(2));
  const weight = idx - lo;
  return Number((sortedValues[lo]! * (1 - weight) + sortedValues[hi]! * weight).toFixed(2));
}

export class MantisVectorStore {
  private readonly filePath: string;
  private data: VectorStoreData | null = null;

  constructor(customPath?: string) {
    this.filePath = customPath || process.env.MANTIS_VECTOR_DB_PATH || path.resolve(process.cwd(), ".mantis-vector-store.json");
  }

  public getStoragePath(): string {
    return this.filePath;
  }

  public async load(): Promise<VectorStoreData> {
    if (this.data) return this.data;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as VectorStoreData;
      if (parsed && parsed.version === 1 && parsed.records) {
        this.data = parsed;
        return this.data;
      }
    } catch {
      // Initialize fresh store if file does not exist
    }
    this.data = {
      version: 1,
      updated_at: new Date().toISOString(),
      embedding_mode: `local-feature-hash-${DEFAULT_VECTOR_DIM}d`,
      dimensions: DEFAULT_VECTOR_DIM,
      records: {},
    };
    return this.data;
  }

  public async save(): Promise<void> {
    const store = await this.load();
    store.updated_at = new Date().toISOString();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(store), { encoding: "utf-8", mode: 0o600 });
    await restrictToCurrentUser(tmpPath);
    await fs.rename(tmpPath, this.filePath);
  }

  public async upsertIssues(
    issues: MantisIssue[],
    resolvedThreshold = 80,
    nowMs = Date.now()
  ): Promise<{ indexed_count: number; total_in_store: number; projects_covered: string[]; embedding_mode: string; storage_path: string }> {
    const store = await this.load();
    let lastMode = store.embedding_mode;

    for (const issue of issues) {
      const docText = buildIssueDocumentText(issue);
      const { vector, mode } = await computeEmbedding(docText, store.dimensions || DEFAULT_VECTOR_DIM);
      lastMode = mode;
      const metrics = extractIssueMetrics(issue, resolvedThreshold, nowMs);

      const record: VectorIssueRecord = {
        id: issue.id,
        project_id: issue.project?.id ?? null,
        project_name: issue.project?.name || String(issue.project?.id || "Default"),
        category: issue.category?.name || "General",
        summary: issue.summary || "",
        status_id: issue.status?.id ?? 0,
        status_name: issue.status?.label || issue.status?.name || "unknown",
        priority_id: issue.priority?.id ?? 30,
        priority_name: issue.priority?.label || issue.priority?.name || "normal",
        severity_id: issue.severity?.id ?? 50,
        severity_name: issue.severity?.label || issue.severity?.name || "minor",
        handler_id: issue.handler?.id ?? null,
        handler_name: issue.handler?.real_name || issue.handler?.name || null,
        reporter_id: issue.reporter?.id ?? null,
        reporter_name: issue.reporter?.real_name || issue.reporter?.name || null,
        created_at: issue.created_at ?? null,
        updated_at: issue.updated_at ?? null,
        due_date: issue.due_date ?? null,
        tags: (issue.tags || []).map((t) => t.name || String(t.id)),
        metrics,
        document_text: docText,
        vector,
        indexed_at: new Date(nowMs).toISOString(),
      };

      store.records[String(issue.id)] = record;
    }

    store.embedding_mode = lastMode;
    if (issues.length > 0) {
      const firstVec = store.records[String(issues[0]!.id)]?.vector;
      if (firstVec) store.dimensions = firstVec.length;
    }

    await this.save();

    const allRecords = Object.values(store.records);
    const projectsCovered = Array.from(new Set(allRecords.map((r) => r.project_name))).sort();

    return {
      indexed_count: issues.length,
      total_in_store: allRecords.length,
      projects_covered: projectsCovered,
      embedding_mode: store.embedding_mode,
      storage_path: this.filePath,
    };
  }

  public async search(options: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const store = await this.load();
    const topK = options.top_k ?? 10;
    const minSim = options.min_similarity ?? 0.05;

    const { vector: queryVec } = await computeEmbedding(options.query, store.dimensions || DEFAULT_VECTOR_DIM);
    const queryTokens = new Set(tokenizeText(options.query));

    let candidates = Object.values(store.records);
    if (options.project_id !== undefined) {
      candidates = candidates.filter((c) => c.project_id === options.project_id);
    }
    if (options.handler_id !== undefined) {
      candidates = candidates.filter((c) => c.handler_id === options.handler_id);
    }
    if (options.only_unresolved) {
      candidates = candidates.filter((c) => !c.metrics.is_resolved);
    }

    const scored: VectorSearchResult[] = [];
    for (const rec of candidates) {
      const cos = cosineSimilarity(queryVec, rec.vector);
      let lexicalBoost = 0;
      if (queryTokens.size > 0) {
        const docTokens = new Set(tokenizeText(rec.document_text));
        let hits = 0;
        for (const qt of queryTokens) {
          if (docTokens.has(qt)) hits++;
        }
        lexicalBoost = (hits / queryTokens.size) * 0.15;
      }
      const similarity = Number(Math.min(1, cos + lexicalBoost).toFixed(4));
      if (similarity >= minSim) {
        scored.push({
          id: rec.id,
          similarity,
          summary: rec.summary,
          project_name: rec.project_name,
          category: rec.category,
          status_name: rec.status_name,
          priority_name: rec.priority_name,
          severity_name: rec.severity_name,
          handler_name: rec.handler_name,
          created_at: rec.created_at,
          updated_at: rec.updated_at,
          tags: rec.tags,
          metrics: rec.metrics,
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity || b.priority_name.localeCompare(a.priority_name));
    return scored.slice(0, topK);
  }

  public async analyzeEfficiency(options: EfficiencyAnalysisOptions = {}) {
    const store = await this.load();
    const staleThresholdHours = options.stale_threshold_hours ?? 168; // 7 days default
    const clusterSimThreshold = options.cluster_similarity_threshold ?? 0.38;
    const maxClusterItems = options.max_cluster_items ?? 300;

    let records = Object.values(store.records);
    if (options.project_id !== undefined) {
      records = records.filter((r) => r.project_id === options.project_id);
    }
    if (options.handler_id !== undefined) {
      records = records.filter((r) => r.handler_id === options.handler_id);
    }

    const totalIssues = records.length;
    if (totalIssues === 0) {
      return {
        total_issues_analyzed: 0,
        efficiency_score: null,
        message: "No issues found in the vector store for the given filters. Run sync_issues_to_vector_store or enable auto_sync.",
      };
    }

    const resolvedRecords = records.filter((r) => r.metrics.is_resolved);
    const unresolvedRecords = records.filter((r) => !r.metrics.is_resolved);
    const leadTimes = resolvedRecords
      .map((r) => r.metrics.lead_time_hours)
      .filter((v): v is number => v !== null && v >= 0)
      .sort((a, b) => a - b);

    const avgLeadTimeHours =
      leadTimes.length > 0
        ? Number((leadTimes.reduce((acc, v) => acc + v, 0) / leadTimes.length).toFixed(2))
        : null;
    const p50LeadTimeHours = percentile(leadTimes, 50);
    const p90LeadTimeHours = percentile(leadTimes, 90);

    const reopenedIssues = records.filter((r) => r.metrics.reopen_count > 0);
    const totalReopens = records.reduce((acc, r) => acc + r.metrics.reopen_count, 0);
    const totalReassignments = records.reduce((acc, r) => acc + r.metrics.reassignment_count, 0);
    const totalTimeTrackedMinutes = records.reduce((acc, r) => acc + r.metrics.time_tracking_minutes, 0);

    const staleUnresolved = unresolvedRecords.filter((r) => r.metrics.staleness_hours >= staleThresholdHours);
    const overdueUnresolved = unresolvedRecords.filter((r) => r.metrics.is_overdue);
    const unassignedUnresolved = unresolvedRecords.filter((r) => r.handler_id === null);

    // Breakdown by assignee
    const assigneeMap = new Map<
      string,
      {
        handler_id: number | null;
        handler_name: string;
        total: number;
        resolved: number;
        unresolved: number;
        stale_unresolved: number;
        reopen_count: number;
        time_tracking_minutes: number;
        lead_times: number[];
      }
    >();

    for (const r of records) {
      const key = r.handler_id !== null ? `${r.handler_id}:${r.handler_name || r.handler_id}` : "unassigned";
      const entry = assigneeMap.get(key) || {
        handler_id: r.handler_id,
        handler_name: r.handler_name || "Unassigned",
        total: 0,
        resolved: 0,
        unresolved: 0,
        stale_unresolved: 0,
        reopen_count: 0,
        time_tracking_minutes: 0,
        lead_times: [],
      };
      entry.total++;
      if (r.metrics.is_resolved) {
        entry.resolved++;
        if (r.metrics.lead_time_hours !== null) entry.lead_times.push(r.metrics.lead_time_hours);
      } else {
        entry.unresolved++;
        if (r.metrics.staleness_hours >= staleThresholdHours) entry.stale_unresolved++;
      }
      entry.reopen_count += r.metrics.reopen_count;
      entry.time_tracking_minutes += r.metrics.time_tracking_minutes;
      assigneeMap.set(key, entry);
    }

    const assigneeEfficiency = Array.from(assigneeMap.values())
      .map((a) => ({
        handler_id: a.handler_id,
        handler_name: a.handler_name,
        total_assigned: a.total,
        resolved_count: a.resolved,
        unresolved_count: a.unresolved,
        resolution_rate_pct: Number(((a.resolved / a.total) * 100).toFixed(1)),
        stale_unresolved_count: a.stale_unresolved,
        reopen_count: a.reopen_count,
        time_tracking_hours: Number((a.time_tracking_minutes / 60).toFixed(2)),
        avg_lead_time_hours:
          a.lead_times.length > 0
            ? Number((a.lead_times.reduce((s, v) => s + v, 0) / a.lead_times.length).toFixed(2))
            : null,
      }))
      .sort((a, b) => b.unresolved_count - a.unresolved_count || b.total_assigned - a.total_assigned);

    // Semantic clustering of recurring issues/bottlenecks using vector cosine similarity
    const slice = records.slice(0, maxClusterItems);
    const visited = new Set<number>();
    const semanticClusters: Array<{
      cluster_id: number;
      theme_summary: string;
      dominant_category: string;
      issue_count: number;
      unresolved_count: number;
      reopen_count: number;
      avg_lead_time_hours: number | null;
      issue_ids: number[];
      sample_summaries: string[];
    }> = [];

    for (let i = 0; i < slice.length; i++) {
      const seed = slice[i]!;
      if (visited.has(seed.id)) continue;

      const members: VectorIssueRecord[] = [seed];
      for (let j = i + 1; j < slice.length; j++) {
        const candidate = slice[j]!;
        if (visited.has(candidate.id)) continue;
        const sim = cosineSimilarity(seed.vector, candidate.vector);
        if (sim >= clusterSimThreshold) {
          members.push(candidate);
        }
      }

      if (members.length >= 2) {
        for (const m of members) visited.add(m.id);
        const catCounts: Record<string, number> = {};
        let clusterUnresolved = 0;
        let clusterReopens = 0;
        const clusterLeads: number[] = [];

        for (const m of members) {
          catCounts[m.category] = (catCounts[m.category] || 0) + 1;
          if (!m.metrics.is_resolved) clusterUnresolved++;
          clusterReopens += m.metrics.reopen_count;
          if (m.metrics.lead_time_hours !== null) clusterLeads.push(m.metrics.lead_time_hours);
        }

        const dominantCategory =
          Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || seed.category;

        semanticClusters.push({
          cluster_id: semanticClusters.length + 1,
          theme_summary: seed.summary,
          dominant_category: dominantCategory,
          issue_count: members.length,
          unresolved_count: clusterUnresolved,
          reopen_count: clusterReopens,
          avg_lead_time_hours:
            clusterLeads.length > 0
              ? Number((clusterLeads.reduce((s, v) => s + v, 0) / clusterLeads.length).toFixed(2))
              : null,
          issue_ids: members.map((m) => m.id),
          sample_summaries: members.slice(0, 4).map((m) => `#${m.id}: ${m.summary}`),
        });
      }
    }

    semanticClusters.sort((a, b) => b.unresolved_count - a.unresolved_count || b.issue_count - a.issue_count);

    // Deterministic Efficiency Score (0-100) + Actionable Diagnostics
    const resolutionRatePct = Number(((resolvedRecords.length / totalIssues) * 100).toFixed(1));
    const reopenRatePct = Number(((reopenedIssues.length / totalIssues) * 100).toFixed(1));
    const staleUnresolvedRatePct =
      unresolvedRecords.length > 0
        ? Number(((staleUnresolved.length / unresolvedRecords.length) * 100).toFixed(1))
        : 0;
    const avgPingPong = Number((totalReassignments / totalIssues).toFixed(2));

    let score = 100;
    const diagnostics: string[] = [];

    if (resolutionRatePct < 50) {
      const penalty = Math.min(25, Math.round((50 - resolutionRatePct) * 0.5));
      score -= penalty;
      diagnostics.push(`Low resolution rate (${resolutionRatePct}% resolved; ${unresolvedRecords.length} open).`);
    }
    if (staleUnresolvedRatePct > 20) {
      const penalty = Math.min(25, Math.round((staleUnresolvedRatePct - 20) * 0.35));
      score -= penalty;
      diagnostics.push(
        `Stagnation bottleneck: ${staleUnresolved.length} of ${unresolvedRecords.length} open issues (${staleUnresolvedRatePct}%) have had no update for more than ${staleThresholdHours}h.`
      );
    }
    if (reopenRatePct > 10) {
      const penalty = Math.min(20, Math.round((reopenRatePct - 10) * 0.8));
      score -= penalty;
      diagnostics.push(`High rework: ${reopenRatePct}% of issues were reopened (${totalReopens} total reopens).`);
    }
    if (avgPingPong > 1.0) {
      const penalty = Math.min(15, Math.round((avgPingPong - 1.0) * 8));
      score -= penalty;
      diagnostics.push(`High assignment ping-pong: average of ${avgPingPong} assignee changes per issue.`);
    }
    if (p90LeadTimeHours !== null && p90LeadTimeHours > 168) {
      score -= 10;
      diagnostics.push(`Lead time P90 elevado (${p90LeadTimeHours}h > 168h / 7 dias).`);
    }
    if (semanticClusters.length > 0) {
      const topCluster = semanticClusters[0]!;
      score -= Math.min(10, semanticClusters.length * 3);
      diagnostics.push(
        `Detected ${semanticClusters.length} semantic clusters of recurring problems (principal: "${topCluster.theme_summary}" com ${topCluster.issue_count} issues: ${topCluster.issue_ids.join(", ")}).`
      );
    }
    if (diagnostics.length === 0) {
      diagnostics.push("Healthy flow: low reopen rate, no severe stagnation bottlenecks or open critical clusters.");
    }

    const finalScore = Math.max(0, Math.min(100, score));

    return {
      generated_at: new Date().toISOString(),
      storage_path: this.filePath,
      embedding_mode: store.embedding_mode,
      total_issues_analyzed: totalIssues,
      efficiency_score: finalScore,
      throughput_and_lead_time: {
        resolved_count: resolvedRecords.length,
        unresolved_count: unresolvedRecords.length,
        resolution_rate_pct: resolutionRatePct,
        avg_lead_time_hours: avgLeadTimeHours,
        p50_lead_time_hours: p50LeadTimeHours,
        p90_lead_time_hours: p90LeadTimeHours,
        total_time_tracked_hours: Number((totalTimeTrackedMinutes / 60).toFixed(2)),
      },
      friction_and_quality: {
        reopened_issues_count: reopenedIssues.length,
        total_reopens: totalReopens,
        reopen_rate_pct: reopenRatePct,
        total_reassignments: totalReassignments,
        avg_reassignments_per_issue: avgPingPong,
        stale_unresolved_count: staleUnresolved.length,
        stale_unresolved_rate_pct: staleUnresolvedRatePct,
        overdue_unresolved_count: overdueUnresolved.length,
        unassigned_unresolved_count: unassignedUnresolved.length,
      },
      assignee_efficiency: assigneeEfficiency,
      recurring_semantic_clusters: semanticClusters,
      top_stale_unresolved_issues: staleUnresolved
        .sort((a, b) => b.metrics.staleness_hours - a.metrics.staleness_hours)
        .slice(0, 10)
        .map((r) => ({
          id: r.id,
          summary: r.summary,
          handler_name: r.handler_name,
          priority_name: r.priority_name,
          staleness_hours: r.metrics.staleness_hours,
          open_age_hours: r.metrics.open_age_hours,
        })),
      diagnostics,
    };
  }
}
