export function createCache() {
  const entries = new Map();

  function removeExpired(now) {
    for (const [key, entry] of entries) {
      if (entry.expires <= now) entries.delete(key);
    }
  }

  return {
    // Keeps the promise, so requests that arrive during the first load share its answer.
    // Failures aren't kept, so the next request tries again.
    get(key, ttlMs, load) {
      const now = Date.now();
      const entry = entries.get(key);
      if (entry && entry.expires > now) return entry.value;

      removeExpired(now);
      const value = load();
      entries.set(key, { value, expires: now + ttlMs });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      return value;
    },

    clear() {
      entries.clear();
    },
  };
}
