// Presentation copy for the demo scenarios exposed by the backend (backend/app/workspace.py).
// The backend's own description is always shown as the injected fault; unknown ids fall back to it.
import type { ComponentType } from "react";
import { IconBox, IconCode, IconFileMissing, IconSliders } from "../ui/icons";

export interface ScenarioCopy {
  title: string;
  subtitle: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

const COPY: Record<string, ScenarioCopy> = {
  "code-bug": { title: "Code bug", subtitle: "Faulty change crashes the service", Icon: IconCode },
  "bad-config": { title: "Bad configuration", subtitle: "Invalid config blocks startup", Icon: IconSliders },
  "missing-file": { title: "Missing file", subtitle: "Required data file not in place", Icon: IconFileMissing },
};

export function scenarioCopy(id: string): ScenarioCopy {
  return COPY[id] ?? { title: id, subtitle: "", Icon: IconBox };
}
