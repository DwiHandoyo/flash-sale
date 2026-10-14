import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Node 25+ defines its own localStorage global (unusable without --localstorage-file) that
// shadows the DOM one. Swap in an in-memory Storage so tests behave the same on every Node.
if (typeof globalThis.localStorage?.clear !== 'function') {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
