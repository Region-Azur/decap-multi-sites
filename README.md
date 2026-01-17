# decap-multi-sites
A Dockerized, OpenID Connect–authenticated portal for hosting a single Decap CMS instance that manages and publishes content to multiple Git repositories.

## Goal
Provide a central CMS entry point where users authenticate against an external Hitobito OIDC instance, pick a site they are authorized to edit, and then use a single Decap UI to edit content. A backend enforces permissions and commits changes to the correct GitHub repository, which deploys to GitHub Pages via existing workflows.

## High-level architecture

```
[TLS Reverse Proxy] -> [oauth2-proxy (Hitobito OIDC)] -> [Portal + API] -> [DB]
                                              \-> [GitHub App API]
```

### Components
- **Reverse proxy**: Nginx Proxy Manager (ngxpm) for TLS termination, routing, and header sanitization.
- **oauth2-proxy**: Handles Hitobito OIDC login; injects identity headers.
- **Portal**: Site picker UI, Decap loader, and per-site config endpoint.
- **Backend API**: Git writer + admin API, enforces permissions and commits to GitHub.
- **DB**: SQLite (default) or MySQL for users, sites, and permissions.

## Minimal data model

### tables
- `users`
  - `id` (uuid)
  - `oidc_issuer` (string)
  - `oidc_sub` (string) — stable unique user ID from Hitobito
  - `email` (string)
  - `name` (string)
  - `is_admin` (bool)
- `sites`
  - `id` (string, e.g. `sitea`)
  - `display_name`
  - `github_repo` (e.g. `org/repo`)
  - `branch` (e.g. `main`)
  - `content_path` (e.g. `content/`)
  - `media_path` (e.g. `static/uploads/`)
  - `enabled` (bool)
- `site_permissions`
  - `user_id`
  - `site_id`
  - `role` (e.g. `editor`/`publisher`, optional)

This supports “admin grants per-site access.”

## User flow
1. User visits `https://cms.example.org/admin`.
2. oauth2-proxy forces Hitobito login.
3. Portal receives authenticated headers and looks up/creates user by `(issuer, sub)`.
4. Portal queries permissions and renders a site picker with only permitted sites.
5. User chooses a site.
6. Portal serves Decap UI for that site (same UI, different config URL).
7. Decap loads `/configs/{site}.yml`.
8. Backend enforces permissions on every API call and commits to the correct repo.

## Admin flow
Admin uses the same OIDC login and visits `/admin-panel` (or `/api/admin/*`) to:
- Create/update sites (repo, paths, enabled).
- Search users (by email).
- Grant/revoke site permissions.

**Admin determination**
- Simplest: `is_admin=true` for selected users in DB.
- Bootstrap: first logged-in user becomes admin, or use an env var list of admin emails.

## Portal endpoints (Pattern C)
- `GET /admin`
  - HTML site picker + admin panel link (if admin).
- `GET /admin/{site}`
  - Returns Decap HTML with:
    - `<link rel="cms-config-url" href="/configs/{site}.yml">`
- `GET /configs/{site}.yml`
  - Checks permission; if allowed returns Decap config for that site; otherwise 403.

The Decap UI is identical for all sites; only the config changes.

## Backend responsibilities (permission enforcement)
All actions must be validated server-side. Do **not** rely on UI-only restrictions.

Backend must:
- Authenticate requests (trust oauth2-proxy headers only from internal network).
- Map request → user (issuer + sub).
- Map `site_id` → repo/paths from DB.
- Check `site_permissions` before:
  - listing files
  - reading files (optional; usually allow if editor)
  - writing/deleting files
  - uploading media

### Commit mechanism
- Use a GitHub App installation token.
- Commit to the site repo branch.
- Optional commit prefix: `[cms] {user_email}` for audit.

## Docker layout
- `proxy` (ngxpm): TLS + routes; strips inbound auth headers.
- `oauth2-proxy`: OIDC login against Hitobito; forwards identity headers.
- `portal`: serves site picker + Decap UI + config endpoint.
- `api`: git-writer + admin API + DB access.
- `db`: SQLite (default) or MySQL.

## Required configuration
### Hitobito
- OIDC client for oauth2-proxy.
- Redirect URI to `/oauth2/callback`.
- Scopes that provide stable `sub` and `email`.

### GitHub
- GitHub App with Contents write permissions.
- Install on each site repo.
- Store App private key + app id as secrets for the backend.
- If storing the private key base64-encoded, set `GITHUB_APP_PRIVATE_KEY_BASE64=true`.
- GitHub App settings tips:
  - **Homepage URL is required** by GitHub when creating the app. It can be your public CMS URL (for example `https://cms.example.org`) or a placeholder like `https://example.org` if you do not have a public homepage yet.
  - **Expire user authorization tokens** is **not required** for this project. We use GitHub App installation tokens (server-to-server), not user-to-server tokens, so no refresh token flow is needed.

