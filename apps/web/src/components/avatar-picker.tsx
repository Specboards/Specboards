"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { ImageUp, Trash2 } from "lucide-react";

import { removeAvatar, uploadAvatar } from "@/lib/api-client/profile";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { updateUser } from "@/lib/auth-client";
import { AVATAR_MAX_EDGE, MAX_AVATAR_BYTES } from "@/lib/avatars";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { StatusLine, type SettingStatus } from "@/components/ui/setting-row";

/**
 * The profile picture: what it is now, and the two ways to change it.
 *
 * Uploading is the path this exists for. Before it, an avatar meant hosting the
 * file somewhere else and pasting a URL, which is why almost nobody had one.
 * The URL field is still reachable behind a disclosure because some people do
 * have a hosted image, and because an OAuth provider may have set one; taking
 * it away would be a regression for them.
 *
 * The picture is not wrapped in a `SettingRow`. It is already showing its own
 * value (the image), and a row that said "Profile picture: [thumbnail] Edit"
 * would be an extra click in front of the thing it is a picture of.
 */
export function AvatarPicker({
  name,
  image,
}: {
  name: string;
  /** Current picture URL: an upload of ours, an external host, or none. */
  image: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<SettingStatus>(null);
  const [urlOpen, setUrlOpen] = useState(false);

  function run(work: () => Promise<string>) {
    startTransition(async () => {
      setStatus(null);
      try {
        setStatus({ kind: "ok", message: await work() });
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "That didn't work.",
        });
      }
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a failure; without this the input
    // holds the old value and the change event never fires a second time.
    e.target.value = "";
    if (!file) return;
    run(async () => {
      const prepared = await downsample(file);
      await uploadAvatar(prepared);
      return "Profile picture updated.";
    });
  }

  function onRemove() {
    run(async () => {
      await removeAvatar();
      return "Profile picture removed.";
    });
  }

  function onSaveUrl(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("image") ?? "").trim();
    run(async () => {
      // The empty string, not undefined: that is how Better Auth is told to
      // clear the column rather than leave it alone.
      const { error } = await updateUser({ image: url });
      if (error) throw new Error(error.message ?? "Couldn't save that URL.");
      setUrlOpen(false);
      return url ? "Profile picture updated." : "Profile picture removed.";
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Avatar name={name} image={image} />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={onFile}
            aria-label="Choose a profile picture"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
          >
            <ImageUp className="size-3.5" />
            {image ? "Change photo" : "Upload photo"}
          </Button>
          {image ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground hover:text-destructive"
              disabled={pending}
              onClick={onRemove}
            >
              <Trash2 className="size-3.5" />
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <StatusLine status={status} />

      {urlOpen ? (
        <form
          onSubmit={onSaveUrl}
          className="space-y-3 rounded-md border bg-muted/20 p-3"
        >
          <FormField
            label="Image URL"
            hint="Points at a picture hosted somewhere else. Leave it empty to go back to your initial."
          >
            <Input
              name="image"
              type="url"
              defaultValue={image ?? ""}
              placeholder="https://…"
            />
          </FormField>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save URL"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setUrlOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="link"
          size="inline"
          className="text-xs"
          onClick={() => setUrlOpen(true)}
        >
          Use an image hosted elsewhere
        </Button>
      )}
    </div>
  );
}

/**
 * Shrink a chosen file to something worth storing, in the browser.
 *
 * The server does no image processing at all, which is the point: adding
 * `sharp` to the runtime image to resize an avatar would be a native dependency
 * and a build-time cost on every deploy, for work a canvas does for free on the
 * machine that already has the file open. A photo straight off a phone is
 * several megabytes and thousands of pixels wide; this returns a square
 * {@link AVATAR_MAX_EDGE}px WebP, typically 20-40 KB.
 *
 * Centre-cropped to a square before scaling, because every place an avatar
 * appears renders it in a circle. Doing the crop here rather than with CSS
 * means the stored bytes match what people see, and nothing has to remember to
 * set `object-fit` at the eleventh call site.
 *
 * Falls back to the original file if anything in the pipeline is unavailable
 * (an exotic browser, an image the decoder refuses). The route's size and type
 * checks then decide, and the user gets a clear error rather than silence.
 */
async function downsample(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const edge = Math.min(bitmap.width, bitmap.height, AVATAR_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    // Source square, centred, at the image's own scale.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, edge, edge);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );
    // A browser without WebP encoding hands back a PNG (or null); either is
    // fine as long as it is small enough to be worth preferring.
    if (blob && blob.size > 0 && blob.size <= MAX_AVATAR_BYTES) return blob;
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** The picture, or the initial-letter placeholder when there isn't one. */
function Avatar({ name, image }: { name: string; image: string | null }) {
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        className="size-16 shrink-0 rounded-full object-cover"
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="flex size-16 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-medium text-muted-foreground">
      {initial}
    </div>
  );
}
