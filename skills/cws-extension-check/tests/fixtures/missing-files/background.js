chrome.action.onClicked.addListener(tab => {
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inject.js'] });
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
});
