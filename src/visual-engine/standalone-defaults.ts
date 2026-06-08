/**
 * Default sub-agent timeouts shared between the standalone wrapper and the
 * CLI entry point. Kept in their own module so the CLI can import them without
 * pulling in the engine's runtime dependencies (Playwright import graph,
 * sandcastle Docker provider).
 *
 * The values mirror `VISUAL_ENGINE_SUBAGENT_*` in the drain's engine-step
 * helper — the standalone wrapper is meant to run the same execution shape,
 * so a consumer that doesn't override gets the same budget the drain uses.
 */
export const DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS = 300;
export const DEFAULT_SUBAGENT_WALL_CLOCK_TIMEOUT_MS = 30 * 60 * 1000;
