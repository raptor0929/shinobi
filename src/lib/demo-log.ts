export type DemoLogLevel = "info" | "ok" | "warn" | "error";

export type DemoLogEntry = {
  id: string;
  at: string;
  level: DemoLogLevel;
  message: string;
  detail?: string;
};

export function makeLogEntry(
  level: DemoLogLevel,
  message: string,
  detail?: string,
): DemoLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    level,
    message,
    detail,
  };
}
