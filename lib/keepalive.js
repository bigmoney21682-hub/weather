// Keeps a free-tier host from spinning the instance down.
//
// Hosts that sleep idle instances count *inbound* requests through their router,
// so the ping has to go out to the public hostname and come back in. Pinging
// 127.0.0.1 never leaves the container and would not reset anything.

const DEFAULT_INTERVAL_MS = 40_000;

/**
 * Start pinging our own public URL. No-ops unless a public URL is known, so
 * local runs and any host that does not advertise one are unaffected.
 *
 * @returns {boolean} whether pinging actually started.
 */
export function startKeepAlive({
  url = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL,
  intervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  path = '/healthz',
} = {}) {
  if (!url) return false;

  const target = new URL(path, url).href;
  let failures = 0;

  const ping = async () => {
    // If one ping is slow, skip it rather than piling requests up behind it.
    const abort = AbortSignal.timeout(Math.min(intervalMs, 10_000));
    try {
      const res = await fetch(target, { method: 'GET', signal: abort });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failures) {
        console.log(`[keepalive] recovered after ${failures} failed ping(s)`);
        failures = 0;
      }
    } catch (err) {
      // A failed ping is not fatal — the next one is 40s away. Log the first
      // few so a permanently broken URL is visible, then go quiet rather than
      // filling the log with one line per interval forever.
      if (++failures <= 3) {
        console.error(`[keepalive] ping ${target} failed: ${err.message}`);
        if (failures === 3) console.error('[keepalive] further failures will be silent');
      }
    }
  };

  // unref so this timer alone never holds the process open during shutdown.
  setInterval(ping, intervalMs).unref();
  return true;
}
