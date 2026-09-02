/**
 * What to tell someone when their own model endpoint refused or could not be
 * reached.
 *
 * Separated from the component and exported so it can be tested directly: the
 * whole reason the adapter returns a `kind` instead of a string is that these
 * five failures need five different actions from the reader, and getting that
 * mapping wrong is invisible until a customer is stuck.
 *
 * `settingsLink` is the discriminator that matters: it is only true where the
 * fix is in Specboards. Sending someone to a settings page when their provider
 * is rate-limiting them wastes their time and teaches them to distrust the
 * message.
 */
export function assistantErrorAdvice(
  kind: string,
  message: string,
): { text: string; settingsLink: boolean } {
  switch (kind) {
    case "not_configured":
      return { text: message, settingsLink: true };
    // Not a failure at either end: this workspace decided beforehand how much it
    // was willing to spend and that decision has now been enforced. The message
    // already names the cap, what is left of it, and who can raise it, so it is
    // passed through rather than rewritten, and it links to where that happens.
    case "capped":
      return { text: message, settingsLink: true };
    case "auth":
      return {
        text: "The model endpoint rejected the stored key. It may have been revoked or rotated at the provider.",
        settingsLink: true,
      };
    case "model":
      return {
        text: "The endpoint does not serve the model this workspace is configured to use.",
        settingsLink: true,
      };
    case "quota":
      return {
        text: "The provider says this account is out of credit or has hit a spend cap. Waiting will not clear it; someone has to sort it out with the provider.",
        settingsLink: false,
      };
    case "rate_limit":
      return {
        text: "The provider is rate-limiting or overloaded. Trying again shortly usually works.",
        settingsLink: false,
      };
    case "unreachable":
    case "blocked":
      return { text: message, settingsLink: true };
    default:
      return { text: message, settingsLink: false };
  }
}
