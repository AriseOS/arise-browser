/**
 * Tab lock management for multi-agent coordination.
 *
 * In-memory lock map: tabId -> { owner, expiresAt }.
 * Expired locks are auto-released on access.
 */

import type { TabLock } from "./types/index.js";

const DEFAULT_TTL_MS = 60_000; // 1 minute

const locks = new Map<string, TabLock>();

export function acquireLock(tabId: string, owner: string, ttlMs = DEFAULT_TTL_MS): TabLock | null {
  cleanup(tabId);

  const existing = locks.get(tabId);
  if (existing) {
    if (existing.owner === owner) {
      existing.expiresAt = Date.now() + ttlMs;
      locks.set(tabId, existing);
      return existing;
    }
    return null; // already locked
  }

  const lock: TabLock = {
    owner,
    expiresAt: Date.now() + ttlMs,
  };
  locks.set(tabId, lock);
  return lock;
}

export function releaseLock(tabId: string, owner: string): boolean {
  cleanup(tabId);
  const existing = locks.get(tabId);
  if (!existing) return false;
  if (existing.owner !== owner) return false;
  locks.delete(tabId);
  return true;
}

export function getLock(tabId: string): TabLock | null {
  cleanup(tabId);
  return locks.get(tabId) ?? null;
}

function cleanup(tabId: string): void {
  const lock = locks.get(tabId);
  if (lock && lock.expiresAt < Date.now()) {
    locks.delete(tabId);
  }
}
