# ListingFlow

A team board for producing AI product images for clothing listings. Products
come from the Google Sheet production tracker; the team configures each shoot
in Prompt Studio from a shared Asset Library, prepares the prompt, and takes the
outputs through QC to delivery.

## Running it

Requires Node.js 22 or newer (no other dependencies).

```bash
npm start
```

Open http://localhost:3000. Everyone on the same network can open the address
the server prints. The first person to open it becomes the owner and sets a PIN.

## What's where

| Area | What it does |
|---|---|
| Pipeline | The Team Board. Cards come from the tracker sheet (synced every 5 minutes). Each card's **Prompt Studio** tab links the product to the library, holds its setup and prompt, and offers presets and reuse. |
| Asset Library | Reusable models, tops, bottoms, shoes, accessories, props, poses, styles, expressions and note presets. Also **Insights** (what is reused most) and **Needs attention** (missing images, missing prompt text, likely duplicates). Bulk tagging, CSV import and metadata export are here. |
| Prompt Studio | Builds one shoot: model, outfit, accessories, pose, house style. Prepares the prompt with a deterministic engine, tracks versions, and finalizes a snapshot that never changes later. Outfit presets live here too. |
| Archive / Whiteboard | Unchanged board features. Archive exports now include Prompt Studio setups. |

## Roles

The owner gives roles; the server enforces them (`permissions.js`).

- **Creator**: builds setups, links products, adds assets and edits the ones they added, proposes presets, moves own work to QC.
- **Reviewer**: inspects setups and prompts, gives QC feedback, passes QC or requests changes, proposes presets.
- **Admin**: everything above, plus shared assets, prompt templates, preset approval and pinning, categories and the AI switch.
- **Owner**: like admin, and manages people and roles.
- **Pending**: can view and comment.

## Data and backups

All data lives in `data/` (git-ignored):

- `data/db.json`: cards, team, Asset Library, Prompt Studio, presets, templates. Written atomically.
- `data/files/`: uploaded images, named by content hash, never modified once written.
- `data/backups/db-YYYY-MM-DD.json`: automatic daily copy of `db.json`, last 7 days kept.

Full backup, images included (safe while the server runs):

```bash
npm run backup
```

This writes `backups/listingflow-<date-time>/` (git-ignored). Copy that folder somewhere off this computer regularly; the daily copies inside `data/` do not include images.

Restore (stop the server first; the current data is kept as `db.json.before-restore-…`):

```bash
npm run restore -- backups/listingflow-2026-10-23-14-30
```

`restore` also accepts a single file, such as a daily copy or a pre-migration copy.

The Asset Library's **Export metadata** button downloads the library, presets,
templates, product links and setups as JSON, which is handy for audits or moving data.

## Migrations and rollback

Data migrations run once at server start (`store.js`, `MIGRATIONS`), and each run
is recorded in `db.json` under `migrations`. Before any migration runs, the server
saves `data/db.before-<name>.json`. To roll back, stop the server and run:

```bash
npm run restore -- data/db.before-assetLibraryV1.json
```

then start the previous version of the code.

## AI assistant (optional)

Prompt Studio works fully without AI: a built-in matcher handles requests and the
prompt engine is deterministic. To add Gemini:

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (from https://aistudio.google.com/apikey).
2. Restart the server, then click **Turn on AI…** in Prompt Studio as the owner or an admin.

Only text is sent: request text plus asset names, codes, aliases, tags and key details.
Reference images are never sent. On Gemini's free tier, Google may use this data to
improve its products and human reviewers may read it; teams in the EEA, Switzerland
or the UK must use a paid plan. Requests are limited per minute and per day
(`AI_MAX_REQUESTS_PER_*`) and per person (`AI_REQUESTS_PER_MEMBER_PER_MINUTE`).

## Security notes

- Secrets live only in `.env` (git-ignored); the API key is sent in a request header and never logged.
- The server serves only `index.html` and the API, never project files or `data/`.
- Uploads must be images (JPG, PNG, WebP, GIF, AVIF, BMP, SVG, HEIC), up to 100 MB on the server and 25 MB in the library UI. Uploaded SVGs are served with a sandboxing content policy.
- Every change needs a signed-in member with a PIN; role rules are checked on the server, and refused changes are reported back.
- The board is plain HTTP on the local network; anyone on the network can view it.
