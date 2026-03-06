# Portal Service (`services/portal`)

Express service for the CMS frontend: site picker, admin panel, and Decap shell.

## Responsibilities
- Resolve logged-in user from forwarded OIDC headers
- Show sites the user may access (`/sites`)
- Render Decap editor shell (`/sites/:siteId`)
- Render admin UI (`/admin`) for admin users
- Serve dynamic/legacy Decap config (`/configs/:siteId.yml`)

## Structure

```text
services/portal/
├── index.js
├── config.js
├── middleware/
│   ├── auth.js
│   └── permissions.js
├── views/
│   ├── sitePicker.js
│   ├── adminPanel.js
│   └── decapShell.js
└── public/
    ├── css/
    └── js/
```

## Core routes (`index.js`)
- `GET /` -> redirect to `/sites`
- `GET /sites` -> picker for permitted sites
- `GET /sites/:siteId` -> Decap editor shell for one site
- `GET /admin` -> admin panel
- `GET /sites/config.yml` -> minimal fallback config
- `GET /configs/:siteId.yml` -> legacy per-site config
- `GET /health`

## Config (`config.js`)
Common env vars:
- `PORT`
- `DATABASE_URL`
- `ADMIN_EMAILS`
- `DEFAULT_OIDC_ISSUER`
- `API_BASE_URL`
- `USERINFO_URL_OVERRIDE`

## Local run
```bash
npm install
npm start
```

## Dev notes
- HTML is server-rendered from `views/*`
- Static files are served from `public/`
- Do not trust UI-only checks; permission enforcement also happens in API
- If routes/paths change in portal, keep API proxy paths and Decap config in sync
