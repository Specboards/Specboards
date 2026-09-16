import type { Database } from "@specboards/db";

import { parseAnswer } from "@/lib/ai/proposals";
import type { ModelMessage } from "@/lib/ai/provider";
import {
  buildContext,
  canEditItem,
  resolveAssistantItem,
} from "@/lib/assistant-service";
import { asUser } from "@/lib/db-scope";
import { completeWithWorkspaceModel } from "@/lib/model-provider-service";
import { insertProposal } from "@/lib/proposals/store";
import { findEnabledSkill } from "@/lib/skills-service";
import type { WorkspaceScope } from "@/lib/store/types";

import { openRun } from "./service";
import { patchRun } from "./store";
import { RunInputError, type RunStatus, type RunTrigger, type TraceStep } from "./types";

/**
 * Running a skill with nobody watching.
 *
 * ── Why this is not an assistant turn ───────────────────────────────────────
 * Every skill until now was a chat turn: pressing one posts a question to a
 * conversation, the answer streams into the thread, and any proposal it makes
 * hangs off the message that carried it. That shape assumes a person is sitting
 * in front of it, and three things the harness is for break the assumption. A
 * scheduled run has no thread to post into. A skill fired by an event has
 * nobody to stream to. And an agent identity running a skill is not a
 * participant in somebody's conversation.
 *
 * So a skill can also be a *run*: a row in `agent_runs` that a person can watch
 * and stop, and whose output is a proposal in the review queue rather than a
 * message in a thread. The proposal is where the two paths meet again, which is
 * the property worth keeping: an unattended skill gets no cheaper route to a
 * write than the assistant has, because both end at a row a person applies.
 *
 * ── What it is allowed to change ────────────────────────────────────────────
 * Nothing, and that is inherited rather than re-argued. `runs/service.ts` makes
 * the case: a run records that work happened, and anything it wants changed
 * goes through a proposal. This adds a producer of runs; it adds no new way to
 * write.
 *
 * ── Failure is a finished run, not an exception ─────────────────────────────
 * Almost everything that can go wrong here goes wrong after the run row exists:
 * no model connected, the workspace at its spend cap, the endpoint refusing the
 * key. Throwing would leave a run stuck at `running` forever with no account of
 * why, which is the state the review queue's reconciler exists to clean up and
 * should not be manufacturing more of. Each of those instead finishes the run
 * as `failed` with an error written for a person to read.
 *
 * The exceptions are the two that happen before there is a run to fail: an
 * unknown skill and a skill pointed at the wrong kind of thing. Both are the
 * caller getting it wrong, and both are worth refusing loudly.
 */

/**
 * What a skill run produced.
 *
 * Not exported: `runSkillOnItem`'s signature is the contract, and there is no
 * caller outside this module yet to name the type. The first one that needs it
 * by name can export it then, rather than the export sitting here unused,
 * which is what knip is for.
 */
interface SkillRunOutcome {
  runId: string;
  status: RunStatus;
  /** The proposal it drafted, or null when it had nothing to offer. */
  proposalId: string | null;
  /** Why it failed, written for a person. Null on success. */
  error: string | null;
}

/**
 * Upper bound on the answer.
 *
 * The same budget an interactive turn gets. A run is not a licence to spend
 * more of a workspace's inference on one question because nobody is watching
 * it happen; if anything the reverse, since nobody is watching.
 */
const ANSWER_MAX_TOKENS = 2_000;

/** A trace step, stamped by the server rather than by whatever started it. */
function step(label: string, detail?: string): TraceStep {
  return { at: new Date().toISOString(), label, ...(detail ? { detail } : {}) };
}

/**
 * Run one skill against one item, unattended.
 *
 * `agentId` names the identity the run belongs to, or null when a person
 * started it by hand. It is what `agent_runs_one_active_uq` keys on, so two
 * schedules pointing at the same skill and item collapse to one active run
 * rather than racing, which is the behaviour `openRun` already provides.
 */
