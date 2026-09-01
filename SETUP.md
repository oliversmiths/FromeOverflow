# Setting it up

Three parts: get it running on your Mac, put it on GitHub, then point your
SiteGround site at it. Do them in order — each one assumes the last worked.

---

## Part 1 — Your local machine

### Check your Node version

```bash
node --version
```

You need **v23.4 or newer**. `node:sqlite` doesn't exist before that and the
poller won't start.

If you're on something older, install Node 24 with nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL           # reload so nvm is on your PATH
nvm install 24
nvm use 24
node --version        # should now say v24.x
```

If you'd rather use Homebrew: `brew install node` gets you current Node, but nvm
is worth it here because it lets you switch versions per project later.

### Run it

Unzip the project somewhere sensible, then:

```bash
cd frome-overflow-watch
npm run poll
```

You should see something like:

```
Fetching Wessex Water storm overflow feed…
  1427 overflows region-wide, 38 near Frome
  0 discharging, 1 offline, 38 new spills recorded
  wrote docs/data.json (38 monitors)
```

The region-wide number is Wessex's total; the second is your Frome list
(`PIN_TO_IDS` in `poll.js`). The first run records every overflow's most recent
spill, so "38 new spills" on run one is expected — it drops to 0 or 1 after that.

Then:

```bash
npm run serve
```

Open http://localhost:8000.

**If nothing loads**, check the terminal. `EADDRINUSE` means something else has
port 8000 — run `PORT=8001 npm run serve` instead.

**If the page says "No data yet"**, the poll didn't write `docs/data.json`.
Scroll back and read the poll output.

**Don't open `docs/index.html` by double-clicking it.** Browsers block both
`fetch` and module imports on `file://` URLs, so you'll get an empty page. It
has to be served.

### Look at your data

```bash
sqlite3 overflows.db "SELECT id, watercourse FROM monitors ORDER BY id;"
```

macOS ships with `sqlite3` already. This is how you find out which IDs you've
got so you can name them:

```bash
sqlite3 overflows.db "UPDATE monitors SET label='Welshmill Lane' WHERE id='WW-2140';"
```

Run `npm run poll` again to push the new labels into the page.

---

## Part 2 — GitHub, from VS Code

### Open the project

VS Code → **File → Open Folder** → pick `frome-overflow-watch`.

### Make it a repository

Click the **Source Control** icon in the left sidebar (the branching-lines one,
or `⌃⇧G`). Click **Initialize Repository**.

You'll now see every file listed as a change. Type a message like
`Frome overflow watch` in the box at the top and click **Commit**.

If it asks you to stage the changes first, say yes to staging all.

### Push it up

After committing, the button changes to **Publish Branch**. Click it. VS Code
asks whether to publish public or private — **choose public** unless you have a
reason not to. On a public repo, GitHub Actions minutes are unlimited and GitHub
Pages is free; on a **private** repo both are restricted (see "Going private"
below), and this is public-interest data about a public river anyway.

If VS Code hasn't got your GitHub credentials yet it'll open a browser to
authorise. Let it.

### Turn on the poller

Go to your new repo on github.com → **Actions** tab. GitHub will say workflows
are disabled on a new repo; click the button to enable them.

Then: **Poll storm overflows** in the left list → **Run workflow** → **Run
workflow**. This triggers it by hand so you don't wait 15 minutes to find out if
it works.

Give it a minute, then refresh. Green tick means it ran. Click into it to see
the same output you saw locally.

**If it fails on the push step**, the workflow lacks write permission. Go to
**Settings → Actions → General → Workflow permissions** and select **Read and
write permissions**.

### Make the 15-minute cadence reliable

The workflow's `schedule:` block is set to `7,22,37,52 * * * *` — deliberately
off the hour, because GitHub drops or badly delays scheduled runs around `:00`.
Even so, `schedule:` is best-effort: on a new, low-traffic repo GitHub silently
skips most 15-minute ticks. Treat it as a fallback only.

