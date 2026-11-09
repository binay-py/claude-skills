// Example job: everything in one connection, so the browser asks "Allow?" once.
//   node cdp.mjs run example-job.mjs "Headless browser"
export default async function ({ page, log, args }) {
  const query = args[0] || 'Headless browser';
  const p = await page({ url: 'https://en.wikipedia.org/wiki/Main_Page' }); // new tab; your tabs stay untouched
  log('opened Wikipedia in a new tab');
  await p.click('input[name="search"]');   // real mouse click
  await p.type(query);                      // real keyboard input
  await p.key('Enter');
  log(`searched for "${query}"`);
  await p.waitFor(`document.querySelector('#firstHeading') && !location.pathname.endsWith('/Main_Page')`);
  if (await p.eval(`!!document.querySelector('.mw-search-result-heading a')`)) { // no exact article: open the top hit
    await p.click('.mw-search-result-heading a');
    log('opened the top search result');
    await p.waitFor(`!document.querySelector('.mw-search-result-heading') && !!document.querySelector('#mw-content-text p')`);
  }
  const info = await p.eval(`({
    title: document.querySelector('#firstHeading').textContent.trim(),
    summary: [...document.querySelectorAll('#mw-content-text p')]
      .map(e => e.textContent.trim()).find(t => t.length > 60)?.replace(/\\[\\d+\\]/g, '').slice(0, 160) + '…',
    sections: [...document.querySelectorAll('.mw-heading2 h2, h2 .mw-headline')].map(h => h.textContent.trim()).slice(0, 5),
  })`);
  log('title:   ', info.title);
  log('summary: ', info.summary);
  log('sections:', info.sections.join(' · '));
  await p.screenshot('page.png');
  log('saved page.png');
  await p.close();
}
