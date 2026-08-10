# Inventory Scanner

A phone-based inventory tool for a small repair shop. Scan a part's barcode
or QR label with the phone camera and add or remove one unit of stock with a
single tap. Everything lives in a Google Sheet you already own — there is no
server to run and no app store. Optional per-user PINs (managed as a plain
tab in that same Sheet) add a sign-in step and a named audit trail.

```
Phone browser  ──HTTPS──▶  Google Apps Script Web App  ──▶  Google Sheet
(this page on              (runs inside YOUR Google         (tabs: Inventory,
 GitHub Pages)              account; the only part            Audit)
                            with any authority)
```

The web page holds **no credentials of any kind** — the only thing it stores
is the Web App URL you give it during setup.

---

## One-time setup (about 10 minutes)

> **First time doing anything like this?** Follow the
> **[step-by-step Setup Guide](SETUP.md)** instead — it walks through every
> click with a checkpoint after each step, including the scary-looking
> Google authorization screen and a first-scan test at the end. The short
> version below covers the same ground for people comfortable with Google
> Sheets.

### Part 1 — The Google Sheet backend

1. Create a new Google Sheet (or open the one you want to use). Any name is
   fine. The two tabs the app needs — **Inventory** and **Audit** — are
   created automatically with the right headers the first time the app talks
   to the sheet, so you don't have to make them yourself.
2. In the sheet, open **Extensions → Apps Script**.
3. Delete whatever is in the editor and paste the full contents of
   [`apps-script/Code.js`](apps-script/Code.js) from this repository. Save
   (💾 or Ctrl/Cmd-S) and give the project a name like *Inventory Scanner*.
4. Click **Deploy → New deployment**. Choose type **Web app** and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Click **Deploy**, then **Authorize access** and approve with your Google
   account. (Google shows a "this app isn't verified" warning for personal
   scripts — click *Advanced → Go to … (unsafe)*. It is your own script
   running in your own account.)
6. Copy the **Web app URL** (it starts with
   `https://script.google.com/macros/s/…/exec`). That URL is the only thing
   the phone app needs.

### Part 2 — The phone app

1. On your phone, open **`https://smarkovik.github.io/kiroki/`**.
   (It must be this `https://` address — browsers only allow camera access on
   secure pages.)
2. Paste the Web app URL into the setup screen and tap **Test & save**. The
   app checks it is really talking to your backend before saving.
3. Add it to your home screen so it opens like an app:
   - **iPhone (Safari):** Share button → *Add to Home Screen*
   - **Android (Chrome):** ⋮ menu → *Add to Home screen*

## Everyday use

- Tap **Scan a part** and point the camera at the label. UPC/EAN retail
  barcodes, Code 128/39 labels, and QR codes all work.
- A known part shows its name and current stock with two big buttons:
  **− Remove one** and **+ Add one**. Each tap writes to the Sheet
  immediately, then the camera reopens for the next part.
- An unknown code is not an error — the app offers to add it as a new part
  with a name and starting quantity.
- **View inventory** shows the whole stock list on the phone — searchable by
  name or code, and tapping a part opens its card so you can add/remove
  without scanning.
- The stock can never go below zero; the app tells you if there is nothing
  left to remove.
- Every change is also appended to the **Audit** tab: when, which part,
  add/remove, by how much, the resulting quantity — and who did it, when
  users & PINs are set up (see below). The app never edits or deletes audit
  rows.

## Pointing the app at a different spreadsheet

By default the script uses the spreadsheet it is bound to. To use another
one instead:

1. In the Apps Script editor, find `const SHEET_ID = '';` near the top of the
   file and paste the target spreadsheet's ID between the quotes (the long
   token in the sheet's URL, between `/d/` and `/edit`).
2. Save, then publish the change: **Deploy → Manage deployments → ✏️ Edit →
   Version: New version → Deploy**.

That last step matters for *any* script edit: **the deployment serves a
frozen version, not the editor's code**. Editing without deploying a new
version changes nothing for the app. Redeploying an existing deployment
keeps the same URL, so the phones don't need reconfiguring.

## Automated Apps Script deploys (optional, recommended)

Instead of pasting `Code.js` into the editor by hand after every change, the
`Deploy Apps Script` workflow can do it: whenever a change under
`apps-script/` lands on `main` (and the tests pass), CI pushes the code to
your Apps Script project and publishes a new version of your **existing**
deployment — same URL, phones unaffected, nothing to click.

One-time setup (~10 minutes):

1. **Enable the Apps Script API** for your Google account:
   <https://script.google.com/home/usersettings> → *Google Apps Script API* → On.
2. **Create credentials on your computer** (needs Node.js):
   ```sh
   npm install -g @google/clasp@2.4.2
   clasp login
   ```
   A browser window asks you to authorize; afterwards your credentials are
   in `~/.clasprc.json`. (Use exactly this clasp version — v3 changed the
   credential format the workflow expects.)
3. **Collect the two IDs:**
   - *Script ID* — Apps Script editor → ⚙️ **Project Settings** → Script ID.
   - *Deployment ID* — the long token in your Web App URL, between
     `/macros/s/` and `/exec`.