For the real cadence, have something outside GitHub call the `workflow_dispatch`
API every 15 minutes. [cron-job.org](https://cron-job.org) does this free:

1. **Make a token.** GitHub → **Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token**. Scope it to *only* the
   `FromeOverflow` repo, and under **Permissions → Repository permissions** set
   **Actions** to **Read and write**. Nothing else. Give it a 1-year expiry and
   copy the `github_pat_…` string.
2. **Create the cron job** at cron-job.org (free account):
   - URL: `https://api.github.com/repos/oliversmiths/FromeOverflow/actions/workflows/poll.yml/dispatches`
   - Schedule: every 15 minutes
   - Request method: **POST**
   - Under advanced / headers, add:
     - `Authorization: Bearer github_pat_…`
     - `Accept: application/vnd.github+json`
     - `X-GitHub-Api-Version: 2022-11-28`
   - Request body: `{"ref":"main"}`
3. **Save and hit "Test run."** A 204 (no content) response is success — check
   the repo's Actions tab and you'll see a `poll` run that was triggered by
   `workflow_dispatch`. If you get 401/403, the token scope is wrong.

The `concurrency: poll` block in the workflow means a stray double-trigger just
queues rather than running twice, so a bit of overlap between the external cron
and the `schedule:` fallback is harmless.

When the token nears expiry GitHub emails you; regenerate it and update the one
header at cron-job.org.

### Working on it afterwards

Pull before you edit, because the bot is committing to the same branch:

```bash
git pull
```

If you forget and get a conflict on `docs/data.json` or `overflows.db`, take the
remote version — the bot's copy is always newer than yours:

```bash
git checkout --theirs docs/data.json overflows.db
git add docs/data.json overflows.db
git rebase --continue
```

### Going private

Moving the external cron off GitHub's scheduler doesn't change what a private
repo costs you — the poll still runs on GitHub's runners and still bills the same
minutes. Two things bite on the **Free** plan:

- **GitHub Pages is disabled for private repos.** You'd need GitHub **Pro**
  (~$4/mo) to keep the `github.io` page, or serve the static `docs/` from
  SiteGround instead (Part 3, Option B) — that works regardless of repo
  visibility.
- **Actions minutes become metered:** 2,000 min/month free. A ~1-minute job
  every 15 minutes is ~2,900 min/month, over the limit. Options: GitHub Pro
  (3,000 min), drop the cadence to every 30 minutes (~1,400 min), or accept the
  per-minute overage charge.

So the cheapest "keep everything working, but private" answer is GitHub Pro at
~$4/mo, which covers both. If you don't want to pay, either stay public or move
hosting to SiteGround and slow the poll to 30 minutes.

---

## Part 3 — Deploying to SiteGround

### First, know what you're deploying

Nothing runs on SiteGround. GitHub Actions does the polling and produces three
static files in `docs/`. SiteGround serves them. That's the whole deployment.

This means it works on **any** SiteGround plan, including StartUp — you're not
relying on Node support they may not offer.

### Option A — Just use GitHub Pages (easiest)

If you don't specifically need it on your own domain, skip SiteGround entirely.

Repo → **Settings → Pages** → under **Source** pick **Deploy from a branch**,
branch `main`, folder `/docs`. Save.

A minute later it's live at `https://yourname.github.io/frome-overflow-watch/`.
Nothing else to configure, and it updates itself every time the poller commits.

You can still put it on your own domain: add a `CNAME` file in `docs/`
containing `overflows.yourdomain.com`, then in SiteGround's **Site Tools → Domain
→ DNS Zone Editor** add a CNAME record pointing `overflows` at
`yourname.github.io`.

### Option B — Serve it from SiteGround over SSH

Do this if you want the files genuinely on your own hosting.

**Check you have SSH.** Site Tools → **Devs → SSH Keys Manager**. If the section
isn't there, your plan doesn't include SSH — use Option A or C.

**1. Generate a key** on your Mac, dedicated to this deploy:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/frome_deploy -N "" -C "frome-overflow-watch"
```

Two files appear: `frome_deploy` (private — never commit this) and
`frome_deploy.pub` (public).

**2. Give SiteGround the public key.** In SSH Keys Manager, choose to import an
existing key, and paste the contents of:

```bash
cat ~/.ssh/frome_deploy.pub
```

The panel then shows you the **hostname, username and port** for SSH. Write them
down — the port is not 22.

**3. Test it** before involving GitHub:

```bash
ssh -i ~/.ssh/frome_deploy -p PORT USERNAME@HOSTNAME
```

Once you're in, find where your site lives and make a folder for this:

```bash
ls ~/www
mkdir -p ~/www/yourdomain.com/public_html/overflows
pwd                    # note the full path
exit
```

**4. Add the secrets to GitHub.** Repo → **Settings → Secrets and variables →
Actions**.

Under **Secrets**, add four:

| Name | Value |
|---|---|
| `SG_SSH_KEY` | the whole of `cat ~/.ssh/frome_deploy`, including the BEGIN and END lines |
| `SG_HOST` | the hostname from Site Tools |
| `SG_USER` | the username from Site Tools |
| `SG_PATH` | the full path you noted, e.g. `/home/customer/www/yourdomain.com/public_html/overflows` |
| `SG_PORT` | the port from Site Tools (usually `18765`) |

Then switch to the **Variables** tab and add `DEPLOY_TO_SITEGROUND` set to
`true`. The deploy step is skipped until this exists, which is why polling
worked fine before you got here.

**5. Run the workflow by hand** again and watch the deploy step. Your page
should be live at `https://yourdomain.com/overflows/`.

Note that the workflow uses `rsync --delete`, so the target folder is wiped to
match `docs/`. Point `SG_PATH` at a folder that holds nothing else.

### Option C — Drag and drop

Perfectly reasonable if you just want to see it working. Site Tools → **Site →
File Manager**, navigate to your `public_html`, upload the contents of `docs/`.

The catch is that it's a snapshot. `data.json` goes stale the moment the poller
next runs, so you'd be re-uploading by hand forever. Fine for a first look, not
for leaving up.

---

## A sanity check before you tell anyone about it

Let it collect for a week before you share the URL. The first days look
misleadingly quiet because you only have each overflow's most recent spill, not
its history — the 90-day strips (behind the clock button) fill in from the day
you started, not backwards, and read mostly grey until then.

And read the caveats in the README before you make any public claim about a
specific outfall. This data indicates discharges rather than confirming them,
and it won't match Wessex's verified annual returns.
