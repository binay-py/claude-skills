# Short-form promo video playbook (2025–26)

For scripted renders (HTML/CSS frames + ffmpeg, edge-tts, word-synced captions). Pixels assume 1080×1920.
Tags: **[P]** platform docs/data · **[D]** study with stated sample (often vendor-run) · **[A]** practitioner convention, unproven.

## 1. Hooks (0–3 s)

Up to 47% of a Facebook video campaign's value lands in the first 3 s (Nielsen, 2016) [D]; 90% of TikTok ad-recall impact lands in the first 6 s [D].

| Rule | Number |
|---|---|
| Frame 0 has motion + hook text + subject | t = 0, no fade-in |
| Spoken hook done | ≤ 2 s [A] |
| Product/value visible | ≤ 3 s (TikTok) [P]; brand ≤ 5 s (Google ABCD) [P] |
| Human (face, hands, voice) | ≤ 2 s: +50% hook rate [D] |
| Say "you" | ≤ 5 s: +128% purchase intent [D] |
| Hook text | 3–7 words; overlays 1.4× likelier to hook [D] |
| Logo | never first: logo on screen −14% 6-s view-through, product shot +17% (VidMob, 1,678 ads) [D] |

Patterns: disaster averted (real terminal: "Claude almost ran `rm -rf ~`. This hook blocked it.") · result first, then "here's how" · before/after wipe at 1 s · a real, specific number · callout ("Using Claude Code on Windows? Stop doing this.").

