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
    domain = '', // Custom domain if set
    githubRepo = '', // For baseurl calculation
  } = options;

  const normalizedAvatarIcon = (avatarIcon || '').trim();

  // Determine baseurl and url based on domain
  let baseurl = '';
  let url = '';
  
  if (domain && domain.trim()) {
    // Custom domain: use root path
    baseurl = '';
    url = `https://${domain.trim()}`;
  } else if (githubRepo && githubRepo.trim()) {
    // GitHub Pages: use repo name as baseurl
    const repoParts = githubRepo.split('/');
    const repoName = repoParts[repoParts.length - 1];
    baseurl = `/${repoName}`;
    url = `https://${repoParts[0]}.github.io${baseurl}`;
  }

  const config = {
    // The Site Configuration

    // Basic Info
    title: pageTitle,
    tagline: suptitle,
    description: 'A minimal, responsive and feature-rich Jekyll theme for technical writing.',

    // URL Configuration
    baseurl: baseurl,
    url: url,

    // Author Info
    author: 'Region AZUR',

    // Social Links (used in footer and sidebar)
    social: {
      name: 'Region AZUR',
      links: [
        'https://region-azur.ch',
      ]
    },

    // Theme Configuration
    theme: 'jekyll-theme-chirpy',

    // Language and timezone
    lang: 'en',
    timezone: 'Europe/Zurich',

    // PWA (Progressive Web App) Support
    pwa: {
      enabled: true,
      cache: {
        deny_paths: []
      }
    },

    // Ensure proper directories are included and built
    include: [
      '_tabs',
      'content',
      '_plugins'
    ],

    // THE MAGIC: Defaults that automatically apply to content folder
    defaults: [
      {
        scope: {
          path: "content"  // Targets your custom folder exactly
        },
        values: {
          layout: "content_page",  // Routes to custom layout that handles TOC
          toc: true,  // Enables TOC rendering
          panel_includes: ["toc"],  // Forces Chirpy to draw the right-hand sidebar panel
          permalink: "/:basename"  // Strips '/content/' and outputs clean URLs
        }
      }
    ],
    collections: {
      tabs: {
        output: true
      }
    }
  };

  // Add avatar if provided
  if (normalizedAvatarIcon) {
    config.avatar = normalizedAvatarIcon;
  }

  // Note: Chirpy expects favicons in assets/img/favicons/ directory
  // Don't set favicon in _config.yml - it won't work properly

  return yaml.dump(config);
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
        with:
          enablement: true

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
        with:
          enablement: true

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
---

# Welcome to ${title}

This site is managed by Decap CMS.

## Getting Started

Use Decap CMS to create pages and posts.

### Creating Your First Page

Navigate to the Decap CMS interface to begin creating content.

### Editing Content

All pages can be edited through the content management system.

## Features

This site includes several features:

### Table of Contents

Automatically generated from your page headings.

### Responsive Design

Works on all devices and screen sizes.

## Next Steps

Edit this page in Decap CMS to customize your content.
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
 gem "jekyll-theme-chirpy", "~> 7.0"

 group :jekyll_plugins do
   gem "jekyll-seo-tag"
   gem "jekyll-sitemap"
   gem "jekyll-feed"
 end
 `;

    files['_plugins/sidebar_tabs.rb'] = `# frozen_string_literal: true

module Jekyll
  class SidebarTabsGenerator < Generator
    safe true
    priority :low

    def generate(site)
      tabs = site.collections['tabs']
      return unless tabs

      generated = {}

      site.pages.each do |page|
        next unless page.data['sidebar']
        next unless page.url

        title = (page.data['sidebar_title'] || page.data['title'] || '').strip
        next if title.empty?

        icon = (page.data['sidebar_icon'] || '').strip
        order = page.data['sidebar_order']
        slug = page.data['slug'] || File.basename(page.path, File.extname(page.path))
        slug = slug.to_s.downcase.gsub(/[^a-z0-9_-]+/, '-').gsub(/-+/, '-').gsub(/\A-+|-+\z/, '')
        slug = 'page' if slug.empty?

        tab_path = File.join(site.source, '_tabs', '_generated', "#{slug}.md")
        next if generated[tab_path]
        generated[tab_path] = true

        doc = Jekyll::Document.new(tab_path, { site: site, collection: tabs })
        doc.content = ''
        doc.data['layout'] = 'page'
        doc.data['title'] = title
        doc.data['icon'] = icon unless icon.empty?
        doc.data['order'] = order if order
        doc.data['permalink'] = page.url
        doc.data['published'] = false

        tabs.docs << doc
      end
    end
  end
end
`;

    // Contact data configuration
    files['_data/contact.yml'] = `# Contact info

- type: stack-overflow
  icon: 'fa-solid fa-paperclip'
  url:  'https://region-azur.ch'

- type: stack-overflow
  icon: 'fa-solid fa-at'
  url:  'https://region-azur.ch/kontakt/'
