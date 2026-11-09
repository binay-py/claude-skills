# claude-skills

Practical [Claude Code](https://claude.com/claude-code) skills I use every week. They're battle-tested on real jobs, not demos.

| Skill | What it does |
|---|---|
| **[brave-cdp](skills/brave-cdp)** | Lets Claude drive **your own logged-in Brave / Chrome / Edge** over the DevTools Protocol, using **one connection** so you click "Allow remote debugging?" once instead of 20 times. Zero dependencies, one file. |
| **[event-recap-video](skills/event-recap-video)** | Turns hundreds of phone photos and videos from an event (conference, trip, wedding) into a hooky recap: 16:9 main cut, 9:16 version, and a 45 s beat-synced reel. Pure ffmpeg + Python. |

## Install

In Claude Code:
```
/plugin marketplace add YOUR_GITHUB_USER/claude-skills
/plugin install binay-skills@binay-skills
```
Or copy a single skill folder into `~/.claude/skills/`.

---

## brave-cdp: why it exists

Brave (and Chrome 144+ and Edge) show an **"Allow remote debugging?"** dialog for *every new DevTools connection*, and there's no "always allow". Agents love firing off many small scripts, so you end up clicking Allow over and over.

brave-cdp fixes that two ways:
1. **Job mode.** Claude writes the whole task as one job file, runs it on a single connection, and you get one prompt.
2. **Relay mode.** `node cdp.mjs relay` holds one approved connection open. Every later command reuses it automatically (token-protected, localhost only, events included).

```bash
node cdp.mjs tabs                         # list tabs
node cdp.mjs eval "document.title" --match github.com
node cdp.mjs run job.mjs                  # whole task, one connection
```

```js
// job.mjs
export default async function ({ page, log }) {
  const p = await page({ url: 'https://example.com' }); // opens a new tab, leaves yours alone
  await p.click('a');                                     // real mouse events
  log(await p.eval('document.title'));
  await p.screenshot('page.png');
  await p.close();
}
```

Built in: real mouse/keyboard input, file uploads without the OS dialog, download capture, screenshots, wait-for helpers, raw CDP access, and auto-detection of Brave/Chrome/Edge on Windows, macOS and Linux. Enable it once at `brave://inspect/#remote-debugging`.

## event-recap-video: what you get

- `analyze.py` scores every file (blur, brightness, duplicates, loudness, capture time from EXIF) and builds contact sheets so Claude can actually *look* at your footage.
- `build.py` renders the edit from one `edit.json`: cold-open hook, title card, day labels, music ducking under speeches, crossfades, −14 LUFS loudness, segment cache for fast re-renders.
- `reel.py` makes a TikTok/Reels cut where every cut lands exactly on the beat, with safe-area text.
- The SKILL.md holds the editing lessons learned the hard way: lead with video, chain two songs, don't restyle an approved edit, and what to do when Facebook mutes your music.

Requires `ffmpeg` and `pip install pillow pillow-heif numpy`.

## Contributing

Issues and PRs welcome. If a skill saved you time, a ⭐ helps others find it.

## License

MIT
