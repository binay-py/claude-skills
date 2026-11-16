"""Optional voiceover helper for promo.mjs (needs: pip install edge-tts). One edge-tts call per sentence with
word timings, all requests in parallel. Microsoft rejects custom SSML, so pacing comes from the gaps promo.mjs
inserts between clips and from the rate setting.

    python voice.py job.json   # job = {"voice": "...", "rate": "+5%", "items": [{"id": "0.0", "text": "...", "out": "/path/base"}]}

Prints a JSON list: [{"id", "mp3", "words": [{"w", "t", "d"}]} | {"error"}] in the order of items.
"""
import asyncio, json, sys
import edge_tts


async def synth(voice, rate, it):
    mp3, words = it["out"] + ".mp3", []
    c = edge_tts.Communicate(it["text"], voice, rate=rate, boundary="WordBoundary")
    with open(mp3, "wb") as fh:
        async for ch in c.stream():
            if ch["type"] == "audio":
                fh.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                words.append({"w": ch["text"], "t": ch["offset"] / 1e7, "d": ch["duration"] / 1e7})
    return {"id": it["id"], "mp3": mp3, "words": words}


async def main():
    with open(sys.argv[1], encoding="utf8") as fh:
        job = json.load(fh)
    res = await asyncio.gather(*(synth(job["voice"], job["rate"], it) for it in job["items"]), return_exceptions=True)
    print(json.dumps([r if not isinstance(r, Exception) else {"error": f"{type(r).__name__}: {r}"} for r in res]))


asyncio.run(main())
