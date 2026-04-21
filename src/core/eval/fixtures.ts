/**
 * Fixture envelope + per-stage case types + parser for the pbrain eval harness.
 *
 * Every eval fixture file shares an outer envelope:
 *   { version: 1, kind: 'ingest'|'retrieval'|'answer', meta, cases[] }
 *
 * Unknown `version` values are explicitly rejected so forward drift produces a
 * loud error at load time rather than a silent mis-parse. When the shape
 * evolves we'll bump the version + document the migration.
 */

import { readFileSync, existsSync } from 'fs';

// ─────────────────────────────────────────────────────────────────
// Envelope
// ─────────────────────────────────────────────────────────────────

export const CURRENT_FIXTURE_VERSION = 1;

export type FixtureKind = 'ingest' | 'retrieval' | 'answer';
export type FixtureClass = 'baseline' | 'adversarial';

export interface FixtureMeta {
  description?: string;
  generator_model?: string;
  judge_model?: string;
  /** Ingest only: 'markdown' | 'transcript' | 'pdf' | 'url' | ... */
  source_type?: string;
  curated_at?: string;
  curator?: string;
  calibration_notes?: string;
  fixture_class?: FixtureClass;
}

export interface FixtureEnvelope<TCase> {
  version: typeof CURRENT_FIXTURE_VERSION;
  kind: FixtureKind;
  meta: FixtureMeta;
  cases: TCase[];
}

// ─────────────────────────────────────────────────────────────────
// Per-kind case shapes
// ─────────────────────────────────────────────────────────────────

/** Fact typing lets the judge route to the right column preferentially. */
export type FactType = 'narrative' | 'temporal' | 'structural';

export interface RequiredFact {
  fact: string;
  fact_type?: FactType;
}

export interface ForbiddenFact {
  fact: string;
  /** If set, only check this specific page; otherwise check the union. */
  page_scope?: string | null;
}

export interface ExpectedPage {
  slug: string;
  type?: string;
}

export interface ExpectedLink {
  from: string;
  to: string;
  type: string;
}

export interface IngestCase {
  id: string;
  source:
    | { type: 'markdown'; path: string }
    | { type: 'markdown'; content: string };
  expected_pages: ExpectedPage[];
  required_facts: RequiredFact[];
  forbidden_facts?: ForbiddenFact[];
  expected_links?: ExpectedLink[];
  /** Slugs that MUST NOT be created (hallucination guards). */
  forbidden_pages?: string[];
}

export interface RetrievalCase {
  /** Optional stable identifier. Aligns with EvalQrel.id in src/core/search/eval.ts. */
  id?: string;
  query: string;
  relevant: string[];
  grades?: Record<string, number>;
}

/**
 * A retrieved chunk + its slug. The answer stage accepts these inline in the
 * fixture (PR 4) OR derives them from a retrieval pass against a seed brain
 * (PR 5 orchestrator). Inline is the hermetic-test path; live-retrieval is the
 * production path.
 */
export interface RetrievedChunk {
  slug: string;
  text: string;
}

export interface AnswerCase {
  id: string;
  query: string;
  required_answer_facts: string[];
  forbidden_answer_facts?: string[];
  required_citations?: string[];
  forbidden_citations?: string[];
  /** When true, the model is expected to refuse; no citations should be emitted. */
  expected_refusal?: boolean;
  /**
   * Pre-computed retrieved context. When omitted, the orchestrator is expected
   * to fill it by running retrieval against a seed brain (PR 5). For PR 4's
   * standalone `pbrain eval answer`, this field MUST be present (empty array
   * is legal and exercises the refusal path).
   */
  retrieved_context?: RetrievedChunk[];
}

export type IngestFixture = FixtureEnvelope<IngestCase>;
export type RetrievalFixture = FixtureEnvelope<RetrievalCase>;
export type AnswerFixture = FixtureEnvelope<AnswerCase>;
export type AnyFixture = IngestFixture | RetrievalFixture | AnswerFixture;

// ─────────────────────────────────────────────────────────────────
// Parsing / validation
// ─────────────────────────────────────────────────────────────────

export class FixtureParseError extends Error {
  constructor(message: string) {
    super(`[fixture] ${message}`);
    this.name = 'FixtureParseError';
  }
}

/**
 * Load a fixture from either a file path or an inline JSON string.
 * Inline JSON is detected by leading `[` or `{` after trim.
 */
