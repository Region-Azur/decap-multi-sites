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
      content: {
        output: true
      },
      pages: {
        output: true,
        permalink: '/:path/'
      }
    }
  });
}

function getChirpyConfig(title) {
  return yaml.dump({
    title: title,
    tagline: 'Built with Decap CMS',
    description: 'A minimal, responsive and feature-rich Jekyll theme for technical writing.',
    url: '', // Will be overridden by GH Pages
    author: 'Admin',
    remote_theme: 'cotes2020/jekyll-theme-chirpy',
    theme_mode: 'light', // light, dark, manual
    lang: 'en',
    timezone: 'UTC',
    collections: {
      content: {
        output: true
      },
      pages: {
        output: true,
        permalink: '/:path/'
      }
    }
  });
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
        run: count=$(find . -maxdepth 1 -name '_config.yml' | wc -l); if [[ $count == 0 ]]; then echo "No _config.yml found"; exit 1; fi; bundle exec jekyll b -d "_site" \${{ steps.pages.outputs.base_path }}
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

function getTemplateFiles(theme, title) {
  const files = {};

  // Common Index Content
  files['index.md'] = `---
layout: home
title: Home
---

# Welcome to ${title}

This site is managed by Decap CMS.
`;

  // Detect Chirpy variants
  const isChirpy = theme === 'chirpy' || theme.includes('chirpy');

  if (isChirpy) {
    // Advanced setup for Chirpy
    files['_config.yml'] = getChirpyConfig(title);
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
    // Workflow for Actions
    files['.github/workflows/pages.yml'] = getChirpyWorkflow();
  } else {
    // Standard setup
    files['_config.yml'] = getStandardConfig(title, theme || 'minima');
  }

  return files;
}

module.exports = {
  getTemplateFiles,
  STANDARD_THEMES
};
