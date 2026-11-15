import { nextRun } from './lib/schedule.js';
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('refresh', { when: nextRun() }));
chrome.alarms.onAlarm.addListener(async () => {
  const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=27.7&longitude=85.3&current=temperature_2m');
  await chrome.storage.local.set({ weather: await res.json() });
});
