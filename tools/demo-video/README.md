# Drapr demo video

Records the walkthrough on the Drapr homepage (`drapr/media/drapr-walkthrough.mp4`)
by driving the real app in a headless browser against made-up data. Nothing touches
the live database, Fergus or email: the Supabase client and every Edge Function are
swapped for in-browser stand-ins (`fake-supabase.js`, `fns.js`).

Re-record after the app changes so the video stays true to it.

## Run it

From this folder, with Node 20+, ffmpeg and Playwright's Chromium installed:

```bash
npm init -y && npm i esbuild jspdf@2.5.1 chart.js@4.4.1
npx esbuild jspdf-entry.js --bundle --format=esm --outfile=dist/jspdf.js
npx esbuild chart-entry.js --bundle --format=esm --outfile=dist/chart.js
python3 -m http.server 8790 --directory ../.. &
node record.js --fast      # dry run, no video, a minute or so
node record.js             # the real take, about four minutes, into rec/
python3 cut.py main        # out/: full walkthrough, 60s and 25s cuts
```

## What's where

- `seed-*.js` — the dummy business: price list, accounts, ~40 background jobs,
  three website enquiries, the van's fortnight and today's run sheet.
- `studio.html` — the frame around the app: caption band, pointer, title cards and
  the phone used for the customer and driver screens.
- `record.js` — the script, step by step, with the caption for each step.
- `cut.py` — encodes the full video and picks the moments for the 60s and 25s cuts
  from the markers `record.js` writes.
