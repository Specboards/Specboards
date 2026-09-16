import { getAppDb } from "@/lib/db";
import { openRun, reportRun } from "@/lib/runs/service";
import {
  parseReportedStatus,
  parseStep,
  parseSummary,
  parseTrigger,
  RunForbiddenError,
  RunInputError,
  RUN_TRIGGERS,
} from "@/lib/runs/types";

import { McpToolError, requireUuid, type McpTool } from "./types";

/**
 * Letting a connected agent say what it is doing.
 *
 * ── Why an agent needs this at all ────────────────────────────────────────
 * Before runs existed, an agent working an item over MCP was a sequence of
 * tool calls and nothing else. Nobody could see it happening, read what it
 * had tried, or ask it to stop, and the agent had no way to say it had
 * finished or why it had given up. The item simply changed, or did not.
 *
 * ── Why this is its own scope ─────────────────────────────────────────────
 * `runs:write` lets an agent report progress and change nothing else. That is
 * deliberately the cheapest thing a workspace can grant: an agent should be
 * able to be honest about what it is doing without also being trusted to
 * rewrite the board. Anything it wants to CHANGE goes through a proposal, and
 * proposals are applied by people.
 *
 * ── Hosted only ───────────────────────────────────────────────────────────
 * The stdio server in `apps/mcp` is a separate implementation and stays
 * divergent; it talks to a local file tree with no database, so there is
 * nowhere for a run to live.
 */

const NO_DB =
  "Agent runs need a database, which this deployment does not have " +
  "(local file mode). Work without opening a run.";

export const RUN_TOOLS: McpTool[] = [
  {
    name: "report_run",
    description:
      "Say what you are doing on an item, so a person can see it and stop it " +
      "if they need to. Call it with specId and no runId to open a run, then " +
      "again with that runId as you go. The answer carries any steering note " +
      "a person has left you, delivered once, and tells you if they have " +
      "asked you to stop: when `cancelled` is true, wind up and report " +
      "nothing further. A run records work; it does not change anything. " +
      "Anything you want changed goes through a proposal a person applies.",
    inputSchema: {
      type: "object",
      properties: {
        specId: {
          type: "string",
          description:
            "The item you are working on. Required to open a run; ignored once you have a runId.",
        },
        runId: {
          type: "string",
          description:
            "The run you are reporting on, from a previous call. Omit to open a new one.",
        },
        status: {
          type: "string",
          enum: ["running", "awaiting_input", "succeeded", "failed"],
          description:
            "Where the run is now. `awaiting_input` means you have asked a " +
            "question and stopped; `failed` requires `error`.",
        },
        summary: {
          type: "string",
          description:
            "One line, in your own words, about what you are doing. This is " +
            "what a person sees on the item card, so write it for them.",
        },
        error: {
          type: "string",
          description:
            "Why it failed, written for the person who will read it. Required with status `failed`.",
        },
        step: {
          type: "string",
          description:
            "One thing you just did, appended to the run's trace. A short line.",
        },
        trigger: {
          type: "string",
          enum: [...RUN_TRIGGERS],
          description:
            "What set you off, when opening a run. Defaults to `manual`.",
        },
      },
      required: ["status"],
      additionalProperties: false,
    },
    // A run row is written, so this is a mutating call and counts against the
    // write quota. It commits nothing to git and destroys nothing.
    write: true,
    scope: { resource: "runs", action: "write" },
    run: async (args, ctx) => {
      const db = getAppDb();
      if (!db || !ctx.scope) throw new McpToolError(NO_DB);

      try {
        const status = parseReportedStatus(args.status);
        const step = parseStep(args.step, new Date());

        if (typeof args.runId === "string" && args.runId.trim() !== "") {
          const runId = requireUuid(args, "runId");
          return await reportRun(db, ctx.scope, runId, {
            // The authenticated caller, compared against the run's owner so
            // one agent cannot report against another's run (AR-01).
            actorId: ctx.scope.userId,
            status,
            summary: args.summary,
            error: args.error,
            step,
          });
        }

        const specId = requireUuid(args, "specId");
        const run = await openRun(db, ctx.scope, {
          specId,
          // The caller's own identity. For a service-account connection that
          // is the agent; for a person driving this by hand it is them, and
          // `actorType` says which so the card does not claim a human is a bot.
          agentId: ctx.scope.userId,
          actorType: ctx.role === "service" ? "agent" : "user",
          trigger: parseTrigger(args.trigger),
          summary: parseSummary(args.summary),
          step,
        });

        // An opened run reports itself the same shape a progress call does,
        // so an agent has one response to parse rather than two.
        return {
          runId: run.id,
          status: run.status,
          steer: run.steer,
          cancelled: false,
        };
      } catch (err) {
        // Written for the model to act on, so it must survive the RPC layer's
        // withholding of internal error text.
        // Both are written for the model to act on, so both have to survive
        // the RPC layer's withholding of internal error text.
        if (err instanceof RunInputError) throw new McpToolError(err.message);
        if (err instanceof RunForbiddenError) throw new McpToolError(err.message);
        throw err;
      }
    },
  },
];
