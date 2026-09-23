# Kapital line

AROMARIA has a revolving credit line with Kapital bank. Each draw is a disposition that is repaid within 30 to 180 days at TIIE plus a spread. This page is where the family organizes that money in working sessions: what stays as a cushion, what each disposition is split into, what each payment really costs once interest is added, which payments bring money back and when, and when Kapital gets paid.

Everyone who has the access code sees and edits one shared record. Changes save automatically and show up on the other screens within a second.

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

Open http://localhost:3000 and type the access code.

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
7. Moving data from an older copy of the page: open the old page, click Backup, then Copy. Open the new page, click Restore, paste, and click Restore. The restored record replaces what is there for everyone.

### Without a database

The app can keep the record in a JSON file instead. On Railway the file system is wiped on every deploy, so the file must live on a Volume:

1. On the project canvas, right click the app service and choose Attach Volume. Set the mount path to `/data`.
2. In the app service Variables, set `DATA_FILE` to `/data/record.json` and do not set `DATABASE_URL`.

PostgreSQL is the better choice. It keeps backups and survives moving the service.

## How saving works

* The page loads the record, remembers its version and saves 800 ms after the last edit.
* The server saves only if the version the page started from is still current. If someone else saved first, the server answers with their record, the page merges the two and saves again.
* Merging: the newer edit wins for the top fields (available, TIIE, spread and cushion, as one group) and for each disposition on its own. Removed dispositions leave a tombstone for 30 days so they do not come back.
* A disposition someone is typing in is never replaced under their cursor. The newer copy waits until they leave that block.
* Other screens hear about every save through a live connection and pull the new record. They also check every 60 seconds.
* Which dispositions are collapsed is remembered per browser and is not part of the shared record.

## Files

* `server.js` Express server, login, security headers, record API, live events.
* `db.js` PostgreSQL store and JSON file store with the same interface.
* `public/index.html`, `public/app.js`, `public/styles.css` The page.
* `public/login.html`, `public/login.js` The access code page.
* `test/run.js` End to end checks with jsdom.
