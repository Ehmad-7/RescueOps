import { API_URL, type HealthState } from "@/lib/api";
import { IconAlert, IconRefresh } from "../ui/icons";
import { Button } from "../ui/primitives";

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(url);

/** Why launching is unavailable and how to fix it. Renders nothing when the backend is ready. */
export default function BackendNotice({ health, onRetry }: { health: HealthState; onRetry: () => void }) {
  if (health.kind === "loading" || (health.kind === "ok" && health.health.gemini_configured)) return null;

  let title: string;
  let hint: string;
  let command: string | null = null;
  if (!API_URL) {
    title = "Frontend is not configured";
    hint = "Set the API URL in frontend/.env.local, then restart the dev server.";
    command = "NEXT_PUBLIC_API_URL=http://localhost:8000";
  } else if (health.kind === "error") {
    title = `Can't reach the API at ${API_URL}`;
    hint = isLocal(API_URL) ? "Start the backend from the repository root, then retry." : "Check the backend deployment and its allowed origins.";
    if (isLocal(API_URL)) command = `cd backend && .venv/bin/uvicorn app.main:app --port ${new URL(API_URL).port || "80"}`;
  } else {
    title = "The backend has no Gemini API key";
    hint = "Set GEMINI_API_KEY in the backend .env and restart the backend.";
  }

  return (
    <div role="alert" className="flex gap-3 border-b border-line bg-warn/[0.06] px-4 py-3 sm:px-5">
      <IconAlert size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-[13px] font-medium text-ink">{title}</p>
          <p className="text-[13px] text-ink-muted">{hint}</p>
        </div>
        {command && (
          <code className="block overflow-x-auto rounded-md border border-line bg-sunken px-3 py-1.5 font-mono text-xs whitespace-pre text-ink">
            {command}
          </code>
        )}
      </div>
      {API_URL && (
        <Button size="sm" icon={<IconRefresh size={13} />} onClick={onRetry} className="self-start">
          Retry
        </Button>
      )}
    </div>
  );
}
