# Luxe blog + RSS (generated from Soro)

Every 3 hours, GitHub fetches your Soro articles, builds a static blog and `feed.xml`, and publishes them.

## One-time setup (about 15 minutes)

1. **Create a GitHub account/repo.** New repository, e.g. `luxe-blog`. Upload everything in this folder (keep the `.github/workflows` folder structure).
2. **Add your Soro token as a secret.** Repo > Settings > Secrets and variables > Actions > New repository secret.
   Name: `SORO_TOKEN`  Value: your Soro embed token (the long ID at the end of your embed script URL)
3. **Turn on Pages.** Repo > Settings > Pages > Source: **GitHub Actions**.
4. **First run.** Repo > Actions > "Build and publish blog + RSS" > Run workflow. Wait for the green tick.
5. **Custom subdomain.** At your domain registrar's DNS, add a CNAME record: `blog` -> `<your-github-username>.github.io`.
   Then Settings > Pages > Custom domain: `blog.luxemedicalprocedures.com.au`, tick Enforce HTTPS.
6. **Link it from Square Online.** Add "Blog" (and an "RSS" link in the footer) pointing to `https://blog.luxemedicalprocedures.com.au/` and `.../feed.xml`.

Your feed will be at `https://blog.luxemedicalprocedures.com.au/feed.xml`.

## Things you can change (config.json)

- `siteUrl` / `cname`: change if you use a different subdomain.
- `canonicalBase`: article pages tell Google your existing Square page `/blog?post=slug` is the "main" version, so the two copies don't compete. Remove this line to make the new pages the main version instead.
- `disclaimer` / `footerNote`: wording shown on every article. Have your compliance adviser confirm it.
- `feedItemLimit`: how many recent articles appear in the feed.

## Safety

If Soro is unreachable or any article fails to download, the run stops and the previous version stays online.

## Test locally

Save a copy of your Soro embed script as `test-fixture-embed.js` (it is git-ignored), then run `SORO_SCRIPT_FILE=./test-fixture-embed.js SORO_OFFLINE=1 node generate.mjs`. This builds with placeholder bodies and needs no network.