`;

    // Custom page layout for proper TOC support with Tocbot
    files['_layouts/content_page.html'] = `---
layout: page
---

<button id="copy-link" style="display: none;"></button>

<article class="px-1" data-toc="true">
  <div class="content">
    {{ content }}
  </div>
</article>

<script src="https://cdn.jsdelivr.net/npm/tocbot@4.32.2/dist/tocbot.min.js"></script>

<script type="text/javascript">
/*<![CDATA[*/
document.addEventListener("DOMContentLoaded", function() {
  var sidebar = document.querySelector("#panel-wrapper .access");
  if (sidebar && !document.getElementById("toc-wrapper")) {
    sidebar.insertAdjacentHTML("afterend", "<section id=\\"toc-wrapper\\" class=\\"d-none\\"><h2 class=\\"panel-heading ps-3 pt-2 mb-2\\">Contents</h2><nav id=\\"toc\\"></nav></section>");
  }
  if (typeof tocbot !== "undefined" && document.getElementById("toc-wrapper")) {
    tocbot.init({
      tocSelector: "#toc",
      contentSelector: ".content",
      ignoreSelector: "[data-toc-skip]",
      headingSelector: "h2, h3, h4",
      orderedList: false,
      scrollSmooth: false
    });
    document.getElementById("toc-wrapper").classList.remove("d-none");
  }
});
/*]]>*/
</script>
`;

    files['_includes/download.html'] = `{% assign href = include.href | default: "" %}
{% if href == "" %}
  <span class="text-danger">Missing download link</span>
{% else %}
  {% assign variant = include.variant | default: "primary" %}
  {% assign new_tab = include.new_tab | default: true %}
  {% assign download_attr = include.download %}
  {% if download_attr != false %}
    {% assign download_attr = true %}
  {% endif %}
  {% assign base_classes = "btn btn-" | append: variant %}
  {% if variant == "link" %}
    {% assign base_classes = "link" %}
  {% endif %}
  {% assign extra_class = include.class | default: "" %}
  <a class="{{ base_classes }} download-link {{ extra_class }}"
     href="{{ href | relative_url }}"
     {% if new_tab %}target="_blank" rel="noopener noreferrer"{% endif %}
     {% if download_attr %}download{% endif %}>
    {{ include.label | default: "Download" }}
  </a>
{% endif %}
`;

    // Don't override footer.html - let Chirpy use its defaults
    // The social links in _config.yml already handle the footer customization
    // Favicons are generated automatically and added via the admin route

    // Custom search.json to index content pages in Chirpy's search bar
    files['assets/js/data/search.json'] = `---
layout: none
---
[
  {% assign first_item = true %}

  {% for post in site.posts %}
    {% unless first_item %},{% endunless %}
    {
      "title": {{ post.title | jsonify }},
      "url": {{ post.url | relative_url | jsonify }},
      "categories": {{ post.categories | join: ', ' | jsonify }},
      "tags": {{ post.tags | join: ', ' | jsonify }},
      "date": "{{ post.date | date: '%Y-%m-%d %H:%M:%S' }}",
      "snippet": {{ post.content | strip_html | normalize_whitespace | truncate: 200 | jsonify }},
      "content": {{ post.content | strip_html | normalize_whitespace | truncate: 200 | jsonify }}
    }
    {% assign first_item = false %}
  {% endfor %}

  {% assign custom_pages = site.pages | where: "layout", "content_page" %}
  {% for page in custom_pages %}
    {% unless first_item %},{% endunless %}
    {
      "title": {{ page.title | jsonify }},
      "url": {{ page.url | relative_url | jsonify }},
      "categories": "",
      "tags": "",
      "date": "{{ page.last_modified_at | default: site.time | date: '%Y-%m-%d %H:%M:%S' }}",
      "snippet": {{ page.content | strip_html | normalize_whitespace | truncate: 200 | jsonify }},
      "content": {{ page.content | strip_html | normalize_whitespace | truncate: 200 | jsonify }}
    }
    {% assign first_item = false %}
  {% endfor %}

  {% assign index_page = site.pages | where: "url", "/" | first %}
  {% if index_page %}
    {% unless first_item %},{% endunless %}
    {
      "title": {{ index_page.title | default: site.title | default: "Home" | jsonify }},
      "url": {{ index_page.url | relative_url | jsonify }},
      "categories": "",
      "tags": "",
      "date": "{{ index_page.last_modified_at | default: site.time | date: '%Y-%m-%d %H:%M:%S' }}",
      "snippet": {{ index_page.content | strip_html | normalize_whitespace | truncate: 200 | jsonify }},
      "content": {{ index_page.content | strip_html | normalize_whitespace | truncate: 200 | jsonify }}
    }
  {% endif %}
]
`;

    // Create the _tabs/_generated directory with .gitkeep so the plugin has a place to write
    files['_tabs/_generated/.gitkeep'] = '';

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
