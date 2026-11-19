# Hackathon presentation

Slidev deck for the 4-minute hackathon demo (intro slide plus 2 content slides). Keep it up to date
as features land; speaker notes and timing live in the HTML comments at the end of each slide.

## Run

```bash
cd presentations/hackathon
npm install
npm run dev
```

Press `p` for presenter mode with speaker notes. Use `npx slidev --port <port>` if port 3030 is taken.

## Export

```bash
npm run export
```

Exporting to PDF needs Playwright Chromium (`npx playwright install chromium`).
