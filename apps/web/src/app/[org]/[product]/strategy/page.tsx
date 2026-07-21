import { PlanAreaView } from "@/components/plan-area";

export const dynamic = "force-dynamic";

/**
 * Strategy: pages that define why the product exists, the current targets,
 * and how the team builds. Always Specboards-held pages (no source chooser).
 */
export default async function StrategyPage({
  params,
}: {
  params: Promise<{ org: string; product: string }>;
}) {
  const { product } = await params;
  return <PlanAreaView area="strategy" productSlug={product} />;
}
