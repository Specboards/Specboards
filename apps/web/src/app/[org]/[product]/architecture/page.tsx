import { PlanAreaView } from "@/components/plan-area";

export const dynamic = "force-dynamic";

/**
 * Architecture: the engineering counterpart to Research. Holds the
 * constitution files for spec-driven development plus service architecture
 * and contracts, with the same choose-your-source setup.
 */
export default async function ArchitecturePage({
  params,
}: {
  params: Promise<{ org: string; product: string }>;
}) {
  const { product } = await params;
  return <PlanAreaView area="architecture" productSlug={product} />;
}