Killers: logo sting, "Hi guys", context before payoff, black first frame, static screenshot, text under UI, clickbait (Instagram won't recommend engagement bait [P]).

Covers: Shorts covers come from a video frame, so design frame 0 as the cover [A]. Instagram's grid crops to 3:4; keep cover text in the centered 1080×1440 [P]. The Fiverr thumbnail is the Gig cover in search [P].

Sources: TikTok, Creative best practices — https://ads.tiktok.com/help/article/creative-best-practices · CreatorIQ, TikTok creator ads report — https://www.creatoriq.com/press/releases/tiktok-creatoriq-release-special-report-with-data-backed-keys-to-success-for-advertisers · VidMob, TikTok hook analysis — https://vidmob.com/resource/tiktok-hook-analysis · Google, ABCDs — https://www.thinkwithgoogle.com/future-of-marketing/creativity/youtube-video-ad-creative/ · Planoly, Instagram Jan 2025 updates (3:4 grid) — https://planoly.com/blog/instagram-updates-jan-2025

## 2. Retention, length, pacing

- Buffer, 1.1M TikToks: > 60 s got 43% more reach than 30–60 s, but length is "unlikely to be make-or-break"; the hook matters more [D].
- Socialinsider, 23.6M brand videos (H1 2026): Reels peak at 45–60 s; TikTok views peak at 120–180 s, engagement under 30 s; FB Reels and LinkedIn engagement peaks at 120–180 s [D].
- Shorts over 60 s with any Content ID claim are blocked worldwide [P].

Targets: Short/Reel promo 20–45 s · TikTok 30–60 s (tutorial ≤ 150 s) · recap reel 30–60 s · Fiverr 45–60 s.

- Change something every 1.5–3 s (cut, zoom, text pop) [A].
- Open a loop by 3 s ("the third one saved my repo"), pay it off in the last 20%; rehook at ~40% and ~70% [A].
- Payoff, then a CTA of ≤ 3 s, then stop. No outro.
- Loop the end into frame 0; every Shorts replay counts as a view since 31 Mar 2025 [P].
- Instagram ranks on watch time, likes per reach and sends per reach (Mosseri, Jan 2025) [P]: give people a reason to send it.

Sources: Buffer, Longer TikToks get more views — https://buffer.com/resources/longer-tiktoks-get-more-views-data/ · Socialinsider, Short-form video study — https://www.socialinsider.io/blog/short-form-video-study/ · YouTube Help, Three-minute Shorts — https://support.google.com/youtube/answer/15424877 · Sprout Social, Shorts view count update — https://support.sproutsocial.com/hc/en-us/articles/35874991211533-YouTube-Shorts-View-Count-Update-March-2025 · SocialPilot, Reels algorithm (Mosseri signals, secondhand) — https://www.socialpilot.co/blog/instagram-reels-algorithm

## 3. Captions and on-screen text

69% of US viewers watch without sound in public; 80% say captions make them likelier to finish (Verizon/Publicis, n = 5,616, 2019, self-reported) [D]. Always burn captions in.

| Parameter | Default |
|---|---|
| Chunk | 1–3 words, ≤ 16 chars, 1 line [A] |
| Rate ceiling | overlays 5–10 words/s (TikTok) [P]; ≤ 17–20 chars/s, ≤ 42 chars/line (Netflix) [P] |
| Font | weight 800–900, 72–96 px, 6–8 px stroke or shadow [A] |
| Highlight | active word in one accent, scale 1.0→1.08 in 80–120 ms [A] |
| Position | center y 1100–1250, width ≤ 700 px centered |

Safe zones, measured from app UI (platforms publish ad specs only) [A]:

| Platform | Top | Bottom | Left | Right |
|---|---|---|---|---|
| TikTok | 120–200 | 250–480 | 50–60 | 120–164 |
| Reels organic | 210–250 | 340–460 | 65 | 65–173 |
| Meta Reels ads | 270 | 672 (35%) | 65 | 65 |
| Shorts | 120–380 | 300–390 | 48–65 | 96–192 |
| **Union** | **250** | **480** (ads 672) | **65** | **190** |

Sources: 3Play Media, Verizon/Publicis study — https://www.3playmedia.com/blog/verizon-media-and-publicis-media-find-viewers-want-captions/ · Netflix, Timed Text Style Guide — https://backlothelp.netflix.com/hc/en-us/articles/215350158-Dutch-Timed-Text-Style-Guide · House of Marketers, Safe zones — https://www.houseofmarketers.com/guide-to-safe-zones-tiktok-facebook-instagram-stories-reels/

## 4. Voiceover

- 150–170 wpm for promos, 130–150 for code walkthroughs [A]; 30 s ≈ 80 words. Sentences ≤ 12 words.
- 30 s script: hook 0–2 s → problem 2–6 s → demo/proof 6–22 s → payoff 22–27 s → CTA 27–30 s.
- Plain practitioner tone beats an announcer voice for developers [A].
- edge-tts takes one voice and one prosody (rate, pitch, volume) per request; custom SSML is rejected [P]. Synthesize per sentence, vary rate (−5% to +15%) and pitch (±8 Hz) for emphasis, insert real silence (300–450 ms between sentences, 500–700 ms before the payoff), spell out acronyms ("C-L-I") [A].
- Fiverr tells sellers to narrate in their own voice, not computer-generated narration [P].

Sources: edge-tts README — https://github.com/rany2/edge-tts · Fiverr Community, The power of a Gig video — https://community.fiverr.com/home/blogs/the-power-of-adding-a-gig-video-to-help-you-stand-out-2025-05-28

## 5. Audio

| Parameter | Default |
|---|---|
| Master | −14 LUFS integrated, true peak ≤ −1 dBTP (YouTube de facto; IG/TikTok unpublished) [A] |
| Music under VO | 18–24 dB below voice; duck release 250–400 ms [A] |
| SFX | whoosh on scene change, click on UI action, hit on reveal; ≥ 6 dB under voice [A] |
| Beat sync | 120 BPM = 2 s per bar; promo cuts every 1–2 bars, montage every 1–2 beats [A] |
| Licensing | YouTube Audio Library tracks get no Content ID claims; Shorts library songs max 90 s [P] |

Sources: Fora Soft, LUFS targets per platform — https://www.forasoft.com/learn/audio-for-video/articles-audio/lufs-targets-per-platform-2026 · Storyblocks, Balancing audio — https://www.storyblocks.com/resources/tutorials/how-to-balance-audio-premiere-pro

## 6. Visual craft and export

- Every shot moves: push-in 3–6%, punch-in to 115–130% on key words, 150–250 ms ease-out [A].
- Screen recordings: capture at 2× DPR, zoom 150–250% to the action, code ≥ 32 px on the final canvas, cursor 1.5–2× with click ripple, hold 0.6–1 s on output [A].
- Dark background + one accent [A]; same palette and font across cover, video and store listing (Chrome Web Store asks for this) [P].
- Faceless: show hands, cursor and voice, or a small face-cam inside the safe zone.
- No other apps' watermarks, blurry footage or horizontal video in vertical feeds [P].
- Export (YouTube spec): MP4 faststart, H.264 High, yuv420p, closed GOP = fps/2, 1080p30 ≈ 8 Mbps, 1080p60 ≈ 12 Mbps, AAC-LC 48 kHz [P].

Sources: YouTube Help, Upload encoding settings — https://support.google.com/youtube/answer/1722171 · Meta for Creators, Reels best practices — https://creators.facebook.com/reels-best-practices-tips-tricks · Instagram, Recommendations and originality — https://creators.instagram.com/recommendations-and-originality

## 7. Dev tools, SaaS, extensions, repos

- Real terminal, browser and repo; no stock footage or mock UIs [A].
- Pain or disaster averted → one command or click → after state, within 15–30 s [A]. For extensions, the before/after split is the hook.
- Proof on screen ≥ 1.5 s: real stars, installs, measured numbers. Chrome Web Store guidance says to avoid claims like "Editor's Choice" or "Number One" [P].
- One CTA: exact search term or short URL on screen ≥ 2 s. TikTok/Reels links aren't clickable, so say where the link is.
- The Chrome Web Store promo video shows before the screenshots; its first frame is the listing hero [P].
- Reddit/HN/X: native feel, no hype voice [A].

Sources: Chrome for Developers, Listing information — https://developer.chrome.com/docs/webstore/cws-dashboard-listing · PostHog, Tips for demos — https://posthog.com/newsletter/how-to-demo

## 8. Event recaps

- Reel 30–60 s; full highlight 60–90 s [A].
- Cold open on the emotional peak (hands raised, laughter); title later.
- Arc: peak tease 0–3 s → arrival → build montage → peak with natural audio → quote card → end card (date, next event).
- Build clips 0.4–1 s on beat; hold 2–3 s or 50% slow-mo on faces. Faces > crowds > venue [A].
- Text cards ≤ 6 words ("3 days. 400 people. One hope."), ≤ 4 cards, one song.
- Post within ~72 h; tag people so they share [A].

Sources: Vimeo, Event recap videos — https://vimeo.com/blog/post/event-recap-video · Cvent, Event videos — https://www.cvent.com/en/blog/events/event-videos

## 9. Platform specs

| Platform | Max length | Target | Canvas | Notes |
|---|---|---|---|---|
| YouTube Shorts | 3:00 [P] | 20–45 s | 1080×1920 | > 60 s + claim = blocked |
| Instagram Reels | 3:00 | 30–60 s | 1080×1920, ≥ 30 fps | grid crops 3:4 |
| TikTok | 10 min (60 on some accounts) | 20–60 s | 1080×1920 | web ~500 MB |
| Facebook Reels | no cap since mid-2025 | 30–90 s | 1080×1920 | — |
| X | 2:20 free | ≤ 45 s | 9:16 or 16:9 | 512 MB |
| LinkedIn | 10–15 min (sources conflict) | 30–90 s | 1080×1920 / 1080×1350 | 5 GB |
| Reddit | 15 min | 30–60 s | 9:16 or 16:9 | 1 GB |
| Fiverr Gig | 75 s [P] | 45–60 s | 1920×1080 [A] | < 50 MB, MP4, no contact info [P] |

Most limits come from third-party summaries; confirm on the upload screen.

Sources: Social Media Today, 3-minute Reels — https://www.socialmediatoday.com/news/instagram-officially-expands-reels-length-3-minutes/737766/ · SocialBee, Facebook Reels length — https://socialbee.com/blog/how-long-can-a-facebook-reel-be/ · Meltwater, Videos on X — https://www.meltwater.com/en/blog/guide-to-posting-videos-to-twitter · Fiverr Help, Gig video — https://help.fiverr.com/hc/en-us/articles/360010451657

## 10. Mistakes that reliably hurt

Logo or greeting before value · text under UI · story told only in voice · claimed music in Shorts > 60 s · other apps' watermarks · outros and stacked CTAs · hooks with no payoff · full desktop shrunk to 1080 wide · music over voice or clipping · TTS on Fiverr · fake proof.

## 11. Rules for automated pipelines

1. 1080×1920 @ 30 fps (60 for fast cursor/scroll); Fiverr 1920×1080.
2. Frame 0 not black (mean luma > 0.1); has hook text and subject.
3. Hook text 3–7 words, on screen ≥ 1.5 s from t = 0; spoken hook ends ≤ 2.0 s.
4. Real product UI by 3.0 s; no logo-only frame before 3 s.
5. "you" in the first 12 VO words.
6. Fail if longer than: Shorts/Reels 45 s, TikTok 60 s, X 45 s, Fiverr 60 s.
7. Every 3.0 s window has a visual change (cut, ≥ 3% scale, text in/out).
8. Rehook (new visual + SFX) at 40% and 70% of runtime, ± 5%.
9. One CTA in the last 3 s; video ends ≤ 1.0 s after it.
10. Last frame reuses frame 0's background and layout.
11. All text inside x 65–890, y 250–1440 (ads y ≤ 1248).
12. Caption chunks 1–3 words, ≤ 16 chars, ≥ 0.25 s each.
13. Caption font ≥ 72 px, weight ≥ 800, stroke ≥ 6 px, contrast ≥ 4.5:1.
14. wpm from edge-tts word boundaries: target 150–170, fail outside 130–190.
15. Split sentences > 12 words; one TTS call per sentence.
16. Silence: 300–450 ms between sentences, 500–700 ms before payoff, ≤ 100 ms leading.
17. Two-pass `loudnorm=I=-14:TP=-1:LRA=11`; assert −14 ± 1 LUFS, true peak ≤ −1.0 dBTP.
18. Duck music 18–24 dB under VO, release 250–400 ms.
19. SFX ≥ 6 dB under voice; ≤ 1 per 1.5 s.
20. Snap cuts to the nearest beat (±1 frame) when BPM is known.
21. Royalty-free whitelist music only; mandatory for Shorts > 60 s.
22. Screen captures at 2× DPR, zoom ≥ 150%, code ≥ 32 px.
23. `libx264 -profile:v high -pix_fmt yuv420p -g <fps/2> -crf 18 -maxrate 12M -bufsize 24M -movflags +faststart`, AAC 48 kHz.
24. Fiverr: ≤ 50 MB (≈ 6 Mbps at 60 s), human voice or music only, no URLs or contact info.
25. One export per platform; never upload a file with another platform's watermark.
