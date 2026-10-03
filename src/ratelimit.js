// Fixed-window in-memory limiter. Fine for a single process; use a shared store if you scale out.
export function createLimiter(now = Date.now) {
  const buckets = new Map();
  return {
    hit(key, max, windowMs) {
      const t = now();
      const e = buckets.get(key);
      if (!e || e.reset <= t) {
        buckets.set(key, { n: 1, reset: t + windowMs });
        if (buckets.size > 10000) for (const [k, v] of buckets) if (v.reset <= t) buckets.delete(k);
        return true;
      }
      e.n++;
      return e.n <= max;
    },
  };
}