### Hugo repos
- GitHub Actions workflow: build Hugo and deploy to Pages on push.

## Database support
This project is designed to work with both SQLite and MySQL. Use a `DATABASE_URL` that matches the target engine, for example:
- `sqlite:///data/cms.sqlite`
- `mysql://cms:cms-pass@mysql:3306/cms`

## Portal + API starter implementation
This repo includes an initial Node.js implementation for the portal and API services under `services/portal` and `services/api`. The services:
- Auto-create the SQLite/MySQL schema on startup.
- Bootstrap the first logged-in user as admin, or use `ADMIN_EMAILS`.
- Render a simple site picker at `/admin` and serve Decap via `/admin/{site}`.
- Provide basic admin endpoints (`/api/admin/sites`, `/api/admin/permissions`) to manage sites and permissions.
- Expose a GitHub App-powered git-writer API for reading and writing repository content.

### Git-writer API (GitHub App)
The API implements minimal file operations using the GitHub Contents API. These routes all enforce site permissions:
- `GET /api/sites/:siteId/contents?path=...` (read a file or list a directory)
- `PUT /api/sites/:siteId/contents` (create/update a file)
- `DELETE /api/sites/:siteId/contents` (delete a file)

The `PUT` and `DELETE` endpoints accept commit messages and ensure commits are made on the site’s configured branch.

## Example docker-compose
An example `docker-compose.yml` and `.env.example` are included. Most settings are configured via environment variables so you can keep secrets in a local `.env` file. The stack uses Nginx Proxy Manager (ngxpm) for reverse proxying; configure hosts and TLS through its admin UI on port `81`.

## Deployment overview
Yes — the intended flow is to **deploy this repo to a server** and run it with Docker Compose. A typical approach is:
1. Clone/pull this repository on your server.
2. Copy `.env.example` to `.env` and fill in your OIDC, GitHub App, and database settings.
3. Start the stack with `docker compose up -d` (SQLite) or `docker compose --profile mysql up -d` (MySQL).
4. Configure Nginx Proxy Manager host routes and TLS in its UI (port `81`) so `/admin`, `/configs`, and `/api` are correctly routed via oauth2-proxy and the services.

With that in place, the portal and API should run, and Decap will be able to read/write to the GitHub repos as soon as the GitHub App is installed and the site records exist.

### Quick start (SQLite)
1. Copy the env template: `cp .env.example .env`.
2. Ensure `DATABASE_URL=sqlite:///data/cms.sqlite`.
3. Start the stack: `docker compose up -d`.

### Quick start (MySQL)
1. Copy the env template: `cp .env.example .env`.
2. Set `DATABASE_URL=mysql://cms:cms-pass@mysql:3306/cms`.
3. Start the stack: `docker compose --profile mysql up -d`.

## Hugo theme selection (Lotus Docs example)
The **theme is defined in each Hugo site repository**, not in this CMS stack. To use the [Lotus Docs theme](https://github.com/colinwilson/lotusdocs) for a specific site:
1. In the Hugo repo, add the theme as a git submodule (or vendored theme directory).
   - Example: `git submodule add https://github.com/colinwilson/lotusdocs themes/lotusdocs`
2. Update the Hugo config (`hugo.yaml`, `hugo.toml`, or `config.toml`) to set:
   - `theme: lotusdocs` (YAML) or `theme = "lotusdocs"` (TOML).
3. Commit and push. Your existing GitHub Actions workflow will build with the theme.

If you want Decap to manage the theme’s content/config, you can add the relevant paths to your Decap collections and keep the theme in the repo (or submodule) so the site build can resolve it.

## Practical permission patterns
- Default: no one has access until admin grants it.
- Admin UI shows:
  - Users list
  - Sites list
  - Per-user checkboxes for permitted sites
- Optional enhancements:
  - Roles per site (editor vs publisher)
  - Approval workflow (commit to branch + PR)

## Implementation checklist
- Implement DB schema and migrations.
- Configure oauth2-proxy with Hitobito issuer/discovery and header passing.
- Portal:
  - user bootstrap
  - site picker (reads permissions)
  - per-site Decap loader
  - config endpoint with permission checks
- Backend:
  - permission checks on every request
  - GitHub App commit logic
  - media upload handling
  - admin endpoints to manage users/sites/permissions
- GitHub Actions in each Hugo repo to publish Pages.

## Bootstrap workflow for new sites
For each new site:
1. Create repo from template.
2. Install GitHub App on that repo.
3. Add a `sites` row in the admin panel.

This delivers exactly: user chooses a site; admin grants per-site access; edits deploy automatically.
