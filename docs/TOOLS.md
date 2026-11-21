# Tool Reference

The server registers 25 MCP tools. Every tool returns JSON as text content. On failure, the result has `isError: true` and a JSON body of the form `{"error": "<message>"}`.

Input schemas are defined with Zod in `src/index.ts`. The tables below list the parameters that matter most. Parameters not listed (for example, `page` on list endpoints) follow the same conventions. Check the schema for the full set.

## Contents

- [Context for LLMs](#context-for-llms)
- [Vector store and efficiency analytics](#vector-store-and-efficiency-analytics)
- [Issues](#issues)
- [Notes and time tracking](#notes-and-time-tracking)
- [Relationships, tags, attachments, and monitoring](#relationships-tags-attachments-and-monitoring)
- [Projects, versions, filters, users, and settings](#projects-versions-filters-users-and-settings)

## Context for LLMs

### `get_my_unresolved_assigned_context`

Collects every unresolved issue assigned to the authenticated user, or to a given user, and returns a context bundle with an executive summary grouped by project, priority, and status.

Collection tries the native `assigned` filter first, then falls back to a paginated scan. Issues are kept when the handler matches and the status ID is below the resolved threshold.

| Parameter | Purpose |
|-----------|---------|
| `assignee_user_id` | Target user. Defaults to the authenticated user (`/users/me`). |
| `project_id` | Restrict to one project. |
| `filter_id` | Saved filter ID, or `assigned` (default). |
| `resolved_status_threshold` | Status ID at or above which an issue is treated as resolved. Default `80`. |
| `max_pages` | Maximum pages of 50 issues to scan. Default `5`. |
| `include_history` | Include transition history. Default `true`. |
| `hydrate_individual_issues` | Fetch each issue individually to fill deep fields. Default `false`. |

## Vector store and efficiency analytics

These tools use the local vector store. See [ARCHITECTURE.md](ARCHITECTURE.md#local-vector-store) for how it works.

### `sync_issues_to_vector_store`

Fetches issues from MantisBT, computes lifecycle metrics and embeddings, and saves the store to disk. Re-running it upserts records by issue ID.

| Parameter | Purpose |
|-----------|---------|
| `project_id` | Sync only one project. |
| `filter_id` | Sync only issues matching a saved filter. |
| `max_pages` | Pages of 50 issues to index. Range 1–20, default `5`. |
| `hydrate_individual_issues` | Fetch each issue for complete transition history. Default `false`. |

### `search_vector_issues`

Semantic search by cosine similarity over indexed issues.

| Parameter | Purpose |
|-----------|---------|
| `query` | Natural-language query, required. |
| `top_k` | Number of results. Range 1–50, default `10`. |
| `project_id`, `handler_id` | Metadata filters. |
| `only_unresolved` | Exclude resolved issues. Default `false`. |
| `min_similarity` | Minimum score. Range 0–1, default `0.05`. |

### `analyze_project_efficiency`

Produces the efficiency report described in ARCHITECTURE.md: throughput, lead time (mean, P50, P90), friction, per-assignee breakdown, recurring semantic clusters, a 0–100 score, and diagnostics.

| Parameter | Purpose |
|-----------|---------|
| `project_id`, `handler_id` | Restrict the analysis. |
| `auto_sync` | Sync from MantisBT first when the store is empty or when enabled. Default `true`. |
| `max_sync_pages` | Pages to sync when `auto_sync` runs. Range 1–20, default `5`. |
| `stale_threshold_hours` | Hours without an update before an open issue counts as stagnant. Default `168` (7 days). |
| `cluster_similarity_threshold` | Similarity required to group issues into a cluster. Range 0.1–0.95, default `0.38`. |

## Issues

| Tool | Purpose | Key parameters |
|------|---------|----------------|
| `get_issue_full_context` | Full dossier of one issue: description, notes, history, attachments metadata, custom fields, relationships. | `issue_id` (required) |
| `list_issues` | List and filter issues. | `project_id`, `filter_id`, `handler_id`, `only_unresolved`, `search_text`, `page`, `page_size` (max 100) |
| `create_issue` | Create an issue. | `summary`, `description`, `project_id` (required), `category_name` (default `General`), `handler_id`, plus priority, severity, versions, tags, and custom fields |
| `update_issue` | Patch any field of an existing issue. | `issue_id` and the fields to change, including `handler_id` |
| `delete_issue` | Permanently delete an issue. | `issue_id` |

## Notes and time tracking

| Tool | Purpose | Key parameters |
|------|---------|----------------|
| `add_issue_note` | Add a note with optional time tracking. | `issue_id`, `text` (required), `view_state` (`public` default, or `private`), `time_tracking_duration` |
| `delete_issue_note` | Remove a note. | `issue_id`, `note_id` |

## Relationships, tags, attachments, and monitoring

| Tool | Purpose | Key parameters |
|------|---------|----------------|
| `add_issue_relationship` | Link two issues. Types: `related-to` (default), `duplicate-of`, `has-duplicate`, `parent-of`, `child-of`. | `issue_id`, `target_issue_id`, `relationship_type` |
| `delete_issue_relationship` | Remove a link between issues. | `issue_id`, `relationship_id` |
| `get_issue_attachment` | Download one attachment's content on demand. | `issue_id`, `attachment_id` |
| `add_issue_attachment` | Upload a file to an issue. | `issue_id`, `filename`, `content_base64` (required) |
| `attach_issue_tags` | Attach one or more tags. | `issue_id`, `tags` (at least one) |
| `detach_issue_tag` | Remove a tag. | `issue_id`, `tag_id` |
| `monitor_issue` | Add a user as observer. Defaults to the authenticated user. | `issue_id`, optional `username` |

## Projects, versions, filters, users, and settings

| Tool | Purpose | Key parameters |
|------|---------|----------------|
| `check_mantis_connection` | Verify URL, token, and REST API reachability. Reports whether the `index.php` fallback was used. | none |
| `list_projects` | List accessible projects, with categories, versions, and custom fields. | none |
| `get_project` | Full details of one project. | `project_id` |
| `create_project_version` | Create a version in a project. | `project_id`, `name` (required), `description`, `timestamp` (ISO-8601), `released`, `obsolete` |
| `list_filters` | List saved filters available to the user. | none |
| `get_current_user` | Profile of the authenticated user (`/users/me`). | none |
| `get_mantis_config` | Read server configuration values such as `status_enum_string`, `priority_enum_string`, and `workflows`. | `options` (list, at least one), `project_id`, `user_id` |
