// Example job: everything in one connection, so the browser asks "Allow?" once.
//   node cdp.mjs run example-job.mjs "claude code skills"
export default async function ({ page, log, args }) {
  const query = args[0] || 'chrome devtools protocol';
  const p = await page({ url: 'https://duckduckgo.com/' }); // new tab; the user's tabs stay untouched
  await p.click('input[name="q"]');
  await p.type(query);
  await p.key('Enter');
  await p.waitFor(`document.querySelectorAll('[data-testid="result-title-a"]').length > 3`);
  const results = await p.eval(`[...document.querySelectorAll('[data-testid="result-title-a"]')]
    .slice(0, 5).map(a => ({ title: a.textContent.trim(), url: a.href }))`);
  log('top results:'); console.table(results);
  await p.screenshot('results.png');
  log('saved results.png');
  await p.close();
}
