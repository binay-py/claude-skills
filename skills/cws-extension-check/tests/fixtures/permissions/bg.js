chrome.runtime.onMessage.addListener(async (msg) => {
  const { visits = [] } = await chrome.storage.local.get('visits');
  const items = await chrome.history.search({ text: msg.q });
  await chrome.storage.local.set({ visits: [...visits, ...items] });
  chrome.notifications.create({ type: 'basic', title: 'Saved', message: String(items.length), iconUrl: 'icon128.png' });
  if (await chrome.permissions.request({ permissions: ['downloads'] })) chrome.downloads.download({ url: 'data:text/plain,hi', filename: 'visits.txt' });
});
fetch('http://localhost:3000/health');
