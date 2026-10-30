# Relay — URL Downloader

A complete Cloudflare **Workers** application. Paste a direct file URL, fetch it into temporary R2 storage, and download the saved file through your own site.

## Deploy from GitHub

1. Extract this ZIP and upload its **contents** to the root of a GitHub repository. `package.json`, `wrangler.jsonc`, `src/`, `public/`, `scripts/`, and `migrations/` must be at the repository root.
2. In Cloudflare, choose **Workers & Pages → Create application → Connect a repository**, then create a **Worker** from that repository.
3. Use these settings:

| Setting | Value |
| --- | --- |
| Worker name | `relay-url-downloader` |
| Root directory | `/` |
| Build command | Leave empty |
| Deploy command | `npx wrangler deploy` |
| Production branch | Your main branch |
| Node.js | 24 or newer |

4. Enable R2 on your account. The configuration uses Workers Paid limits. Your build token needs permission to manage Workers, D1, R2, and Workflows; add D1 and Workflows permissions if your automatically generated token lacks them.
5. Deploy. The internal Wrangler hook creates `relay-db` if it is missing and applies pending D1 migrations **before** the Worker is uploaded. Wrangler provisions or connects `relay-temporary-files`, and the deployment registers the `relay-transfers` Workflow and the cleanup Cron Trigger.
6. Open the resulting Worker URL. The header should say **Ready to relay**.

No separate frontend build, Pages project, container, or Supabase project is needed. `npm run deploy` is an optional alias for the same `wrangler deploy` command.

Keep the dashboard Worker name and the `name` in `wrangler.jsonc` consistent. If Cloudflare has chosen a different Worker name, change `name` before deploying. For another independent installation, also change the D1 database name, R2 bucket name, and Workflow name so it does not share storage with this one.

The D1 migration hook expects `wrangler.jsonc` to remain valid JSON, as supplied. Avoid adding comments to that file. No account-specific database ID is required for the first deployment. If you already have a database, you can add its real `database_id` to the DB binding.

Do not use a preview/version-upload command as the production deploy command. This package targets a normal Workers production deployment.

## Included features

- A live server-fetch progress bar, percentage, received bytes, total size, speed, and estimated remaining time.
- Indeterminate progress plus received bytes when the source does not provide a reliable total size.
- Independent background Workflows: closing the page does not stop the server transfer.
- Bounded 8 MiB multipart buffers, rather than buffering the whole file in memory.
- Byte-range fetching with per-part retries when the source provides ranges and a stable validator.
- Automatic streaming fallback when range requests are ignored, rejected, encoded, or inconsistent. Previously uploaded parts are discarded before restarting a full source request. Retrying the full download restarts it from the beginning.
- Download, rename, retry, cancel, search, status filters, and immediate deletion.
- Open the original URL in a new tab from its source hostname or the file menu.
- Per-browser private transfer lists, using a random 256-bit device key.
- Per-file capability URLs, attachment downloads, and resumable single-range downloads.
- System, light, and dark themes; responsive desktop, tablet, and phone layouts.
- Expiry enforced by the download API, with scheduled physical cleanup.

## Progress on Safari and other browsers

The progress bar on the site measures **the source → Relay storage** transfer on every browser, including iPad Safari. Once the file is ready, **Download** starts a normal browser-managed download. Its progress is shown in the browser's download manager.

On browsers with the File System Access API, the file menu also includes **Save with progress**. That action streams directly to a selected local file and shows **Relay → your device** progress inside the site. The browser must support `showSaveFilePicker`; Safari does not expose this feature. The app does not buffer multi-gigabyte device downloads into a Blob to imitate this feature.