export async function runSkillOnItem(
  db: Database,
  scope: WorkspaceScope,
  input: {
    specId: string;
    skillKey: string;
    agentId: string | null;
    trigger: RunTrigger;
  },
): Promise<SkillRunOutcome> {
  const skill = await findEnabledSkill(db, scope, input.skillKey);
  if (!skill) {
    // Deliberately the same answer for "no such skill" and "switched off", as
    // `findEnabledSkill` documents: both mean the same thing to a caller about
    // to run one, and telling them apart is a way to probe for skills the
    // workspace is not offering.
    throw new RunInputError(
      `No skill named "${input.skillKey}" is available in this workspace.`,
    );
  }
  if (skill.surface !== "item") {
    // The turn endpoint already refuses this rather than running it, and for a
    // sharper reason than tidiness: a release-notes skill pointed at a work
    // item does not fail, it produces a confident answer about the wrong thing.
    throw new RunInputError(
      `"${skill.name}" is a ${skill.surface} skill and cannot be run against an item.`,
    );
  }

  const { feature, featureId } = await resolveAssistantItem(
    db,
    scope,
    input.specId,
  );
  const canEdit = await canEditItem(scope, feature);
  // Before `openRun`, and that ordering carries weight: a skill that reads the
  // architecture area refuses here when there is none to read, which is a
  // refusal with no run to fail rather than a run that finished having checked
  // nothing.
  const { systemPrompt, canPropose } = await buildContext(
    db,
    scope,
    feature,
    canEdit,
    skill,
  );

  const run = await openRun(db, scope, {
    specId: input.specId,
    agentId: input.agentId,
    actorType: input.agentId ? "agent" : "user",
    trigger: input.trigger,
    summary: `Running "${skill.name}"`,
    step: step(`Started "${skill.name}"`),
  });

  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt },
    // The skill's own name as the question, never a caller-supplied label: the
    // run's trace is what a person reads afterwards to find out what was asked,
    // so it is written from what the server resolved.
    { role: "user", content: skill.name },
  ];

  const outcome = await completeWithWorkspaceModel(
    db,
    scope.workspaceId,
    { messages, maxTokens: ANSWER_MAX_TOKENS },
    // Attribution, not telemetry: the ledger records whose behalf this spent
    // the workspace's budget on. A scheduled run spends the schedule owner's.
    { userId: scope.userId, feature: "skill_run" },
  );

  if (!outcome.ok) {
    return fail(db, scope, run.id, modelFailure(outcome.error));
  }

  const parsed = parseAnswer(outcome.text);

  // `canPropose` is false when the caller cannot write the item, and when the
  // description was too long to send whole. The second is the one that matters
  // here: a whole-body replacement drafted from a shortened description deletes
  // everything past the cut, and an unattended run has nobody to notice.
  const proposalBody = canPropose ? parsed.proposal : null;

  let proposalId: string | null = null;
  if (proposalBody !== null) {
    const row = await asUser(db, scope.userId, (tx) =>
      insertProposal(tx, {
        workspaceId: scope.workspaceId,
        productId: feature.productId,
        origin: "run",
        runId: run.id,
        // The identity that ran it. A person who pressed the button is named
        // here exactly as an agent would be, because the review queue's
        // question is "who drafted this", not "was a human involved".
        actorId: input.agentId ?? scope.userId,
        actorType: input.agentId ? "agent" : "user",
        kind: "spec_content",
        targetType: "feature",
        targetId: featureId,
        payload: { body: proposalBody },
        baseVersion: null,
      }),
    );
    proposalId = row?.id ?? null;
  }

  const summary = proposalId
    ? `"${skill.name}" proposed a change`
    : `"${skill.name}" finished with nothing to propose`;

  await patchRun(db, scope, run.id, {
    status: "succeeded",
    summary,
    finishedAt: new Date(),
    trace: [
      ...run.trace,
      step(
        summary,
        // The prose half of the answer, which is where a skill that found
        // nothing says why. Losing it would make "nothing to propose"
        // indistinguishable from "the model said nothing at all".
        parsed.prose.slice(0, 2_000),
      ),
    ],
  });

  return { runId: run.id, status: "succeeded", proposalId, error: null };
}

/**
 * Why a completion did not happen, in words a person can act on.
 *
 * `capped` and `not_configured` are told apart from a genuine endpoint failure
 * because they are decisions rather than faults: one is a limit this workspace
 * set for itself, the other is setup nobody has done yet, and reporting either
 * as "the model failed" sends somebody looking for a problem that is not there.
 */
function modelFailure(error: { kind: string; message?: string }): string {
  if (error.kind === "not_configured") {
    return "No model is connected to this workspace, so the skill could not run. Connect one under Settings > Agents.";
  }
  if (error.kind === "capped") {
    return (
      error.message ??
      "This workspace has reached its model spend cap, so the skill did not run."
    );
  }
  return error.message ?? `The model call failed (${error.kind}).`;
}

/** Finish a run as failed, and report it rather than throwing. */
async function fail(
  db: Database,
  scope: WorkspaceScope,
  runId: string,
  error: string,
): Promise<SkillRunOutcome> {
  await patchRun(db, scope, runId, {
    status: "failed",
    error,
    finishedAt: new Date(),
  });
  return { runId, status: "failed", proposalId: null, error };
}
