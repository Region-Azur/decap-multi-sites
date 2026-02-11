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
          permalink: "/:basename/"
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

  const normalizedAvatarIcon = (avatarIcon || '').trim();
  const normalizedFavicon = (favicon || '').trim();
  const effectiveFavicon = normalizedFavicon || normalizedAvatarIcon;

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
    ...(normalizedAvatarIcon ? { avatar: normalizedAvatarIcon } : {}),
    ...(effectiveFavicon ? { favicon: effectiveFavicon } : {}),
    theme: 'jekyll-theme-chirpy',
    theme_mode: 'manual', // light, dark, manual
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
          permalink: "/:basename/",
          toc: true
        }
      }
    ]
  });
}

function getChirpyFooterOverride() {
  return `<footer aria-label="Site info" class="site-footer h-card">
  <p>
    © <time>2026</time> Region Azur. <span data-bs-toggle="tooltip" data-bs-placement="top" title="Except where otherwise noted, the blog posts on this site are licensed under the Creative Commons Attribution 4.0 International (CC BY 4.0) License by the author.">Some rights reserved.</span>
  </p>
  <p>
    Using the <a data-bs-toggle="tooltip" data-bs-placement="top" href="https://github.com/cotes2020/jekyll-theme-chirpy" target="_blank" rel="noopener" title="v7.4.1">Chirpy</a> theme for <a href="https://jekyllrb.com" target="_blank" rel="noopener">Jekyll</a>.
  </p>
  <noscript>
    <p>
      Except where otherwise noted, the blog posts on this site are licensed under the
      <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">Creative Commons Attribution 4.0 International (CC BY 4.0)</a> License by the author.
    </p>
  </noscript>
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

  // Block indexing by search engines and common AI crawlers
  files['robots.txt'] = `User-agent: *
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: PerplexityBot
Disallow: /
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
