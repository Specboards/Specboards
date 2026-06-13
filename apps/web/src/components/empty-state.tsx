import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shown on the board views when a workspace has no specs yet — i.e. the first
 * user chose the empty start, or a connected repo hasn't imported anything.
 * Points the user at connecting a GitHub repository (the git-native source of
 * truth) rather than leaving a blank screen.
 */
export function EmptyState({ canConnect = false }: { canConnect?: boolean }) {
  return (
    <Card className="mx-auto mt-8 max-w-lg">
      <CardHeader>
        <CardTitle>No specs yet</CardTitle>
        <CardDescription>
          SpecBoard fills this board from <code>specs/**/spec.md</code> files in a connected
          GitHub repository.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <p>
          {canConnect
            ? "Connect the repository where your specs live — SpecBoard imports every spec and keeps the board in sync on each push."
            : "Once an admin connects the repository where your specs live, features will appear here automatically."}
        </p>
      </CardContent>
    </Card>
  );
}
