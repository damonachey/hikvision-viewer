import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE_VERSION = 1;

// Remembers answers in a JSON file. lifetimesMs sets how long to keep each type of data,
// and is checked on use, so changing a lifetime also applies to answers already saved.
export function createCache({ file, lifetimesMs }) {
  const entries = readEntries();
  const loading = new Map();
  let saving = false;
  let saveAgain = false;

  function isFresh(entry, now) {
    return now - entry.savedAt < (lifetimesMs[entry.type] ?? 0);
  }

  function readEntries() {
    let saved;
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Ignoring the cache file ${file}: ${err.message}`);
      return new Map();
    }
    if (saved?.version !== FILE_VERSION) return new Map();
    const now = Date.now();
    return new Map(Object.entries(saved.entries ?? {}).filter(([, entry]) => isFresh(entry, now)));
  }

  // Writes one at a time, and goes through a temporary file so a crash can't leave half a cache.
  async function save() {
    if (saving) {
      saveAgain = true;
      return;
    }
    saving = true;
    try {
      do {
        saveAgain = false;
        const data = JSON.stringify({ version: FILE_VERSION, entries: Object.fromEntries(entries) }, null, 2);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, data);
        await rename(`${file}.tmp`, file);
      } while (saveAgain);
    } catch (err) {
      // Answers are still remembered until the app restarts.
      console.error(`Could not save the cache file ${file}: ${err.message}`);
    } finally {
      saving = false;
    }
  }

  return {
    // Requests that arrive during a load share its answer. Failures aren't kept, so the
    // next request tries again.
    async get(type, key, load) {
      const id = `${type}:${key}`;
      const entry = entries.get(id);
      if (entry && isFresh(entry, Date.now())) return entry.value;

      const running = loading.get(id);
      if (running) return running;

      const loaded = load().then((value) => {
        // Clearing the cache during a load also discards that load's answer.
        if (loading.get(id) !== loaded) return value;
        loading.delete(id);
        const now = Date.now();
        for (const [otherId, other] of entries) {
          if (!isFresh(other, now)) entries.delete(otherId);
        }
        entries.set(id, { type, savedAt: now, value });
        save();
        return value;
      }, (err) => {
        if (loading.get(id) === loaded) loading.delete(id);
        throw err;
      });
      loading.set(id, loaded);
      return loaded;
    },

    clear() {
      entries.clear();
      loading.clear();
      return save();
    },
  };
}
