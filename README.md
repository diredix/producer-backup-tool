# producer-backup-tool

Backup helper for **Producer.ai** projects (former Riffusion workflow).

This tool is a browser userscript that exports your project data into a ZIP:

- `metadata/*.json` for each generation
- `summary.csv` with core fields
- `prompts.txt` with prompt text (when present in metadata)
- optional `audio/*` files (when audio URLs are discoverable and accessible)
- `_report.json` with counts and any per-item errors

## Why

If a platform changes models, storage policy, or availability, you need an offline backup of your own work.

## Important

- Use this only for **your own account/content**.
- Respect platform Terms of Service.
- Very large libraries may require multiple exports (per project).
- Cloudflare/session protection means this is designed to run **inside your logged-in browser**, not from server-side scripts.

## Install

1. Install Tampermonkey:
   - Chrome/Edge: <https://www.tampermonkey.net/>
2. Create a new script and paste:
   - `scripts/producer-backup.user.js`
3. Save the script.

Raw script URL:
`https://raw.githubusercontent.com/diredix/producer-backup-tool/main/scripts/producer-backup.user.js`

## Usage

1. Log in to `https://www.producer.ai`.
2. Open a page with your songs:
   - `https://www.producer.ai/project/...` or
   - `https://www.producer.ai/library/my-songs`
3. Wait until the page starts loading your songs.
4. Use one of the panel buttons:
   - `Export ZIP (Metadata + Prompts)`
   - `Export ZIP (Metadata + Prompts + Audio)`

The script auto-scrolls to discover song links/IDs, requests metadata in batches, and downloads a ZIP.

## Output format

- `metadata/<title>__<id>.json` raw generation objects
- `summary.csv` columns:
  - `id`
  - `title`
  - `created_at`
  - `duration_seconds`
  - `prompt`
- `prompts.txt` readable prompt dump
- `audio/<title>__<id>.<ext>` (if found/downloaded)
- `_report.json` includes error list for missing items

## Known limitations

- If some songs are never rendered into the project page, their IDs cannot be discovered by DOM scan.
- Audio URLs may vary between model versions; some generations may export metadata only.
- Very high song counts can hit API limits; rerun per project or in off-peak hours.

## Troubleshooting

### "Parsing error: Unexpected token <"

You pasted HTML (for example a GitHub page) instead of the userscript JS.

Fix:
1. Delete editor contents.
2. Paste the raw userscript (starts with `// ==UserScript==`, not `<!DOCTYPE html>`).
3. Save and refresh your Producer project page.

## Publish to GitHub

From `C:\Temp\producer-backup-tool`:

```bash
git init
git add .
git commit -m "Add Producer.ai backup userscript"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

## Security note

Userscripts run in your browser context. Always review code before installing.
