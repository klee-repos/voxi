# Voxi E2E Test Plan — every feature × every scenario

Maps each plan feature to concrete E2E scenarios, the **layer** (D = deterministic backbone, A = agentic
navigation with deterministic assertions), and the **surface** (W = web/Playwright runs in CI now, I = iOS
native via Maestro/Appium on a Mac, L = live/cred-gated integration). Web rows are implemented as grouped,
runnable assertions inside `e2e/web/run-<area>.web.ts` runners (each row's id is asserted by name in its
runner); iOS rows are `e2e/flows/<id>.yaml` Maestro flows (one per id). "No cheating": every row asserts on
real observable UI/state or real API output. Rows still pending a web assertion are marked **(todo-W)** below.

> Coverage rule (loop-until-dry): the suite is "complete" when the agentic explorer finds **no uncovered
> screen or state** for 2 consecutive rounds AND every row below has a passing deterministic assertion.

## 1. Auth (Clerk) — plan §12
| id | scenario | layer | surface |
|----|----------|-------|---------|
| auth-01 | first launch → email entry → OTP/magic-link → lands on camera | D | W,I,L |
| auth-02 | returning user, persisted session (secure-store) skips sign-in | D | W,I |
| auth-03 | sign-out clears session; protected routes redirect to welcome | D | W,I |
| auth-04 | invalid/expired OTP shows in-persona error, no crash | D | W,L |
| auth-05 | magic-link deep-link opens app to authed state | A | I,L |
| auth-06 | BFF rejects request with missing/forged JWT (401), valid JWT passes | D | W,L |

## 2. Camera capture + first-run — §10.2 screens 2–3
| cam-01 | first-run "Meet Voxi" + camera/mic permission priming before OS prompt | D | I |
| cam-02 | camera-permission-denied state → recovery CTA to Settings | D | I |
| cam-03 | shutter captures → uploads via signed URL → processing begins | A | I,L |
| cam-04 | low-light/blurry frame → quality gate prompts retake (no embed spend) | D | I |
| cam-05 | face-dominant frame → "objects, not people" refusal, no upload | D | I,L |

## 3. Processing (event-driven, 3 terminal outcomes) — §10.2.4 / D7
| proc-01 | terminal = REVEAL: constellation → card rises | A→D | W,I |
| proc-02 | terminal = PARTIAL: amber "confident maybe", does NOT silently mutate | D | W,L |
| proc-03 | terminal = INTERVIEW (<0.5 conf): orb→curious, Q&A opens | D | W,L |
| proc-04 | >8–12s wait → Voxi acknowledges in-persona; no dead spinner | D | W |
| proc-05 | network-drop mid-pipeline → reconnect via ?startIndex=, resumes | D | W,L |
| proc-06 | hard failure (quota/refusal) → in-persona failure state + next action | D | W |

## 4. Identification cascade + arbitration — §5
| id-01 | confident exact make/model/year on a seeded catalog hit (instant, free) | D | W,L |
| id-02 | catalog miss → web-grounded verify → CONFIDENT | A→D | L |
| id-03 | catalog↔web disagreement → downgrade to PROBABLE, both candidates shown | D | W,L |
| id-04 | unknown → routes to interview; new entry minted with capture exemplar | D | W,L |
| id-05 | "show me the badge" multi-photo capture path narrows the year | A | I,L |
| id-06 | **never surfaces Stage-1 output unverified** (assert no claim before verify) | D | L |

## 5. Reveal card — §10.2.5 / D5
| reveal-01 | leads with specific title + band-colored confidence chip (not photo-hero) | D | W |
| reveal-02 | one primary action; "Add a tip" is secondary; "How sure?" hidden when CONFIDENT | D | W |
| reveal-03 | "How sure?" auto-elevates in PROBABLE; evidence panel reads as Voxi "working" | D | W |
| reveal-04 | confidence chip color ≠ safety-refusal color (warm gold vs caution) | D | W |
| reveal-05 | user correction of the ID feeds the catalog (writes a correction) | D | W,L |