4. **Add three repository secrets** (GitHub → Settings → Secrets and
   variables → Actions → *New repository secret*):

   | Secret | Value |
   |---|---|
   | `CLASPRC_JSON` | the full contents of `~/.clasprc.json` |
   | `APPS_SCRIPT_ID` | the Script ID |
   | `APPS_SCRIPT_DEPLOYMENT_ID` | the Deployment ID |

5. **Test it:** GitHub → Actions → *Deploy Apps Script* → **Run workflow**.
   Green run = from now on the manual paste-and-redeploy dance is gone.

Until the secrets exist, the workflow skips the deploy with a notice instead
of failing, so nothing breaks if you never set this up.

Notes:
- The script's manifest now lives in the repo
  (`apps-script/appsscript.json`) and is pushed along with the code: V8
  runtime, web app set to *Execute as: Me* / *Who has access: Anyone*, and
  the `Europe/Skopje` timezone for audit timestamps — edit it there if any
  of that should differ.
- `CLASPRC_JSON` is a credential for your Google account — treat it like a
  password. Revoke it anytime at <https://myaccount.google.com/permissions>
  (remove *clasp — The Apps Script CLI*).

## Optional: users & PINs (a named audit trail)

Out of the box, anyone who opens the app page *and* has the Web App URL can
scan and change stock, and audit rows are anonymous. To require a personal
PIN before scanning — and record **who** made every change:

1. Open the Google Sheet and click the **Users** tab (it is created
   automatically the first time the app connects; headers `Name`, `PIN`).
2. Add one row per person: their name in column A, their PIN in column B —
   e.g. `Marko | 2468`. **Each PIN must be unique** — sign-in is by PIN
   alone, and the app refuses a PIN assigned to two people rather than
   guess who it was.

That's all — no redeployment, it takes effect immediately. Each phone now
shows a **Sign in** screen once, remembers the person from then on
("Signed in as Marko" on the home screen, with a *Switch user* button), and
every row in the **Audit** tab gets their name in the **User** column.

The check happens in the backend, not just the app, so it can't be skipped
by calling the URL directly. To **change** a PIN, edit the cell — that
person signs in again with the new PIN on their next action. To **remove**
someone, delete their row. To **switch PINs off entirely**, delete all the
user rows — the app goes back to open, anonymous mode.

*Honest security note:* PINs travel over HTTPS and are remembered on each
phone — right-sized for knowing who did what and keeping a curious visitor
from tapping buttons, not for defending against a determined attacker.
Keeping the Web App URL private is still the main gate.

## If the Web App URL leaks

The URL is unguessable but it is the only gate, so if it ever gets out:

1. **Deploy → Manage deployments → Archive** the deployment — this kills the
   old URL immediately.
2. Create a **New deployment** (same settings) — you get a fresh URL.
3. Enter the new URL on each phone via **Backend settings**.

The Web App only exposes four operations (ping / lookup / inventory list /
stock write) — the last three require a PIN when users are configured. It
cannot be used to read other tabs, formulas, files, or anything else in the
Google account.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "…deployment must be Execute as Me / access Anyone" | The URL is answering with a Google sign-in page. Redeploy the Web app with **Execute as: Me** and **Who has access: Anyone**, and use the new URL. |
| Camera never opens / no permission prompt | Make sure you opened the `https://…github.io…` address, then allow Camera in the browser's site settings. |
| "scanner library failed to load" | The phone couldn't reach either CDN — check WiFi and tap Scan again. |
| "Backend took too long" / "Could not reach the backend" | Check WiFi, then verify the URL under **Backend settings** with Test & save. |
| "Wrong PIN" / sign-in screen keeps coming back | Your row in the **Users** tab was changed or removed — check your PIN there. If nobody set up users on purpose, delete all rows under the headers (see the users section above). |
| "This PIN is assigned to more than one user" | Two rows in the **Users** tab share a PIN — give one of them a different PIN. |

## For developers

| Path | Purpose |
|---|---|
| `index.html` | Entire frontend: single file, no build step, hand-rolled Material Design 3 CSS, light/dark. |
| `apps-script/Code.js` | Entire backend. The same file runs in Apps Script and under Node — pure logic is exported behind a `typeof module` guard. |
| `test/backend.test.js` | Unit tests for the pure backend logic. Zero dependencies. |
| `.github/workflows/pages.yml` | Runs the tests on Node 22, then deploys the repo root to GitHub Pages. One-time setup: in the repo's **Settings → Pages**, set **Source: GitHub Actions** before the first deploy — the workflow's own token isn't allowed to switch Pages on. |

Run the tests with Node 18+:

```sh
npm test
```

Smoke-test a deployed backend end-to-end (expects a fresh sheet; afterwards
`TEST-001` has qty 1 and the Audit tab has exactly two rows):

```sh
URL='https://script.google.com/macros/s/…/exec'
curl -sL "$URL?action=ping"
curl -sL "$URL?action=lookup&barcode=TEST-001"
curl -sL -H 'Content-Type: text/plain;charset=utf-8' \
     -d '{"action":"create","barcode":"TEST-001","name":"Test part","startQty":0}' "$URL"
curl -sL -H 'Content-Type: text/plain;charset=utf-8' \
     -d '{"action":"adjust","barcode":"TEST-001","delta":1}' "$URL"
```

API details (GET lookup/ping, POST adjust/create, error codes, concurrency
locking, audit semantics) are documented in the comments of
[`apps-script/Code.js`](apps-script/Code.js).

## License

[MIT](LICENSE)
