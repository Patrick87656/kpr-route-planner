# Hosting on GitHub Pages (phones + iPads)

Live GPS in Drive mode only works on an `https://` page. GitHub Pages gives
you one for free at `https://YOUR-USERNAME.github.io/kpr-route-planner/`.
People open that link once, add it to their home screen, and it then
launches full-screen like an app.

Replace `YOUR-USERNAME` below with your GitHub username.

## Before you start

- **The repo must be public.** Free GitHub Pages needs it. Anyone can read
  the code (there are no secrets in it). Since this is a Nissan tool, check
  with IT that a public repo and a public web page are OK.
- **The page has no login.** Anyone who has the link can open it and use
  your Mapbox quota. Step 2 limits the token to your site so other sites
  can't use it.
- **The token is not stored in git.** It goes in a GitHub secret, and the
  deploy workflow writes it into the published site. Anyone who opens the
  live page can still see it, as with every Mapbox web token.

## 1. Create the repo

On github.com: **New repository** → name `kpr-route-planner` → **Public** →
leave it empty (no README or .gitignore) → **Create repository**.

## 2. Make a restricted Mapbox token

You can't URL-restrict your default public token, so make a new one for
the hosted site.

1. Go to https://account.mapbox.com/access-tokens/ → **Create a token**.
2. Name: `KPR hosted`. Keep the default public scopes. Don't add any
   secret scopes.
3. Under **URL restrictions**, add `https://YOUR-USERNAME.github.io` with
   **no path**. Browsers only send the site's origin to Mapbox, so a URL
   that includes `/kpr-route-planner/` would block your own page.
4. **Create token** and copy it (`pk.…`).

Keep using your current unrestricted token in your local
`config.local.js` so `localhost` keeps working.

## 3. Add the token to the repo

In the repo: **Settings → Secrets and variables → Actions → New repository
secret**. Name it `MAPBOX_TOKEN` and paste the `pk.…` token as the value.

The deploy fails with a clear error if the secret is missing or isn't a
`pk.` token.

## 4. Turn on Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

## 5. Push the code

In PowerShell, from this folder (Git lives at the per-user path, not on
PATH):

```powershell
$git = "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
& $git init -b main
& $git add .
& $git status          # config.local.js must NOT be listed
& $git commit -m "KPR Route Planner: initial Mapbox PWA"
& $git remote add origin https://github.com/YOUR-USERNAME/kpr-route-planner.git
& $git push -u origin main
```

The push starts the **Deploy to GitHub Pages** workflow. Watch it in the
**Actions** tab (about 1 minute). When it's green, the site is live at
`https://YOUR-USERNAME.github.io/kpr-route-planner/`.

The first push goes straight to `main` because there's nothing to branch
from yet. After that, use the normal branch → PR → merge flow. Every merge
to `main` redeploys.

## 6. Install on devices

- **iPhone / iPad (Safari):** open the link → **Share** → **Add to Home
  Screen**. On iOS this only works in Safari.
- **Android (Chrome):** open the link → **⋮** menu → **Install app** (or
  **Add to Home screen**).

The first time someone taps **Start drive**, the device asks for location
access. Choose **Allow While Using App**.

### iPads that live in the vehicles

- **Settings → Display & Brightness → Auto-Lock → Never** (and keep them
  plugged in). The app also asks the browser to keep the screen on, but
  iPadOS doesn't always honor that for home-screen apps.
- **Settings → Privacy & Security → Location Services → Safari Websites →
  While Using the App**, with **Precise Location** on.
- GPS stops whenever the screen is off or another app is in front. That's
  a browser rule for all web apps.

## Updating

Merge to `main` and the workflow redeploys. Devices pick up the new
version the next time the app is opened. Sometimes it takes a second open,
because the cached copy loads first and then refreshes in the background.

## If something's wrong

| Symptom | Fix |
|---|---|
| Map is blank or shows a token error | Check that the token's URL restriction is exactly `https://YOUR-USERNAME.github.io` (no path, no trailing slash) |
| Workflow fails: "MAPBOX_TOKEN is not set" | Redo step 3. The secret name must match exactly |
| Site URL is a 404 | Set step 4 to **GitHub Actions**, then re-run the workflow (Actions tab → **Run workflow**) |
| "Location blocked" in Drive mode, or the locate button is greyed out | Allow location for Safari / Chrome in the device settings (see above). Some work PCs block browser location by policy, and only IT can change that. The simulated drive (▶) still works without GPS |
