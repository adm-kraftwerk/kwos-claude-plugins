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

/**
 * Ein Melder, der ein Problem EINMAL nennt -- beim Beginn, und dann erst wieder bei der Erholung.
 *
 * Warum: ein Neustart des Gateways ist in Sekunden vorbei, aber ein Empfänger meldet jeden
 * fehlgeschlagenen Versuch (2/4/8/16/30 s) und die Kanal-Liste jede Runde (15 s). Nach einer Minute
 * Ausfall stehen dann Dutzende Zeilen im Protokoll, von denen keine etwas sagt, was nicht schon in
 * der ersten stand. Umgekehrt darf das Ende nicht verschwiegen werden: "läuft wieder" ist die eine
 * Zeile, die man nach einem Ausfall sucht.
 *
 * Der Aufrufer nennt einen SCHLÜSSEL je Gegenstand (die Kanal-Kennung, die Strom-Adresse): zwei
 * Kanäle, die unabhängig ausfallen, sind zwei Meldungen und keine doppelte.
 */
export function createStateReporter(writer = log) {
  const failing = new Set();
  return {
    /** Meldet einen beginnenden Fehler -- und schweigt, solange derselbe Schlüssel ausfällt. */
    failed(key, message, extra) {
      if (failing.has(key)) return;
      failing.add(key);
      writer.error(message, { ...extra, state: "failed" });
    },
    /** Meldet die Erholung -- nur, wenn für diesen Schlüssel ein Fehler gemeldet war. */
    recovered(key, message, extra) {
      if (!failing.delete(key)) return;
      writer.info(message, { ...extra, state: "recovered" });
    },
    /** Vergisst einen Schlüssel ohne Meldung (der Gegenstand ist weg, nicht gesund). */
    forget(key) {
      failing.delete(key);
    },
  };
}
