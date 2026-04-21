/**
 * Retrieval-stage adapter for the pbrain eval harness.
 *
 * Thin shim over src/core/search/eval.ts — converts a v0.4.0 fixture envelope
 * (kind: 'retrieval') into the EvalQrel[] shape that runEval() already consumes.
 * No behavior change to the primitive; the primitive still owns
 * P@k / R@k / MRR / nDCG@k and the hybrid-search orchestration.
 *
 * Legacy `pbrain eval --qrels <path>` goes straight through parseQrels and
 * never touches this adapter. This file exists exclusively for the new
 * `pbrain eval retrieve --fixtures <path>` entry point.
 */

import { parseFixture, type AnyFixture, type RetrievalCase, FixtureParseError } from './fixtures.ts';
import type { EvalQrel } from '../search/eval.ts';

/**
 * Load a retrieval fixture and return its cases in EvalQrel shape.
 * Throws FixtureParseError if the envelope is malformed or kind isn't 'retrieval'.
 */
export function loadRetrievalFixture(input: string): EvalQrel[] {
  const env: AnyFixture = parseFixture(input);
  if (env.kind !== 'retrieval') {
    throw new FixtureParseError(
      `expected kind=retrieval, got kind=${env.kind} (use \`pbrain eval ${env.kind}\` instead)`,
    );
  }
  return env.cases.map(toQrel);
}

/**
 * Project a RetrievalCase onto the EvalQrel shape. RetrievalCase and EvalQrel
 * are field-for-field aligned today; this function exists so any future
 * envelope/primitive drift produces a type error here instead of a silent
 * shape mismatch at the primitive boundary.
 */
function toQrel(c: RetrievalCase): EvalQrel {
  return {
    id: c.id,
    query: c.query,
    relevant: c.relevant,
    grades: c.grades,
  };
}
