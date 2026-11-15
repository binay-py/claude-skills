importScripts('https://cdn.example.org/lib.js', 'local-lib.js');
import { x } from './x.js';
const last = localStorage.getItem('last');
chrome.browserAction.setBadgeText({ text: '1' });
setTimeout("refresh()", 1000);
chrome.storage.local.set({ last, x });
