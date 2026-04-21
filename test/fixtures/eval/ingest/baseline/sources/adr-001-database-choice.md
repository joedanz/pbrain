---
slug: decisions/adr-001-database-choice
type: decision
title: "ADR-001: Database Choice for the PBrain Pipeline"
date: 2026-02-14
authors:
  - joe
  - sarah-chen
status: accepted
---

# ADR-001: Database Choice for the PBrain Pipeline

## Context

We need a database that supports both relational queries over page metadata and
vector search over chunk embeddings. The ingest pipeline writes ~1k-10k pages
per brain, with chunks in the 10k-100k range. Hybrid search (keyword + vector
with Reciprocal Rank Fusion) needs both capabilities cheaply.

Candidates evaluated:
- **Postgres + pgvector**: SQL-native, mature, one dependency. pgvector's HNSW
  index handles ~100k vectors at p95 ~50ms.
- **SQLite + sqlite-vss**: embedded, zero-config, but the vector index is
  experimental and Postgres's pg_trgm (for keyword fuzzy matching) has no
  SQLite-native equivalent at parity.
- **DuckDB**: great for analytics, but no mature vector extension and the
  concurrency story for a long-running agent is weaker.

## Decision

We chose **Postgres with pgvector** for pbrain's production engine path, with
**PGLite** (embedded Postgres via WASM) as the zero-config default for solo
users. The chunking pipeline writes to the same schema shape in both engines,
so the user can migrate between them without data loss via `pbrain migrate`.

Primary reason: pgvector gives us HNSW vector search **and** real Postgres
features — transactions, triggers, JSONB, trigrams — in one system. We don't
have to bolt a vector store onto a relational store.

## Consequences

- Setup cost for solo users is zero: PGLite ships in the binary, no external
  service required.
- Scale path is clear: migrate to Supabase (managed Postgres + pgvector) when
  the brain exceeds ~1000 pages.
- We accept that PGLite's WASM runtime is single-connection, so long-running
  background jobs need explicit lock coordination (`pbrain-lock.ts`).

## Timeline

- **2026-02-14** | decision — Chose Postgres + pgvector over SQLite and DuckDB
- **2026-02-18** | implementation — PGLiteEngine and PostgresEngine both
  landed behind `src/core/engine.ts` abstraction
- **2026-03-02** | validation — Hybrid search eval confirmed pgvector + pg_trgm
  outperforms vector-only on senior-dev query fixtures
