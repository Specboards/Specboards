import { SKILL_SURFACE_LABELS, type Skill } from "@/lib/ai/skills";
import { getAppDb } from "@/lib/db";
import { listSkills } from "@/lib/skills-service";

import { McpToolError, optionalString, type McpTool } from "./types";

/**
 * Letting a connected agent read the workspace's own procedures.
 *
 * ── Why an agent should not bring its own ───────────────────────────────────
 * A skill is how a team has written down what "ready" means to them, what
 * questions a definition has to survive, and what their release notes are
 * allowed to say. The native assistant runs under those instructions. A
 * connected agent working the same board under instructions of its own
 * produces work that is competent and in the wrong shape, and the team has no
 * way to correct it except by correcting the output every time.
 *
 * This is the lesson the two documented precedents agree on. Linear's Agent
 * Interaction Guidelines and the AGENTS.md convention both put the procedure
 * in the workspace rather than in the agent, so that changing how a team works
 * is one edit rather than a negotiation with every tool they have connected.
 *
 * ── Why the instructions come back in full ──────────────────────────────────
 * Returning names and descriptions would make this a menu, and a menu is
 * useless here: the agent is not choosing a button to press, it is trying to
 * follow the procedure. The instruction text IS the deliverable, so it is sent
 * whole. It is the team's own writing, being handed to an agent the team
 * connected, under a scope they granted.
 *
 * ── Why disabled skills are not listed ──────────────────────────────────────
 * Switched off means the team decided their assistant should not do that. An
 * agent reading the list would have no way to know the difference, and the
 * only use for the extra rows would be to follow a procedure the team
 * withdrew. `findEnabledSkill` makes the same call for the same reason.
 */

const NO_DB =
  "Skills are stored in a database, which this deployment does not have " +
  "(local file mode).";

/** What one skill looks like on the wire. */
function shape(skill: Skill) {
  return {
    key: skill.key,
    name: skill.name,
    description: skill.description,
    // The whole point of the tool. See the module note.
    instructions: skill.instructions,
    surface: skill.surface,
    surfaceLabel: SKILL_SURFACE_LABELS[skill.surface],
    // Told apart so an agent can say whose procedure it followed. A team's own
    // skill is a local convention and worth naming as one; a built-in it has
    // not touched is ours and carries no signal about how this team works.
    origin: skill.builtIn
      ? skill.customised
        ? ("customised" as const)
        : ("built-in" as const)
      : ("workspace" as const),
  };
}

export const SKILL_TOOLS: McpTool[] = [
  {
    name: "list_skills",
    description:
      "Read this workspace's skills: the standing instructions its team has " +
      "written for working on their board. Each one carries its full " +
      "instruction text, the surface it applies to (`item` for work items and " +
      "specs, `release` for release notes), and whether it is one of ours or " +
      "the team's own. Call this BEFORE drafting a spec, grilling a " +
      "definition or writing release notes, and follow the matching skill " +
      "rather than your own method: these are how this team defines work, and " +
      "work done to a different standard has to be redone. A skill the team " +
      "has switched off is not listed. `origin` is `workspace` for a skill " +
      "they wrote, `customised` for one of ours they rewrote, and `built-in` " +
      "for one they left alone.",
    inputSchema: {
      type: "object",
      properties: {
        surface: {
          type: "string",
          enum: ["item", "release"],
          description:
            "Only the skills for this surface. Omit for all of them.",
        },
      },
      additionalProperties: false,
    },
    write: false,
    // Its own resource, and it is a read of the same rows the REST route at
    // /api/v1/assistant-skills serves, so one key behaves the same over both
    // surfaces. Separate from `assistant` because reading the procedures costs
    // nothing and asking a question spends the workspace's inference budget.
    scope: { resource: "assistant-skills", action: "read" },
    run: async (args, ctx) => {
      const db = getAppDb();
      if (!db || !ctx.scope) throw new McpToolError(NO_DB);

      const surface = optionalString(args, "surface");
      const skills = (await listSkills(db, ctx.scope)).filter((s) => s.enabled);
      const wanted = surface
        ? skills.filter((s) => s.surface === surface)
        : skills;

      return {
        skills: wanted.map(shape),
        // Said explicitly rather than left to be inferred from an empty array,
        // which reads as "this team has no conventions" when it may mean the
        // filter matched nothing.
        note:
          wanted.length === 0
            ? surface
              ? `This workspace has no skills for the ${surface} surface.`
              : "This workspace has no skills switched on."
            : "Follow the skill that matches what you are doing. These are this team's instructions, not suggestions.",
      };
    },
  },
];
