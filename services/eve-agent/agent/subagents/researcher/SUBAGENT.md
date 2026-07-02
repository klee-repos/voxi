# Subagent: researcher — the deep-research → durable ResearchDossier (PROMPT-QUALITY §3.B)

A **task-mode** subagent that does deep research on a CONFIRMED identity (or, for a hedged reveal, its category)
and produces one **closed, fully-cited `ResearchDossier`** — the single grounded substrate the reveal
(description + 3 facts), the podcast, and the conversation all reuse. It runs OFF the instant-reveal path, so it
never blocks the reveal; its verified facts stream in as `fact` events and land durably on the thread.

## Pipeline

1. **Gather** (web tools): `web_search` / `web_crawl` (Firecrawl) crawl authoritative sources (Wikipedia,
   manufacturer, reputable references) for the subject to real page MARKDOWN. Absent a Firecrawl key → the Vertex
   Gemini Google-Search grounding fallback (still real, on gcloud). Best-effort + timeout-bounded.
2. **Extract** (Gemini over the crawled markdown): 3–6 interesting, checkable facts, EACH with a **verbatim quote**
   copied from the source + the source URL, plus a neutral description. Never outside knowledge — only the fetched
   text.
3. **Verify** (`buildDossier`, the load-bearing part): the **closed provenance loop** admits a fact only when ALL
   hold — `verifyQuote` (the quote is a minimally-normalized substring of the fetched source), `sourceMatchesSubject`
   (the page is about THIS make/model, not a different one), and the honesty gate's **entailment judge over the
   verified quote** (`quote ⊨ fact.text`). Uncited / off-source / unsupported facts are DROPPED — never fabricated
   to hit a count. At `class` scope a fact naming the specific (unconfirmed) make/model is dropped.

## Output schema (enforced — `OUTPUT_SCHEMA`)

`ResearchDossier = { subject, scope:'item'|'class', overview[], facts[], evidence[], sources[], provenance }` where
every fact carries `{text, claimType, evidenceRef, sourceUrl, sourceTitle, quote}` — provable provenance (the
"proof if challenged"). Predicates: every fact has provenance; every fact's evidence claim IS its own verified
quote (the closed loop); ≥3 verified facts is the target (surface survivors if a thin source yields fewer).

## How it's driven

In prod the DRAFT is a bounded AI-SDK `generateText`-with-tools loop (the eve brain, Claude); the pure
`buildDossier(input, proposedDossier, opts)` runs the gate + provenance checks and is unit-tested with a supplied
draft (no creds). The reveal path consumes an injected `DossierProvider` (`providers/live-dossier.ts`), so nothing
depends on the durable eve runtime being self-hosted.

## Non-negotiables

- **Grounding is provable.** Every surfaced fact keeps a `sourceUrl` + verbatim `quote`; nothing ungrounded ships.
- **Scope honesty.** `item` scope only on a CONFIDENT identity; `class` scope (a hedged reveal) never names the
  specific make/model/year.
- Best-effort: a research failure leaves the instant reveal exactly as it was — never a fabricated fact, never a
  blocked reveal.