## Defaults

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_FILE_BYTES` | `5368709120` | 5 GiB per file |
| `MAX_STORED_BYTES` | `21474836480` | 20 GiB of completed files plus active reservations |
| `MAX_ACTIVE_PER_DEVICE` | `2` | Active transfers for one device key |
| `MAX_GLOBAL_ACTIVE` | `4` | Active transfers across the site |
| `RETENTION_HOURS` | `24` | Retention after a transfer completes |
| `ALLOWED_ORIGINS` | Empty | Optional comma-separated frontend origins; unnecessary for this all-in-one deployment |

Each active transfer reserves the per-file maximum until it finishes. This prevents unknown-size files from bypassing storage admission limits. A successfully completed file is then charged against the admission limit at its actual size. This is an application admission limit, not a Cloudflare billing cap.

The cleanup Cron runs every 10 minutes. Expired files become inaccessible immediately at their deadline; physical deletion follows in a cleanup run. Failed and cancelled multipart uploads are aborted. Rare uploads interrupted before their upload ID is recorded are subject to R2's incomplete-upload lifecycle policy; configure an abort policy for the bucket if you want a shorter cleanup fallback.

Transfer metadata is retained for up to seven days. Expired, failed, or cancelled entries can be retried during that period. Deleting an entry removes it from the user's list immediately. Clearing browser site data loses that browser's device key; files are still cleaned up by the server.

For larger configured files, review R2 multipart limits, Workflows step and subrequest limits, available storage, and your plan first. The validation ceiling is 64 GiB; the supplied, tested deployment configuration is 5 GiB per file. Raising the ceiling alone does not raise platform limits.

## Supported sources

Public direct HTTP and HTTPS file URLs, including ordinary redirects and signed download URLs. Source credentials, custom headers, cookies, CAPTCHA solving, and video watch-page extraction are not supported. Sources can reject data-center requests or require authentication; those failures are shown in the transfer list.

HTML responses are rejected with a direct-file explanation to avoid saving a login or error page as the requested file. When a source changes its validator or returns inconsistent byte ranges, Relay discards the partial upload and starts a fresh full download. Bytes from different versions are never combined. Each request resolves redirects again from the original URL, so it does not depend on reusing a temporary CDN location.

## Access and storage

The site requires no user account. Each browser receives a device key; the server stores its SHA-256 hash and checks it for list and management operations. A completed file's download URL is a bearer capability: anyone who receives that URL can download **that file** until expiry or deletion. The R2 bucket should remain private.

Source URLs, including signed query parameters, are stored in D1 to allow retries and must be treated as private operational data. Do not enable request URL logging for capability URLs at your own proxy. Only HTTP and HTTPS are accepted. Private/reserved address literals, local hostnames, and DNS answers pointing to private addresses are rejected, and redirects are checked individually. DNS screening does not pin DNS answers; the application relies on Cloudflare's public fetch network as well. Do not move this fetch implementation into a private-network server without adding a pinned-address outbound proxy.

## Local development

Use Node.js 24 or newer:

```bash
npm ci
npm run db:local
npm run dev
```

Local development uses local D1, R2, and Workflows state. `wrangler dev` does not run the remote database setup hook.

```bash
npm test
npm run check
```

`npm run check` bundles a dry-run deployment without accessing your Cloudflare account or running remote migrations. If using `npx wrangler deploy --dry-run` directly, set `RELAY_SKIP_DB_SETUP=1` first to prevent the real deployment's database hook from running.

## Validation

The included integration tests use SQLite with the actual schema and a deterministic R2/Workflows test adapter. They cover exact multipart bytes, sources without a total size, empty files, source changes, size limits, cancellation, device isolation, admission limits, byte ranges, expiry, redirect validation, and cleanup starvation. Regression cases also cover range-to-full fallback after saved parts, missing validators, inconsistent ranges, changed source data, fresh redirect resolution, and rejecting incomplete full-download responses. The Worker also passes Wrangler's dry-run bundling check.

A real deployment still needs a Cloudflare account with the resources and permissions above. A live multi-gigabyte transfer has not been exercised against your account.

## Platform documentation

- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Wrangler custom build hooks](https://developers.cloudflare.com/workers/wrangler/custom-builds/)
- [R2 multipart uploads](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)

## Updating to 1.0.3

Deploy this cumulative package with the same Worker and storage names. No database migration is added. After deploying, use **Retry** on transfers that already failed with the partial-download error; Retry creates a fresh Workflow instance that uses the corrected download logic. The automatic fallback may reset received bytes to zero because a full download restarts from the beginning.
