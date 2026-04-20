import type {
  Page, PageInput, PageFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
} from './types.ts';

/** Input row for addLinksBatch. Optional fields default to '' (matches NOT NULL DDL). */
export interface LinkBatchInput {
  from_slug: string;
  to_slug: string;
  link_type?: string;
  context?: string;
  valid_from?: string;  // ISO date string; null/undefined = unknown provenance
}

/** Input row for addTimelineEntriesBatch. Optional fields default to '' (matches NOT NULL DDL). */
export interface TimelineBatchInput {
  slug: string;
  date: string;
  source?: string;
  summary: string;
  detail?: string;
}

/** Maximum results returned by search operations. Internal bulk operations (listPages) are not clamped. */
export const MAX_SEARCH_LIMIT = 100;

/** Clamp a user-provided search limit to a safe range. */
export function clampSearchLimit(limit: number | undefined, defaultLimit = 20, cap = MAX_SEARCH_LIMIT): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || Number.isNaN(limit)) return defaultLimit;
  if (limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), cap);
}

export interface BrainEngine {
  // Lifecycle
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;

  // Pages CRUD
  getPage(slug: string): Promise<Page | null>;
  putPage(slug: string, page: PageInput): Promise<Page>;
  deletePage(slug: string): Promise<void>;
  listPages(filters?: PageFilters): Promise<Page[]>;
  resolveSlugs(partial: string): Promise<string[]>;
  /**
   * Find repo pages declaring the given canonical GitHub URL via
   * `frontmatter.github_url`. Scoped to slug prefix `repos/`.
   *
   * Uses a JSONB containment query (`frontmatter @> {"github_url": $url}`)
   * which is accelerated by the `idx_pages_frontmatter` GIN index. Callers
   * MUST pass a canonical URL form (see `normalizeGitUrl()`).
   */
  findRepoByUrl(url: string): Promise<{ slug: string; title: string }[]>;

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;
  getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>>;

  // Chunks
  upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void>;
  getChunks(slug: string): Promise<Chunk[]>;
  deleteChunks(slug: string): Promise<void>;

  // Links
  addLink(from: string, to: string, context?: string, linkType?: string, validFrom?: string): Promise<void>;
  /**
   * Bulk insert links via a single multi-row INSERT...SELECT FROM (VALUES) JOIN pages
   * statement with ON CONFLICT DO NOTHING. Returns the count of rows actually inserted
   * (RETURNING clause excludes conflicts and JOIN-dropped rows whose slugs don't exist).
   * Used by extract.ts to avoid 47K sequential round-trips on large brains.
   */
  addLinksBatch(links: LinkBatchInput[]): Promise<number>;
  /**
   * Soft-close links from `from` to `to` by setting valid_until = today.
   * If linkType is provided, only that specific (from, to, type) row is closed.
   * If omitted (or ''), ALL current link types between the pair are closed.
   * Historical rows (valid_until IS NOT NULL) are untouched.
   */
  removeLink(from: string, to: string, linkType?: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
  traverseGraph(slug: string, depth?: number): Promise<GraphNode[]>;

  // Tags
  addTag(slug: string, tag: string): Promise<void>;
  removeTag(slug: string, tag: string): Promise<void>;
  getTags(slug: string): Promise<string[]>;

  // Timeline
  /**
   * Insert a timeline entry. By default verifies the page exists and throws if not.
   * Pass opts.skipExistenceCheck=true for batch operations where the slug is already
   * known to exist (e.g., from a getAllSlugs() snapshot). Duplicates are silently
   * deduplicated by the (page_id, date, summary) UNIQUE index (ON CONFLICT DO NOTHING).
   */
  addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean },
  ): Promise<void>;
  /**
   * Bulk insert timeline entries via a single multi-row INSERT...SELECT FROM (VALUES)
   * JOIN pages statement with ON CONFLICT DO NOTHING. Returns the count of rows
   * actually inserted (RETURNING excludes conflicts and JOIN-dropped rows whose
   * slugs don't exist). Used by extract.ts to avoid sequential round-trips.
   */
  addTimelineEntriesBatch(entries: TimelineBatchInput[]): Promise<number>;
  getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]>;

  // Raw data
  putRawData(slug: string, source: string, data: object): Promise<void>;
  getRawData(slug: string, source?: string): Promise<RawData[]>;

  // Versions
  createVersion(slug: string): Promise<PageVersion>;
  getVersions(slug: string): Promise<PageVersion[]>;
  revertToVersion(slug: string, versionId: number): Promise<void>;

  // Stats + health
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]>;

  // Sync
  updateSlug(oldSlug: string, newSlug: string): Promise<void>;
  rewriteLinks(oldSlug: string, newSlug: string): Promise<void>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;

  // Migration support
  runMigration(version: number, sql: string): Promise<void>;
  getChunksWithEmbeddings(slug: string): Promise<Chunk[]>;
}