export function parseFixture(input: string): AnyFixture {
  let raw: string;
  const trimmed = input.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    raw = input;
  } else {
    if (!existsSync(input)) {
      throw new FixtureParseError(`file not found: ${input}`);
    }
    raw = readFileSync(input, 'utf-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new FixtureParseError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  return validateEnvelope(parsed);
}

/**
 * Validate a parsed-but-untyped value against the envelope contract.
 * Throws FixtureParseError with a specific message on any structural problem.
 */
export function validateEnvelope(value: unknown): AnyFixture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FixtureParseError('envelope must be a JSON object with version/kind/meta/cases');
  }
  const obj = value as Record<string, unknown>;

  if (obj.version !== CURRENT_FIXTURE_VERSION) {
    throw new FixtureParseError(
      `unsupported version: ${String(obj.version)} (expected ${CURRENT_FIXTURE_VERSION})`,
    );
  }

  const kind = obj.kind;
  if (kind !== 'ingest' && kind !== 'retrieval' && kind !== 'answer') {
    throw new FixtureParseError(`unknown kind: ${String(kind)}`);
  }

  if (typeof obj.meta !== 'object' || obj.meta === null) {
    throw new FixtureParseError('meta must be an object');
  }

  if (!Array.isArray(obj.cases)) {
    throw new FixtureParseError('cases must be an array');
  }

  switch (kind) {
    case 'ingest': return { ...obj, cases: obj.cases.map(validateIngestCase) } as IngestFixture;
    case 'retrieval': return { ...obj, cases: obj.cases.map(validateRetrievalCase) } as RetrievalFixture;
    case 'answer': return { ...obj, cases: obj.cases.map(validateAnswerCase) } as AnswerFixture;
  }
}

function validateIngestCase(raw: unknown, idx: number): IngestCase {
  const c = requireCaseObject(raw, idx, 'ingest');
  const id = requireString(c, 'id', idx);
  const source = c.source;
  if (typeof source !== 'object' || source === null) {
    throw new FixtureParseError(`ingest case[${idx}] (${id}): source must be an object`);
  }
  const srcObj = source as Record<string, unknown>;
  if (srcObj.type !== 'markdown') {
    throw new FixtureParseError(
      `ingest case[${idx}] (${id}): source.type must be "markdown" in v0.4.0 (got "${String(srcObj.type)}")`,
    );
  }
  const hasPath = typeof srcObj.path === 'string';
  const hasContent = typeof srcObj.content === 'string';
  if (!hasPath && !hasContent) {
    throw new FixtureParseError(
      `ingest case[${idx}] (${id}): source must have either "path" or "content"`,
    );
  }
  if (hasPath && hasContent) {
    throw new FixtureParseError(
      `ingest case[${idx}] (${id}): source must have exactly one of "path" or "content", not both`,
    );
  }

  if (!Array.isArray(c.expected_pages)) {
    throw new FixtureParseError(`ingest case[${idx}] (${id}): expected_pages must be an array`);
  }
  const expected_pages = c.expected_pages.map((p, i) => validateExpectedPage(p, id, i));

  if (!Array.isArray(c.required_facts)) {
    throw new FixtureParseError(`ingest case[${idx}] (${id}): required_facts must be an array`);
  }
  const required_facts = c.required_facts.map((f, i) => validateRequiredFact(f, id, i));

  const forbidden_facts = c.forbidden_facts === undefined
    ? undefined
    : validateArray(c.forbidden_facts, `ingest case[${idx}] (${id}): forbidden_facts`)
        .map((f, i) => validateForbiddenFact(f, id, i));
  const expected_links = c.expected_links === undefined
    ? undefined
    : validateArray(c.expected_links, `ingest case[${idx}] (${id}): expected_links`)
        .map((l, i) => validateExpectedLink(l, id, i));
  const forbidden_pages = c.forbidden_pages === undefined
    ? undefined
    : validateStringArray(c.forbidden_pages, `ingest case[${idx}] (${id}): forbidden_pages`);

  return {
    id,
    source: (hasPath
      ? { type: 'markdown', path: srcObj.path as string }
      : { type: 'markdown', content: srcObj.content as string }) as IngestCase['source'],
    expected_pages,
    required_facts,
    forbidden_facts,
    expected_links,
    forbidden_pages,
  };
}

function validateRetrievalCase(raw: unknown, idx: number): RetrievalCase {
  const c = requireCaseObject(raw, idx, 'retrieval');
  const query = requireString(c, 'query', idx);
  const relevant = validateStringArray(c.relevant, `retrieval case[${idx}]: relevant`);
  const id = typeof c.id === 'string' ? c.id : undefined;
  let grades: Record<string, number> | undefined;
  if (c.grades !== undefined) {
    if (typeof c.grades !== 'object' || c.grades === null || Array.isArray(c.grades)) {
      throw new FixtureParseError(`retrieval case[${idx}]: grades must be an object`);
    }
    grades = {};
    for (const [k, v] of Object.entries(c.grades)) {
      if (typeof v !== 'number') {
        throw new FixtureParseError(`retrieval case[${idx}]: grades[${k}] must be a number`);
      }
      grades[k] = v;
    }
  }
  return { id, query, relevant, grades };
}

