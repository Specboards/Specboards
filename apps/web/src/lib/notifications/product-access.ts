import {
  and,
  eq,
  features,
  inArray,
  isNull,
  members,
  productMembers,
  products,
  type Database,
} from "@specboards/db";

/**
 * Whether a notification's recipient may actually see the item it is about.
 *
 * Shared by the relay's fan-out and the GitHub review sink, which resolve
 * recipients by completely different routes and had the same hole: both asked
 * whether somebody was in the workspace and neither asked whether they could
 * read the product. Two copies of this rule is how the two would drift, and
 * the drift would be invisible, because the failure is silent on one side and
 * an email on the other.
 */

/** Anything that names a person and the item they are about to be told about. */
export interface Addressee {
  recipientId: string;
  /** Internal `features.id`. */
  featureId: string;
}

/**
 * Anything that can run a read: the relay asks inside its claimed transaction,
 * the review sink on a plain connection. A `PgTransaction` is not assignable to
 * `Database` and both run these queries identically.
 */
type Reader = Pick<Database, "select">;

/**
 * A test for "may this person read the item this notice is about".
 *
 * Mirrors `specboards_can_read_product`, which the inbox query is held to but
 * the fan-out cannot call: that function is SECURITY DEFINER and keyed on
 * `current_setting('app.user_id')`, so it answers for the acting session, and
 * the relay has no acting person. It is acting on behalf of an event.
 *
 * Three ways to be allowed, matching the policy exactly: the item has no
 * product, or you own the workspace, or the product is `org`-visible, or you
 * are a member of it. Resolved in three set queries over the recipients and
 * products actually in play rather than one per person.
 *
 * Failing closed is deliberate. An unknown product, or an item whose row has
 * gone, yields no readers rather than everybody: the whole point here is that
 * a notification is a message about work, and a message about work somebody
 * may not see is worse than no message.
 */
export async function productReaders(
  tx: Reader,
  workspaceId: string,
  targets: readonly Addressee[],
): Promise<(target: Addressee) => boolean> {
  const userIds = [...new Set(targets.map((t) => t.recipientId))];
  const featureIds = [...new Set(targets.map((t) => t.featureId))];

  const [items, owners] = await Promise.all([
    tx
      .select({ id: features.id, productId: features.productId })
      .from(features)
      .where(
        and(
          eq(features.workspaceId, workspaceId),
          inArray(features.id, featureIds),
        ),
      ),
    tx
      .select({ userId: members.userId })
      .from(members)
      .where(
        and(
          eq(members.workspaceId, workspaceId),
          inArray(members.userId, userIds),
          eq(members.role, "owner"),
          isNull(members.deactivatedAt),
        ),
      ),
  ]);

  const productOf = new Map(items.map((i) => [i.id, i.productId]));
  const ownerIds = new Set(owners.map((o) => o.userId));
  const productIds = [
    ...new Set(items.map((i) => i.productId).filter((id): id is string => !!id)),
  ];

  if (productIds.length === 0) {
    return (t) => productOf.get(t.featureId) === null || ownerIds.has(t.recipientId);
  }

  const [open, grants] = await Promise.all([
    tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.workspaceId, workspaceId),
          inArray(products.id, productIds),
          eq(products.visibility, "org"),
        ),
      ),
    tx
      .select({
        productId: productMembers.productId,
        userId: productMembers.userId,
      })
      .from(productMembers)
      .where(
        and(
          inArray(productMembers.productId, productIds),
          inArray(productMembers.userId, userIds),
        ),
      ),
  ]);

  const openIds = new Set(open.map((p) => p.id));
  const granted = new Set(grants.map((g) => `${g.productId}\u0000${g.userId}`));

  return (t) => {
    if (ownerIds.has(t.recipientId)) return true;
    const productId = productOf.get(t.featureId);
    if (productId === undefined) return false; // item vanished; tell nobody
    if (productId === null) return true; // no product, no restriction
    return (
      openIds.has(productId) ||
      granted.has(`${productId}\u0000${t.recipientId}`)
    );
  };
}
