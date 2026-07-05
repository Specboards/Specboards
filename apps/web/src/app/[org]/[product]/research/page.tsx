import { PlanAreaView } from "@/components/plan-area";

export const dynamic = "force-dynamic";

/**
 * Research: the product's discovery repository. The team first chooses where
 * it lives (an external service like SharePoint or Box, pages held in
 * Specboard, or a GitHub repo of Markdown, a later slice).
 */
export default async function ResearchPage({
  params,
}: {
  params: Promise<{ org: string; product: string }>;
}) {
  const { product } = await params;
  return <PlanAreaView area="research" productSlug={product} />;
}
