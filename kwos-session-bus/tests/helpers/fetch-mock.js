// Keine Fremdabhaengigkeit (gleiche Haltung wie die Skript-Testsuite im litellm-Repo: kein
// nock/msw) -- Tests liefern ihr eigenes, minimales Response-Objekt an den handler.
/** Installiert einen Fake-fetch, der jeden Aufruf aufzeichnet; gibt eine restore()-Funktion zurueck. */
export function installFetchMock(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