## 6. Podcast — §6.2
| pod-01 | "Generate story" → "composing" wait (15–40s honest) → plays | A→D | W,L |
| pod-02 | two-host transcript highlights line-by-line; Arlo/Mave visually distinct | D | W |
| pod-03 | second viewer of same catalog item streams cached audio (no regen) | D | W,L |
| pod-04 | report-episode control present; flagged episode invalidates cache | D | W |
| pod-05 | **honesty: no fabricated spec/provenance** in script (claim-gate eval) | D | L |
| pod-06 | defamation filter drops negative-about-entity claim lacking ≥2 sources | D | L |
| pod-07 | worker idempotency: duplicate Cloud Task → exactly one render | D | L |

## 7. Conversation (voice + text) — §6.3
| conv-01 | default opens full-screen orb voice (push-to-talk) + live-mic indicator | D | I |
| conv-02 | toggle to keyboard; defined in-flight-turn behavior | D | W,I |
| conv-03 | voice turn round-trips with the SAME Voxi ElevenLabs voice as description | A→D | I,L |
| conv-04 | tool call mid-chat (catalog lookup) returns grounded answer | A | L |
| conv-05 | voice-minutes-exhausted → hard-cutoff w/ in-persona message + paywall | D | I,L |
| conv-06 | transcript write-back: reopened thread replays the exact conversation | D | W,L |
| conv-07 | vendor outage → degrades to keyboard mode, not a dead screen | D | L |

## 8. Threads / collection — §10.2.9
| thread-01 | empty-collection state ("0 of ∞") with capture CTA | D | W |
| thread-02 | populated grid + auto-titled, date-grouped threads | D | W |
| thread-03 | revisit a thread → durable eve session continues (history intact) | D | W,L |
| thread-04 | collection/retention mechanic surfaces "uncatalogued near you" | A | I |

## 9. Interview + contributions + moderation — §7
| kb-01 | interview capped at 2–3 Qs, skip/later, thread kept on bail | D | W |
| kb-02 | shared/private toggle defaults private; consent before global exemplar | D | W,L |
| kb-03 | add-a-tip TL0 → "a moderator will review"; TL2+ → "live now" | D | W,L |
| kb-04 | report a catalog entry/tip → auto-hide on first report (<24h SLA met) | D | W,L |
| kb-05 | sybil promotion guard: N weighted distinct users required for global | D | L |
| kb-06 | prompt-injection in a tip/OCR cannot steer tools or moderation | D | L |

## 10. Safety / honesty / legal — §8 / §15
| safe-01 | pill/medical → hard non-identifying refusal, no make/model generated | D | L |
| safe-02 | weapon → category-only naming, follow-up loop also suppressed | D | L |
| safe-03 | NSFW image blocked before persona sees it | D | L |
| safe-04 | face/plate redacted before embed/store (assert stored artifact redacted) | D | L |
| safe-05 | honesty: ungrounded numeric spec never asserted (golden set) | D | L |
| safe-06 | account deletion cascades (photos+embeddings+sessions+contributions) | D | L |

## 11. Subscriptions / metering — §13 / §6.4
| sub-01 | free-tier scan cap reached → in-persona limit screen (refusals don't count) | D | W,I |
| sub-02 | entitlement check before paid generation (BFF atomic decrement) | D | L |
| sub-03 | paywall (StoreKit 2 direct, no vendor) renders; restore purchases | D | I |
| sub-04 | global/per-vendor spend kill-switch halts paid actions | D | L |

## 12. Accessibility — §10.3
| a11y-01 | reduce-motion swaps particle sequences for cross-fade; orb stilled | D | W,I |
| a11y-02 | contrast AA on dark shell + parchment (amber-chip, text-on-gradient) | D | W |
| a11y-03 | every Voxi spoken turn has a text transcript (VoiceOver/caption path) | D | W,I |
| a11y-04 | Dynamic Type scales serif within clamps; 44pt min touch targets | D | I |

## 13. Backend durability / infra — §4
| infra-01 | eve session resume after poller instance kill (G3 falsifier) | D | L |
| infra-02 | multi-poller SKIP-LOCKED: no double-processed step under load | D | L |
| infra-03 | signed URL: short TTL, user-bound, non-enumerable; cross-tenant read denied | D | L |
| infra-04 | visibility-filter ACL cannot be bypassed (search/vector/bridge) | D | L |

## Agentic exploration suites (generate + harden coverage)
| explore-01 | goal-driven sweep of all 12 screens × {offline,error,empty,permission} | A | W |
| explore-02 | object-variation sweep (10 seed objects → confident/partial/unknown mix) | A | W,L |
| explore-03 | completeness critic: report any screen/state with no deterministic assertion | A | W |
