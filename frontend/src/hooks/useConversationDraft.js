import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

function createDraftStore(organizationId, userId) {
  const prefix = `crm:chat-draft:${organizationId}:${userId}:`;
  const timePrefix = `crm:chat-draft-edited:${organizationId}:${userId}:`;
  const listeners = new Map();
  const orderListeners = new Set();
  const unsaved = new Map();
  const sending = new Set();
  let order = new Map();
  let latest = 1; // Drafts saved before ordering was introduced share rank 1.

  function storedRank(id) {
    if (!read(id).trim()) return 0;
    return Number(localStorage.getItem(timePrefix + id)) || 1;
  }

  if (organizationId != null && userId != null) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        const rank = storedRank(id);
        if (rank) order.set(id, rank);
        latest = Math.max(latest, rank);
      }
    } catch { /* Storage may be unavailable in this tab. */ }
  }

  function setRank(id, rank) {
    if ((order.get(id) || 0) === rank) return;
    order = new Map(order);
    if (rank) order.set(id, rank);
    else order.delete(id);
    latest = Math.max(latest, rank);
    orderListeners.forEach(listener => listener());
  }

  function notify(id) {
    listeners.get(id)?.forEach(listener => listener());
  }

  function read(id) {
    if (unsaved.has(String(id))) return unsaved.get(String(id));
    try { return localStorage.getItem(prefix + id) ?? ''; }
    catch { return ''; }
  }

  function update(id, value) {
    const current = read(id);
    const next = typeof value === 'function' ? value(current) : value;
    if (next === current) return;
    const key = String(id);
    const previousRank = order.get(key) || 0;
    let rank = 0;
    if (next.trim()) {
      rank = previousRank > 1 && previousRank === latest ? previousRank : Math.max(Date.now(), latest + 1);
    }
    try {
      if (next) localStorage.setItem(prefix + id, next);
      else localStorage.removeItem(prefix + id);
      if (rank !== previousRank) {
        if (rank) localStorage.setItem(timePrefix + id, String(rank));
        else localStorage.removeItem(timePrefix + id);
      }
      unsaved.delete(key);
    } catch {
      // Keep editing in this tab when the browser cannot persist the draft.
      unsaved.set(key, next);
    }
    setRank(key, rank);
    notify(key);
  }

  function onStorage(event) {
    if (event.storageArea !== localStorage) return;
    if (event.key === null) {
      unsaved.clear();
      order = new Map();
      orderListeners.forEach(listener => listener());
      listeners.forEach((_, id) => notify(id));
    } else if (event.key.startsWith(prefix) || event.key.startsWith(timePrefix)) {
      const id = event.key.slice(event.key.lastIndexOf(':') + 1);
      unsaved.delete(id);
      setRank(id, storedRank(id));
      notify(id);
    }
  }

  return {
    read, update, onStorage,
    getOrder: () => order,
    subscribeOrder(listener) {
      orderListeners.add(listener);
      return () => orderListeners.delete(listener);
    },
    subscribe(id, listener) {
      const key = String(id);
      if (!listeners.has(key)) listeners.set(key, new Set());
      const group = listeners.get(key);
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
      };
    },
    isSending: id => sending.has(id),
    setSending(id, active) {
      if (active) sending.add(id);
      else sending.delete(id);
      notify(String(id));
    },
  };
}

export function useConversationDraftStore(organizationId, userId) {
  const store = useMemo(() => createDraftStore(organizationId, userId), [organizationId, userId]);
  useEffect(() => {
    window.addEventListener('storage', store.onStorage);
    return () => window.removeEventListener('storage', store.onStorage);
  }, [store]);
  return store;
}

export function useConversationDraft(store, id, read = store.read) {
  const subscribe = useCallback(listener => store.subscribe(id, listener), [store, id]);
  return useSyncExternalStore(subscribe, () => read(id));
}
