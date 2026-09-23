# Use of funds, AROMARIA

Where AROMARIA's money comes from, what it goes to, and what it really costs to pay it back. The family uses it in working sessions.

The front page lists each source of funds:

| Source | Address | What it is |
| --- | --- | --- |
| Kapital | `/kapital` | Revolving credit line. Each draw is a disposition repaid within 30 to 180 days at TIIE plus a spread. |
| Banco Azteca | `/banco-azteca` | Same tool as Kapital, with its own separate record. |
| Cash flow | `/cash-flow` | Place held for the next tool. Coming soon. |

On each credit line page the family decides what stays as a cushion, what each disposition is split into, what each payment really costs once interest is added, which payments bring money back and when, and when the bank gets paid.

Everyone who has the access code sees and edits the same records. Changes save automatically and show up on the other screens within a second.

## How the numbers work

* Annual rate = (TIIE + spread) / 100. The monthly rate shown is the annual rate / 12.
* Interest on a disposition = amount x annual rate x days / 360 (simple interest).
* Back to Kapital on = drawn on date + days (calendar days).
* A payment really costs amount + amount x annual rate x days / 360, using the days of its disposition.
* A revenue payment that brings money back: net = brings back minus true cost.
* Still available = available today minus cushion minus everything drawn. Negative means over the line.

Example at TIIE 6.75% and spread 5% (11.75% a year): 6,000,000 drawn for 120 days costs 235,000 in interest.

## Run it on your computer

You need Node 18 or later.

```
npm install
cp .env.example .env        # then edit ACCESS_CODE and SESSION_SECRET
export $(grep -v '^#' .env | xargs)
npm start
```

Open http://localhost:3000, type the access code, and pick a line.

Without `DATABASE_URL` the record is kept in `./data/record.json`. That file is ignored by git.

Run the checks (they start their own server on a test port with a temporary file):

```
npm test
```

## Settings

| Variable | Required | What it does |
| --- | --- | --- |
| `ACCESS_CODE` | yes | The code people type on the login page. |
| `SESSION_SECRET` | yes | Long random string that signs the session cookie. Changing it signs everyone out. |
| `DATABASE_URL` | no | PostgreSQL connection string. When set, the record is stored there. |
| `PGSSL` | no | `true` turns on SSL for the database connection (needed for some external databases). |
| `DATA_FILE` | no | Where the JSON file lives when there is no database. Default `./data/record.json`. |
| `PORT` | no | Railway sets this. Default 3000. |
| `HISTORY_EVERY_MS` | no | How often a copy of each line is kept while people work, in milliseconds. Default 600000 (10 minutes). |

The server stops with a clear message if `ACCESS_CODE` or `SESSION_SECRET` is missing.

## Deploy on Railway

1. Push this folder to a private GitHub repository.
2. In Railway, click New Project, then Deploy from GitHub repo, and pick the repository. Railway detects Node and runs `npm start`.
3. In the same project click Create (or the + button), then Database, then Add PostgreSQL.
4. Open the app service, go to Variables, and add:
   * `ACCESS_CODE` with the code the family will use.
   * `SESSION_SECRET` with a long random string. One way to make it: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   * `DATABASE_URL` with the value `${{Postgres.DATABASE_URL}}` (Railway fills it in from the database service).
5. Go to Settings, Networking, and click Generate Domain. That is the address to share.
6. Optional: in Settings, Deploy, set the healthcheck path to `/healthz`.
7. Moving data from an older copy of the page: on the old page click Download backup (or Backup, then Copy, on the first version). On the new page open the matching line, click Restore from a backup, choose the file (or paste the text), and click Restore. What was there is kept in Saved versions first.
8. For an extra safety net on top of Saved versions, open the Postgres service in Railway, go to Backups, and turn on scheduled backups if your plan offers them.

### Without a database

The app can keep the record in a JSON file instead. On Railway the file system is wiped on every deploy, so the file must live on a Volume:

1. On the project canvas, right click the app service and choose Attach Volume. Set the mount path to `/data`.
2. In the app service Variables, set `DATA_FILE` to `/data/record.json` and do not set `DATABASE_URL`.

PostgreSQL is the better choice. It keeps backups and survives moving the service.

## Records

Each credit line has its own record, a row in the `records` table (or a JSON file when there is no database):

| Line | Record id | File store |
| --- | --- | --- |
| Kapital | `main` (the original record, so nothing was migrated) | `DATA_FILE` |
| Banco Azteca | `banco-azteca` | `record-banco-azteca.json` next to `DATA_FILE` |

A record is created empty the first time its page is opened.

To add another credit line, add it to `LINES` in `server.js` and in `public/app.js`, add it to the allowed pages in `public/login.js`, add a row to `public/index.html`, and reword the "Across both lines" sentence in `public/home.js`.

API (all behind the session):

| Route | What it does |
| --- | --- |
| `GET`, `PUT /api/lines/:line/record` | Read and save a line (compare and set on `baseVersion`). |
| `GET /api/lines/:line/history` | Saved versions, newest first (`?limit=` and `?before=` for older ones). |
| `GET /api/lines/:line/history/:hid` | One saved version with its full data. |
| `GET /api/lines/:line/export.json` | Backup file download. |
| `GET /api/lines/:line/export.csv` | Payments spreadsheet download (opens in Excel). |
| `GET /api/summary` | Headline numbers for the front page. |
| `GET /api/events` | Live updates: `changed {line, version}`. |

`/api/record` still answers for Kapital so an older open tab keeps saving.

## Saved versions

Section 4 of each line keeps the family's work safe without anyone having to remember a backup:

* Every change is saved to the database as people type.
* The server also keeps a copy of the line (the `record_history` table, or `history-<id>.json` with the file store):
  * at least every 10 minutes while people work (change with `HISTORY_EVERY_MS`),
  * always before a disposition or payment is removed,
  * always before a restore, and before Start this line over.
* The newest 500 copies per line are kept. Each shows when it was saved and what it held, and has View and Bring back.
* Bringing back a copy, restoring a backup file and starting over all keep what was there first, so each one can be undone.
* Download backup saves the whole line as a file. Download payments for Excel gives one row per payment with its true cost, what it brings back and the net.
* Restore from a backup takes a downloaded file (or pasted text) and warns when the file comes from the other line.

## How saving works

* The page loads the record, remembers its version and saves 800 ms after the last edit.
* The server saves only if the version the page started from is still current. If someone else saved first, the server answers with their record, the page merges the two and saves again.
* Merging: the newer edit wins for the top fields (available, TIIE, spread and cushion, as one group) and for each disposition on its own. Removed dispositions leave a tombstone for 30 days so they do not come back.
* A disposition someone is typing in is never replaced under their cursor. The newer copy waits until they leave that block.
* Other screens hear about every save through a live connection and pull the new record. They also check every 60 seconds.
* Which dispositions are collapsed is remembered per browser and is not part of the shared record.

## Files

* `server.js` Express server, login, security headers, lines, record API, summary, live events.
* `db.js` PostgreSQL store and JSON file store with the same interface, one record per id.
* `public/index.html`, `public/home.js` The front page with every source of funds.
* `public/line.html`, `public/app.js` The credit line page (Kapital, Banco Azteca), including Saved versions.
* `public/cash-flow.html` Placeholder for the cash flow tool.
* `public/styles.css` Styles for every page.
* `public/login.html`, `public/login.js` The access code page.
* `test/run.js` End to end checks with jsdom.
