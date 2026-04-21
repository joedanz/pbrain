---
slug: reading-notes/attention-is-all-you-need
type: reading-note
title: "Reading Notes: Attention Is All You Need (Vaswani et al., 2017)"
date: 2026-03-22
source_type: paper
authors_of_source:
  - ashish-vaswani
  - noam-shazeer
---

# Attention Is All You Need — Reading Notes

Re-read this today because a v0.4 design discussion kept coming back to
"why does multi-head attention beat a single wider head." Tracking notes in
my own words so I can find them again when the question recurs.

## Core argument

The paper replaces both recurrence (RNNs) and convolutions with pure attention
for sequence transduction. The central mechanism is scaled dot-product
attention: Q·Kᵀ scaled by √d_k, softmaxed, then applied to V. Multi-head
attention runs this in parallel across h heads with separate projections,
then concatenates and projects out.

## Why multi-head matters

A single attention head with d_model dimensions averages across all positions
— it smooths. Multi-head lets different heads specialize: one head learns
syntactic proximity, another learns coreference, another learns positional
regularities. The authors argue this is structurally important, not just a
parameter-efficiency trick. The ablation in section 5.2 backs this up — h=1
underperforms h=8 substantially on translation quality (BLEU -0.9).

## Architectural choices I want to remember

- Position encoding is sinusoidal so the model generalizes to sequences
  longer than those seen in training. Later work (ALiBi, RoPE) revisits this;
  the original sinusoidal choice aged surprisingly well.
- Layer norm placement is pre-attention in the original but every modern
  rewrite moves it pre-residual ("Pre-LN"). Important footnote when reading
  derivative work.
- Dropout applied to attention weights + residuals + embeddings. All three.

## Questions I still have

- Why √d_k specifically? Intuitively it normalizes the variance of the
  dot product as d_k grows, but the proof is tighter in Chen et al 2021.
- The claim that attention is "all you need" has aged well for LLMs but
  vision ended up needing patches + tokens first (ViT, 2020). What's the
  structural difference that kept vision from going attention-native
  immediately? Worth a separate reading thread.

## Timeline

- **2017-06-12** | paper — Vaswani et al published "Attention Is All You Need"
  at NeurIPS, introducing the Transformer architecture
- **2026-03-22** | reading — Re-read during v0.4 eval design to ground
  multi-head intuition for the retrieval reranker discussion
