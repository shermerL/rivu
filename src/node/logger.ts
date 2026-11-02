export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;

type LoggerOptions = {
  level?: LogLevel;
  now?: () => Date;
  // Receives one JSON line without its trailing newline.
  write?: (line: string) => void;
};

const priority: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function scalar(value: unknown): value is LogValue {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

export function errorFields(error: Error): LogFields {
  const fields: Record<string, LogValue> = { name: error.name, message: error.message };
  if ("code" in error && scalar(error.code)) {
    fields["code"] = error.code;
  }
  return fields;
}

export function createLogger(scope: string, options: LoggerOptions = {}) {
  const minimum = priority[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  const write = options.write ?? ((line: string) => console.error(line));

  function log(level: LogLevel, event: string, fields: LogFields = {}): boolean {
    if (priority[level] < minimum) return false;
    try {
      const safeFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => scalar(value)));
      write(JSON.stringify({ time: now().toISOString(), level, scope, event, fields: safeFields }));
      return true;
    } catch {
      // Diagnostics must not replace the original operation's failure.
      return false;
    }
  }

  return {
    debug: (event: string, fields?: LogFields) => log("debug", event, fields),
    info: (event: string, fields?: LogFields) => log("info", event, fields),
    warn: (event: string, fields?: LogFields) => log("warn", event, fields),
    error: (event: string, fields?: LogFields) => log("error", event, fields),
  };
}
