import { redirect } from "next/navigation";

import { ALL_PRODUCTS } from "@/lib/active-product";
import { orgProductPath } from "@/lib/org-path";

export const dynamic = "force-dynamic";

/** Bare `/{org}` → the all-products backlog (its default landing area). */
export default async function OrgHome({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  redirect(orgProductPath(org, ALL_PRODUCTS, "/backlog"));
}
