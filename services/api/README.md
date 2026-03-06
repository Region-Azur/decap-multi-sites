# API Service (`services/api`)

Express API for auth, permissions, GitHub writes, and Decap Git Gateway compatibility.

## Responsibilities
- Authenticate requests from oauth2-proxy / Decap tokens
- Enforce per-site permissions
- Proxy Git operations via `/.netlify/git/*`
- Manage sites and permissions (admin endpoints)
- Deploy/update template files in GitHub repos via GitHub App

## Current status
- Production logic is currently centered in `index.js`
- Supporting modular folders (`middleware/`, `routes/`, `services/`, `utils/`) exist for ongoing refactor

## Structure

```text
services/api/
├── index.js
├── templates.js
├── config.js
├── middleware/
├── routes/
├── services/
├── utils/
└── shared/db.js
```

## Key endpoints (from `index.js`)
- Health/User
  - `GET /health`
  - `GET /api/user`
- Site settings/content
  - `PUT /api/sites/:siteId/settings`
  - `GET|PUT|DELETE /api/sites/:siteId/contents`
  - `GET /api/sites/:siteId/files`
- Admin
  - `GET /api/admin/sites`
  - `POST /api/admin/sites`
  - `PUT /api/admin/sites/:siteId`
  - `DELETE /api/admin/sites/:siteId`
  - `POST /api/admin/sites/:siteId/template`
  - `POST /api/admin/sites/:siteId/reset`
  - `POST /api/admin/permissions`
  - `DELETE /api/admin/permissions`
- Git Gateway proxy
  - `/.netlify/git/*`

## Required env
- `API_PORT` (default `4000`)
- `DATABASE_URL`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `ADMIN_EMAILS` (optional but recommended)

## Local run
```bash
npm install
npm start
```

## Operational notes
- `github_repo` must be normalized to `owner/repo` (trim spaces)
- Template deploy is idempotent; home page preservation logic protects `content/index.md`
- If GitHub writes fail, verify App installation scope and repo access first
- If Decap operations fail, inspect `/api/user`, site permission rows, and `/.netlify/git` logs
