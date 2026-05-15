# Context budget (sandcastle-drain / autonomous mode)

This is the AI-specific principle. It applies hardest in autonomous sandcastle-drain runs and as guidance interactively.

The "smart zone" of an LLM context window is well below the technical ceiling. Anthropic's needle-in-a-haystack research shows retrieval accuracy degrades as context fills, with significant drop-off past ~50–60% fill on Claude models. Empirical agentic-loop quality degrades earlier still — most practitioners observe meaningful degradation around 100–200k cumulative usage including tool outputs.

Working in the smart zone means: **keep working contexts small, eject when they grow.**

## The numbers

```ts
// src/orchestrator/config.ts (queued as a follow-up issue)
export const BUDGET = {
  target:  100_000, // info threshold
  ceiling: 150_000, // hard ceiling — split work, do not retry
} as const;
```

Tweak these by editing one file. Single source of truth.

## Issue sizing (when filing or accepting `sandcastle` work)

An issue is "right-sized" if it can be completed in one sandcastle-drain run ending under the **150k ceiling** of cumulative context (issue body + tool outputs + agent thinking + commits + final summary).

Useful proxy heuristics:
- The agent needs to read more than ~5 files
- The agent needs to write more than ~3 files
- The agent needs more than ~10 tool calls in research

If any of those, the issue is probably too big. Split it via `to-issues` before queueing.

## Mechanical post-run measurement

The wrapper at [src/orchestrator/main.ts](../../orchestrator/main.ts) measures every run via Sandcastle 0.5.7's built-in `IterationUsage`:

```ts
const total = result.iterations.reduce((sum, it) => {
  const u = it.usage;
  return sum + u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
}, 0);
```

Action by threshold:
- **Cumulative > 100k (target)** → status comment includes `"context: <N>k (near budget)"`. No label change.
- **Cumulative > 150k (ceiling)** → label `oversized` added; wrapper logs a recommendation to split via `to-issues`.

## Between-iteration abort

When `maxIterations > 1`, the wrapper checks the running total at iteration boundaries. If the next iteration would push past the **150k ceiling**, abort early and let the agent emit a `<promise>COMPLETE</promise>` with what it accomplished.

## Mid-iteration: trust the agent's discipline

Mid-iteration token usage is unmeasured in this rig. The compensating discipline is **summarize-don't-paste** (below) plus the agent's own awareness that long tool outputs compound the next reasoning step's cost.

## Summarize-don't-paste

> **Hard rule for autonomous sandcastle-drain runs.** When tool output isn't needed verbatim downstream, summarize the relevant 3 lines instead of pasting the full output into the next reasoning step.
>
> **Guidance for interactive sessions.** The user can see verbose output and react; mechanical compaction matters less.

Concretely:
- After a `Read` of a long file, write one or two sentences about what's relevant before continuing — don't reason against the entire file in your next thought.
- After a `Bash` of `git log`, summarize the relevant commits — don't quote the output back into context unnecessarily.
- After a long `gh issue view`, restate the question in two lines.

The goal isn't to produce shorter responses to the user. It's to keep the *thinking* section of subsequent steps from carrying unrelated tool output.

## When to commit-and-eject

If the agent notices mid-run that the remaining work won't fit under 150k:
1. Commit what's already complete (one logical unit at a time).
2. Emit `<promise>COMPLETE</promise>` with a "needs split into A and B" note.
3. The wrapper labels the issue `needs-info`; the user re-files split issues from the note.

Do not half-do the rest. A half-finished task that runs over budget produces low-quality output that the next agent run can't easily salvage.

## Retrieval, not regurgitation

Any persistent store (database, wiki, knowledge base) *exists* to keep working context small. When an agent reads from one, the right shape is **read just enough to do the task**, not dump the whole store into context. Index-first retrieval (read an index, drill into specific pages, query for raw quotes only when needed) outperforms embedding-first scattershot recall.

If you build a memory / retrieval system on top of this template, document its shape in an ADR and a per-project principle file — the discipline above (100k / 150k mechanical measurement, summarize-don't-paste) is what creates the pressure to design retrieval well.
