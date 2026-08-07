import { WidePage } from "@/components/page-width";

import { BoardView } from "./board-view";
import { ListView } from "./list-view";

export const dynamic = "force-dynamic";

/**
 * Backlog: the work area. Board (kanban) and List (table) are two views of the
 * same features, selected by `?view=board|list` (default `board`). Using a
 * query param for the view keeps item permalinks — `/backlog/{level}/{specId}`
 * — free of a path collision with the view names. See ADR 0001 (D6) and ADR
 * 0002 (typed item URLs).
 */
export default async function BacklogPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; product: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = (await searchParams).view;
  return (
    <WidePage>
      {view === "list" ? (
        <ListView params={params} searchParams={searchParams} />
      ) : (
        <BoardView params={params} searchParams={searchParams} />
      )}
    </WidePage>
  );
}
