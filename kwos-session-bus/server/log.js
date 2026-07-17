// stdout ist für das MCP-JSON-RPC-Protokoll reserviert (stdio-Transport) — jegliches
// Logging MUSS auf stderr laufen, sonst korrumpiert es den Protokoll-Stream.
function write(level, message, extra) {
  const entry = { level, message, time: new Date().toISOString(), ...extra };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const log = {
  info: (message, extra) => write("info", message, extra),
  error: (message, extra) => write("error", message, extra),
};
