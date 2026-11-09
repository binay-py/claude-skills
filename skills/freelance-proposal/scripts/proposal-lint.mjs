#!/usr/bin/env node
// proposal-lint — score a freelance proposal (Upwork, Fiverr, cold email) before sending it.
// Zero dependencies. Node 22+.
//
//   node proposal-lint.mjs proposal.txt
//   node proposal-lint.mjs proposal.txt --job job-post.txt      also checks it answers THIS client
//   node proposal-lint.mjs proposal.txt --platform fiverr       upwork (default) | fiverr | email
//   cat proposal.txt | node proposal-lint.mjs -
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const jobFile = opt('job'), platform = (opt('platform') || 'upwork').toLowerCase();
const src = argv[0];
if (!src) { console.log('usage: node proposal-lint.mjs <proposal.txt|-> [--job job.txt] [--platform upwork|fiverr|email]'); process.exit(1); }
const text = (src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8')).replace(/\r/g, '').trim();
const job = jobFile ? fs.readFileSync(jobFile, 'utf8') : '';

const issues = []; let score = 100;
const hit = (pts, sev, msg) => { score -= pts; issues.push({ sev, msg }); };
const words = text.split(/\s+/).filter(Boolean), nWords = words.length;
const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const firstLine = text.split('\n').find(l => l.trim()) || '';

// 1. opening: clients see ~the first 200 characters in the Upwork list before clicking
const GENERIC_OPEN = [
  [/^(dear|hi|hello|greetings)[,!]?\s*(hiring manager|sir|madam|sir\/madam|there|client|team)?[,!.]?\s*$/i, 'greeting-only first line wastes the preview'],
  [/\b(dear (hiring manager|sir|madam)|to whom it may concern)\b/i, '"Dear Hiring Manager" reads as a template'],
  [/\bi am writing to\b|\bi('m| am) (writing|reaching out) (to|because)\b/i, '"I am writing to…" opener'],
  [/\bi came across your (job|post|project)\b|\bi (have )?(read|reviewed|gone through) your (job|project) (description|post)/i, '"I came across / read your job post" opener (every proposal says it)'],
  [/\bi('m| am) (very )?(excited|thrilled|delighted|happy) to (apply|submit|bid)/i, '"I\'m excited to apply" opener'],
  [/^i('m| am) a (highly )?(skilled|experienced|professional|passionate|dedicated)/i, 'starts by describing yourself instead of their problem'],
  [/\bi have \d+\+? years of experience\b/i, '"I have N years of experience" (say what you built instead)'],
];
const preview = text.slice(0, 200);
for (const [re, why] of GENERIC_OPEN) if (re.test(preview)) { hit(12, 'high', `Opening: ${why}. Start with their problem or a result: "Your checkout drops users on mobile. I fixed the same thing for X…"`); break; }
if (/^(hi|hello|hey|dear|greetings)\b[^.\n]{0,40}$/i.test(firstLine.trim())) hit(12, 'high', 'First line is just a greeting. On Upwork the preview shows only ~200 characters, so put the hook in line 1.');

// 2. AI-isms and filler
const AI = ['delve', 'leverage', 'seamless', 'seamlessly', 'robust', 'cutting-edge', 'tailored', 'elevate', 'synergy', 'game-changer', 'unlock', 'streamline', 'utilize', 'holistic', 'paramount', 'meticulous', 'testament', 'tapestry', 'navigate the', 'in today\'s fast-paced', 'ever-evolving', 'look no further', 'rest assured', 'don\'t hesitate', 'hope this (message|email) finds you', 'i would be (thrilled|delighted)', 'perfect fit', 'go above and beyond', 'top-notch', 'high-quality', 'state-of-the-art', 'best practices', 'end-to-end solution', 'take your .{1,20} to the next level'];
const found = AI.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(text));
if (found.length) hit(Math.min(20, found.length * 4), found.length > 2 ? 'high' : 'medium', `Sounds AI-written / templated: ${found.map(w => `"${w.replace(/\\/g, '')}"`).join(', ')}. Use plain, specific words.`);
const dashes = (text.match(/—/g) || []).length; if (dashes > 2) hit(4, 'low', `${dashes} em-dashes: a common AI tell. Use commas or full stops.`);
const transitions = sentences.filter(s => /^(moreover|furthermore|additionally|in conclusion|overall|ultimately)\b/i.test(s)).length;
if (transitions) hit(4, 'low', `${transitions} sentence(s) start with Moreover/Furthermore/Additionally: essay filler.`);

// 3. leftovers
const ph = text.match(/\[[A-Z][^\]]{0,30}\]|\{\{?[a-z_ ]+\}?\}|<(name|client|company)>|\bXX+\b|lorem ipsum/gi);
if (ph) hit(25, 'high', `Unfilled placeholder(s): ${[...new Set(ph)].join(', ')}`);

// 4. client focus
const iStarts = sentences.filter(s => /^(i|i'm|i've|i'd|i'll|my)\b/i.test(s)).length;
const you = (text.match(/\b(you|your|you're|you'll|yours)\b/gi) || []).length, me = (text.match(/\b(i|i'm|i've|i'd|i'll|my|me)\b/gi) || []).length;
if (sentences.length >= 4 && iStarts / sentences.length > 0.5) hit(8, 'medium', `${iStarts} of ${sentences.length} sentences start with I/My. Rewrite around them: "Your app…", "You'll get…"`);
if (me > 0 && you / me < 0.5 && nWords > 40) hit(5, 'low', `"I/me/my" ${me}× vs "you/your" ${you}×. Make it about the client.`);

// 5. proof, plan, question, next step
if (!/https?:\/\/|\b[\w-]+\.(com|dev|io|app|net|org|codes)\b|\b\d+(\.\d+)?\s?(%|x|k\b|users|sites|projects|clients|ms|seconds|hours|days|downloads|stars)/i.test(text))
  hit(10, 'medium', 'No proof: add one relevant past project with a link, or a concrete number ("cut load time from 6 s to 1.2 s").');
if (!/\?/.test(text)) hit(8, 'medium', 'No question to the client. One specific question ("Is the checkout on Shopify or custom?") gets replies.');
if (!/\b(call|chat|message|reply|send|share|start|schedule|available|happy to|can begin|next step|today|tomorrow|this week)\b/i.test(text.slice(-300))) hit(4, 'low', 'No clear next step at the end ("Can start tomorrow; want a 10-minute call?").');

// 6. job relevance
if (job) {
  const STOP = new Set('the a an and or to of in for on with is are be will you your we our i my it this that need needs looking want have has from as at by can should must would like who what any some all more just also get site website app project work job help great good let show make use using within week weeks day days must very well already new please thanks'.split(' '));
  const terms = [...new Set((job.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []).filter(w => !STOP.has(w)))];
  const freq = terms.map(t => [t, (job.toLowerCase().match(new RegExp(`\\b${t.replace(/[.+#]/g, '\\$&')}\\b`, 'g')) || []).length]).sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0]);
  const used = freq.filter(t => text.toLowerCase().includes(t));
  if (used.length < Math.min(4, freq.length / 2)) hit(12, 'high', `Barely references the job post. Its key terms: ${freq.join(', ')}. You mention: ${used.join(', ') || 'none'}. Show you read it: name their stack, problem or deadline.`);
}

// 7. length
const L = { upwork: [60, 220], fiverr: [40, 160], email: [50, 150] }[platform] || [60, 220];
if (nWords > L[1]) hit(Math.min(15, Math.round((nWords - L[1]) / 15)), 'medium', `${nWords} words: long for ${platform} (aim ${L[0]}–${L[1]}). Cut the life story; keep hook → proof → plan → question.`);
if (nWords < L[0] / 2) hit(20, 'high', `${nWords} words: far too thin to win anything. Add the hook, one proof point, a 2–3 step plan and a question.`);
else if (nWords < L[0]) hit(6, 'low', `${nWords} words: thin. Add one proof point and a 2–3 step plan.`);

score = Math.max(0, score);
console.log(`\nproposal-lint (${platform}): ${score}/100 · ${nWords} words`);
console.log(`preview (first ~200 chars clients see): "${preview.replace(/\n+/g, ' ').slice(0, 200)}${text.length > 200 ? '…' : ''}"\n`);
const ORDER = { high: 0, medium: 1, low: 2 };
for (const i of issues.sort((a, b) => ORDER[a.sev] - ORDER[b.sev])) console.log(`${i.sev === 'high' ? '✘' : i.sev === 'medium' ? '!' : '·'} ${i.msg}`);
if (!issues.length) console.log('✓ nothing to fix: specific, client-focused, with proof and a question.');
console.log(score >= 85 ? '\nReady to send.' : score >= 65 ? '\nClose: fix the ✘ and ! items.' : '\nRewrite before sending.');
process.exitCode = score >= 65 ? 0 : 1;
