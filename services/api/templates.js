const yaml = require('js-yaml');

const STANDARD_THEMES = [
  'minima',
  'jekyll-theme-slate',
  'jekyll-theme-cayman',
  'jekyll-theme-merlot',
  'jekyll-theme-midnight',
  'jekyll-theme-time-machine',
  'jekyll-theme-hacker',
  'jekyll-theme-tactile'
];

function getStandardConfig(title, theme) {
  // Map friendly names to actual gem names if needed, 
  // but for simplicity we'll assume the UI sends the full gem name 
  // or we map it here.
  let themeGem = theme;
  if (!themeGem.startsWith('jekyll-theme-') && themeGem !== 'minima') {
    themeGem = `jekyll-theme-${theme}`;
  }

  return yaml.dump({
    title: title,
    theme: themeGem,
    plugins: ['jekyll-seo-tag'],
    collections: {
      pages: {
        output: true,
        permalink: '/:path/'
      }
    },
    defaults: [
      {
        scope: {
          path: "content"
        },
        values: {
          permalink: "/:slug/"
        }
      }
    ]
  });
}

function getChirpyConfig(title, options = {}) {
  const {
    pageTitle = title,
    suptitle = 'Built with Decap CMS',
    avatarIcon = '',
    favicon = '',
  } = options;

  return yaml.dump({
    title: pageTitle,
    tagline: suptitle,
    description: 'A minimal, responsive and feature-rich Jekyll theme for technical writing.',
    url: '', // Will be overridden by GH Pages
    author: 'Aure 2',
    social: {
      name: 'Aure 2',
      links: ['https://aure2.ch']
    },
    avatar: avatarIcon,
    favicon: favicon,
    theme: 'jekyll-theme-chirpy',
    theme_mode: 'light', // light, dark, manual
    lang: 'en',
    timezone: 'UTC',
    collections: {
      pages: {
        output: true,
        permalink: '/:path/'
      }
    },
    defaults: [
      {
        scope: {
          path: "content"
        },
        values: {
          permalink: "/:slug/",
          toc: true
        }
      }
    ]
  });
}

function getChirpyFooterOverride() {
  return `<footer aria-label="Site info" class="site-footer h-card">
  <p>
    © <a href="https://aure2.ch" target="_blank" rel="noopener">Aure 2</a> 2026 . Some rights reserved.
    <button id="license-btn" style="margin-left:.5rem; border:1px solid #cfcfcf; background:#fff; border-radius:4px; padding:.15rem .5rem; cursor:pointer;">CC BY 4.0</button>
  </p>
  <dialog id="license-dialog" style="max-width:680px; border-radius:8px; border:1px solid #d1d5db; padding:1rem 1.2rem;">
    <p>
      Except where otherwise noted, the blog posts on this site are licensed under the
      <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">Creative Commons Attribution 4.0 International (CC BY 4.0)</a>
      License by the author.
    </p>
    <form method="dialog"><button>Close</button></form>
  </dialog>
  <script>
    (() => {
      const btn = document.getElementById('license-btn');
      const dialog = document.getElementById('license-dialog');
      if (!btn || !dialog) return;
      btn.addEventListener('click', () => {
        if (typeof dialog.showModal === 'function') dialog.showModal();
      });
    })();
  </script>
</footer>
`;
}

function getChirpyWorkflow() {
  return `name: "Build and Deploy"
on:
  push:
    branches:
      - main
      - master
  workflow_dispatch:

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: 3.2
          bundler-cache: true

      - name: Setup Pages
        id: pages
        uses: actions/configure-pages@v5

      - name: Build with Jekyll
        run: count=$(find . -maxdepth 1 -name '_config.yml' | wc -l); if [[ $count == 0 ]]; then echo "No _config.yml found"; exit 1; fi; bundle exec jekyll b -d "_site" --baseurl "\${{ steps.pages.outputs.base_path }}"
        env:
          JEKYLL_ENV: production

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

function getStandardWorkflow() {
  return `name: "Deploy Jekyll site to Pages"
on:
  push:
    branches:
      - main
      - master
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Pages
        id: pages
        uses: actions/configure-pages@v5

      - name: Build with Jekyll
        uses: actions/jekyll-build-pages@v1
        with:
          source: ./
          destination: ./_site

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

function getTemplateFiles(theme, title, options = {}) {
  const files = {};

  // Common Index Content (Decap-editable in content folder)
  files['content/index.md'] = `---
title: Home
layout: page
permalink: /
toc: true
tags:
  - page
---

# Welcome to ${title}

This site is managed by Decap CMS.

## Getting Started

Use Decap CMS to create pages and posts.

## Next Steps

Edit this page in Decap CMS.
`;

  // Detect Chirpy variants
  const isChirpy = theme === 'chirpy' || theme.includes('chirpy');

  if (isChirpy) {
    // Advanced setup for Chirpy
    files['_config.yml'] = getChirpyConfig(title, options);
    files['Gemfile'] = `source "https://rubygems.org"
gem "jekyll"
gem "jekyll-theme-chirpy"
`;
    // Chirpy often needs a contact data file or it complains
    files['_data/contact.yml'] = `# Contact info
-
  type: github
  icon: "fab fa-github"
  url: "https://github.com/cotes2020/jekyll-theme-chirpy"
`;
    files['_includes/footer.html'] = getChirpyFooterOverride();
    // Workflow for Actions
    files['.github/workflows/pages.yml'] = getChirpyWorkflow();
  } else {
    // Standard setup
    files['_config.yml'] = getStandardConfig(title, theme || 'minima');
    files['.github/workflows/pages.yml'] = getStandardWorkflow();
  }

  return files;
}

module.exports = {
  getTemplateFiles,
  STANDARD_THEMES
};
