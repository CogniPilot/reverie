/**
 * @fileoverview Event-loop lag monitor.
 *
 * Node is single-threaded: any synchronous work (e.g. a blocking `execSync`)
 * freezes the whole event loop, so the HTTP server stops answering on its port
 * while the process stays alive and other ports are unaffected. Such stalls
 * self-heal and never restart the process, so a periodic loopback healthcheck
 * misses them entirely — they leave no trace.
 *
 * This monitor samples how late a fixed-interval timer actually fires versus when
 * it was scheduled; the excess is time the loop was blocked. When that exceeds a
 * threshold it logs the measured stall, turning otherwise-invisible "port briefly
 * unreachable" incidents into a timestamped, quantified log line.
 *
 * @module utils/event-loop-monitor
 */

export interface EventLoopMonitorHandle {
  stop(): void;
}

/**
 * Start sampling event-loop lag.
 *
 * @param sampleMs    How often to sample (and the baseline interval lag is measured against).
 * @param thresholdMs Only stalls at or above this many ms are logged (noise floor).
 * @param log         Sink for stall reports; defaults to console.warn (lands in the web log).
 */
export function startEventLoopMonitor(
  sampleMs = 1000,
  thresholdMs = 1000,
  log: (msg: string) => void = (m) => console.warn(m)
): EventLoopMonitorHandle {
  let last = performance.now();

  const timer = setInterval(() => {
    const now = performance.now();
    // Lag = elapsed beyond the scheduled interval = time the loop was blocked.
    const lag = Math.round(now - last - sampleMs);
    if (lag >= thresholdMs) {
      log(`[EventLoopLag] event loop blocked ~${lag}ms (at ${new Date().toISOString()})`);
    }
    last = now;
  }, sampleMs);

  // Never keep the process alive solely for this monitor.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
