const SENSITIVE_QUERY = /(?:^|[?&#;])(?:x-amz-[^=&#;]*|x-goog-[^=&#;]*|sig|signature|token|access_token|refresh_token|id_token|api[_-]?key|key|credential|authorization|password|secret)=/i;

/** Redact credentials from diagnostic text, never from persisted project data. */
export function redactDiagnosticText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    let decoded = value;
    for (let i = 0; i < 2; i++) {
      try { decoded = decodeURIComponent(decoded); } catch { break; }
    }
    const sensitive = SENSITIVE_QUERY.test(decoded.replace(/&amp;/gi, "&"));
    try {
      const url = new URL(value);
      if (!sensitive && !url.username && !url.password) return value;
      url.username = "";
      url.password = "";
      if (sensitive) {
        url.search = "";
        url.hash = "";
      }
      return `${url.toString()}${sensitive ? "?[REDACTED]" : ""}`;
    } catch {
      return sensitive ? `${value.split(/[?#]/, 1)[0]}?[REDACTED]` : value;
    }
  }).replace(/\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"'<>]+/gi, "$1[REDACTED]");
}

const DIAGNOSTIC_KEY = /^(?:error|errors|warning|warnings|message|messages|stackTrace|diagnostics|compiler|reason|detail)$/i;
const DIAGNOSTIC_TOOLS = new Set([
  "get_console_logs", "check_import_status", "wait_for_unity_compile",
  "execute_editor_menu_item", "get_unity_command_status", "get_unity_test_results",
]);

export function redactToolDiagnostics(tool: string, value: unknown): unknown {
  const visit = (item: unknown, diagnostic: boolean): unknown => {
    if (typeof item === "string") return diagnostic ? redactDiagnosticText(item) : item;
    if (Array.isArray(item)) return item.map((child) => visit(child, diagnostic));
    if (!item || typeof item !== "object") return item;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) =>
      [key, visit(child, diagnostic || DIAGNOSTIC_KEY.test(key))]));
  };
  return visit(value, DIAGNOSTIC_TOOLS.has(tool));
}
