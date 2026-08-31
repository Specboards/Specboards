/**
 * Workspace settings, in local file mode: constants, and why they are constants.
 *
 * Nothing here reads a file, so nothing here takes the store. The transition
 * mode is always flexible, because a solo dogfooding session is the case that
 * least wants a rigid pipeline and there is no workspace row to hold a
 * different answer. There is one product, so nothing can override anything and
 * `cardsOverrides` is all false.
 *
 * That is a real answer rather than a stub: a caller asking "is this product
 * overriding the workspace default" gets the truth, which in a store with one
 * product is always no.
 */

import {
  type CardsOverrides,
  type TransitionMode,
  type TransitionModeSettings,
  type WorkspaceScope,
} from "../types";

/**
 * Local file mode has no workspace row to hold the setting, and a solo
 * dogfooding session is the case that least wants a rigid pipeline, so it is
 * always flexible. Teams that want a strict pipeline are running the DB mode.
 */
export async function getTransitionMode(
  _scope?: WorkspaceScope,
  _productId?: string | null,
): Promise<TransitionMode> {
  return "flexible";
}

export async function listTransitionModes(
  _scope?: WorkspaceScope,
): Promise<TransitionModeSettings> {
  return { workspaceDefault: "flexible", overrides: {} };
}

/** One product, nothing to inherit from: nothing is ever an override. */
export async function cardsOverrides(): Promise<CardsOverrides> {
  return {
    transitionMode: false,
    stages: false,
    stageGates: false,
    properties: false,
    detailTemplates: false,
    cardFields: false,
    levelTemplates: false,
  };
}

export async function setTransitionMode(
  mode: TransitionMode | null,
  _scope?: WorkspaceScope,
  _productId?: string | null,
): Promise<TransitionMode> {
  if (mode !== "flexible") {
    throw new Error(
      "Local file mode is always flexible; set transitions per workspace in the hosted app.",
    );
  }
  return mode;
}