function validateAnswerCase(raw: unknown, idx: number): AnswerCase {
  const c = requireCaseObject(raw, idx, 'answer');
  const id = requireString(c, 'id', idx);
  const query = requireString(c, 'query', idx);
  const required_answer_facts = validateStringArray(
    c.required_answer_facts,
    `answer case[${idx}] (${id}): required_answer_facts`,
  );
  const forbidden_answer_facts = c.forbidden_answer_facts === undefined
    ? undefined
    : validateStringArray(c.forbidden_answer_facts, `answer case[${idx}] (${id}): forbidden_answer_facts`);
  const required_citations = c.required_citations === undefined
    ? undefined
    : validateStringArray(c.required_citations, `answer case[${idx}] (${id}): required_citations`);
  const forbidden_citations = c.forbidden_citations === undefined
    ? undefined
    : validateStringArray(c.forbidden_citations, `answer case[${idx}] (${id}): forbidden_citations`);
  const expected_refusal = c.expected_refusal === undefined ? undefined : Boolean(c.expected_refusal);

  let retrieved_context: RetrievedChunk[] | undefined;
  if (c.retrieved_context !== undefined) {
    const arr = validateArray(c.retrieved_context, `answer case[${idx}] (${id}): retrieved_context`);
    retrieved_context = arr.map((raw, i) => validateRetrievedChunk(raw, id, i));
  }

  return {
    id, query,
    required_answer_facts,
    forbidden_answer_facts,
    required_citations,
    forbidden_citations,
    expected_refusal,
    retrieved_context,
  };
}

// ─────────────────────────────────────────────────────────────────
// small validation helpers
// ─────────────────────────────────────────────────────────────────

function requireCaseObject(raw: unknown, idx: number, kind: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FixtureParseError(`${kind} case[${idx}] must be an object`);
  }
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, idx: number): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new FixtureParseError(`case[${idx}]: ${field} must be a non-empty string`);
  }
  return v;
}

function validateArray(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) throw new FixtureParseError(`${label} must be an array`);
  return v;
}

function validateStringArray(v: unknown, label: string): string[] {
  const arr = validateArray(v, label);
  return arr.map((item, i) => {
    if (typeof item !== 'string') throw new FixtureParseError(`${label}[${i}] must be a string`);
    return item;
  });
}

function validateExpectedPage(raw: unknown, caseId: string, idx: number): ExpectedPage {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureParseError(`case ${caseId}: expected_pages[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.slug !== 'string' || obj.slug.length === 0) {
    throw new FixtureParseError(`case ${caseId}: expected_pages[${idx}].slug must be a non-empty string`);
  }
  const type = obj.type === undefined ? undefined : String(obj.type);
  return { slug: obj.slug, type };
}

function validateRequiredFact(raw: unknown, caseId: string, idx: number): RequiredFact {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureParseError(`case ${caseId}: required_facts[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fact !== 'string' || obj.fact.length === 0) {
    throw new FixtureParseError(`case ${caseId}: required_facts[${idx}].fact must be a non-empty string`);
  }
  const ft = obj.fact_type;
  if (ft !== undefined && ft !== 'narrative' && ft !== 'temporal' && ft !== 'structural') {
    throw new FixtureParseError(
      `case ${caseId}: required_facts[${idx}].fact_type must be narrative|temporal|structural`,
    );
  }
  return { fact: obj.fact, fact_type: ft as FactType | undefined };
}

function validateForbiddenFact(raw: unknown, caseId: string, idx: number): ForbiddenFact {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureParseError(`case ${caseId}: forbidden_facts[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fact !== 'string' || obj.fact.length === 0) {
    throw new FixtureParseError(`case ${caseId}: forbidden_facts[${idx}].fact must be a non-empty string`);
  }
  let page_scope: string | null | undefined;
  if (obj.page_scope === null || obj.page_scope === undefined) {
    page_scope = null;
  } else if (typeof obj.page_scope === 'string') {
    page_scope = obj.page_scope;
  } else {
    throw new FixtureParseError(
      `case ${caseId}: forbidden_facts[${idx}].page_scope must be a string or null`,
    );
  }
  return { fact: obj.fact, page_scope };
}

function validateRetrievedChunk(raw: unknown, caseId: string, idx: number): RetrievedChunk {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureParseError(`case ${caseId}: retrieved_context[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.slug !== 'string' || obj.slug.length === 0) {
    throw new FixtureParseError(
      `case ${caseId}: retrieved_context[${idx}].slug must be a non-empty string`,
    );
  }
  if (typeof obj.text !== 'string') {
    throw new FixtureParseError(
      `case ${caseId}: retrieved_context[${idx}].text must be a string`,
    );
  }
  return { slug: obj.slug, text: obj.text };
}

function validateExpectedLink(raw: unknown, caseId: string, idx: number): ExpectedLink {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureParseError(`case ${caseId}: expected_links[${idx}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const field of ['from', 'to', 'type'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      throw new FixtureParseError(
        `case ${caseId}: expected_links[${idx}].${field} must be a non-empty string`,
      );
    }
  }
  return { from: obj.from as string, to: obj.to as string, type: obj.type as string };
}
