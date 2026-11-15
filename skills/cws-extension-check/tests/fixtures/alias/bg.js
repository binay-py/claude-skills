const api = globalThis.browser || chrome;
const ext = chrome;
ext.alarms.create('tick', { periodInMinutes: 1 });
api.storage.local.set({ ok: true });
