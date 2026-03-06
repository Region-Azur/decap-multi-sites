# decap-multi-sites

A Dockerized, OIDC-authenticated Decap CMS hub for managing content across multiple GitHub repositories.

## What it does
- Users sign in once via `oauth2-proxy` (Hitobito OIDC)
- They see only sites they are allowed to edit
- Decap edits are proxied through the API and committed with a GitHub App
- Each site builds/deploys independently via GitHub Pages workflows

## Architecture

```text
[TLS Reverse Proxy] -> [oauth2-proxy] -> [portal + api] -> [SQLite/MySQL]
                                         \-> [GitHub App API]
```

- `services/portal`: site picker UI, Decap shell, config endpoints
- `services/api`: auth + permission checks, git-gateway compatible proxy, admin endpoints
- `services/shared/db.js`: schema + DB access helpers used by both services

## Main flow
1. User opens CMS and authenticates via OIDC
2. Portal resolves/creates user from forwarded headers
3. Portal shows permitted sites (`/sites`)
4. User opens editor (`/sites/:siteId`)
5. Decap calls API (`/.netlify/git/...` and `/api/...`)
6. API validates permission and writes to the mapped GitHub repo

## Current key routes

### Portal (`services/portal/index.js`)
- `GET /` -> redirect to `/sites`
- `GET /sites` -> site picker
- `GET /sites/:siteId` -> Decap shell
- `GET /admin` -> admin panel (admin only)
- `GET /configs/:siteId.yml` -> legacy dynamic config
- `GET /health`

### API (`services/api/index.js`)
- `GET /health`
- `GET /api/user`
- `PUT /api/sites/:siteId/settings`
- `POST /api/admin/sites`, `PUT /api/admin/sites/:siteId`, `DELETE /api/admin/sites/:siteId`
- `POST /api/admin/sites/:siteId/template`
- `POST /api/admin/sites/:siteId/reset`
- `POST /api/admin/permissions`, `DELETE /api/admin/permissions`
- Git gateway proxy via `/.netlify/git/*`

## Data model (minimal)
- `users`: identity + admin flag
- `sites`: site id, display name, `github_repo`, branch, content/media paths, branding fields
- `site_permissions`: user-to-site access mapping
- `api_tokens`: session/API tokens used by Decap shell

## Quick start

### 1) Configure env
Copy `.env.example` to `.env` and fill at minimum:
- DB: `DATABASE_URL=sqlite:///data/cms.sqlite` (default, using bind mount to `./sqlite/`)
- OIDC: provider/client vars for oauth2-proxy
- GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`

### 2) Start stack

**Default (SQLite):**
```bash
docker compose -f docker-compose.yml up -d
```

**With MySQL (if using mysql variant):**
```bash
docker compose -f docker-compose.mysql.yml up -d
```

**Note**: The SQLite database file will be created at `./sqlite/cms.sqlite` on the host machine.

### 3) Configure reverse proxy
Route traffic through oauth2-proxy so forwarded identity headers reach portal/api.

## Common pitfalls
- `github_repo` must be `owner/repo` with no extra spaces (trim owner and repo)
- Missing GitHub App install permission -> repo writes fail
- Missing required Chirpy/template files -> GitHub Pages build fails
- Permission issues -> verify user exists and has `site_permissions` row

## Useful logs
```bash
docker compose logs -f portal
docker compose logs -f api
docker compose logs -f oauth2-proxy
```

## Static Assets
The project uses centralized static assets for favicons and logos.

### Favicon & Logo Configuration
- **Location**: `static-assets/favicon/` directory contains all favicon and logo files
- **Structure**:
  - Favicon files: `favicon.ico`, `favicon-*.png`, `apple-touch-icon.png`
  - Logo SVGs: `region-azur-dms-logo.svg`, `midata.svg`, `example-logo.svg`
- **How it works**: Portal Dockerfile copies files from `static-assets/favicon/` to container's `/app/public/` during build
- **Access control**: OAuth2-proxy allows unauthenticated access to these files via skip-auth regex
- **To change**: Replace files in `static-assets/favicon/` and rebuild Docker containers
- **robots.txt**: Managed separately in `oauth2-proxy-templates/robots.txt`

## Notes
- First user bootstrap/admin behavior depends on current service logic and env (`ADMIN_EMAILS`)
- API currently keeps a large monolithic `index.js`; modular files also exist for ongoing refactor
- For implementation details and agent-specific guidance, see `AGENTS.md`
