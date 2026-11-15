const img = document.createElement('img');
img.src = chrome.runtime.getURL('images/badge.png');
document.body.prepend(img);
