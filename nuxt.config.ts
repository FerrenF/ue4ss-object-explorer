import { NOSCRIPT } from './app/seo/noscript'

/** Canonical origin. Also the default for runtimeConfig.public.urlBase; robots.txt and sitemap.xml repeat it. */
const SITE = 'https://u34ss-explorer.gimme.pet'
const TITLE = 'UE4SS Object Explorer: browse UE4SS object dumps in your browser'
const DESCRIPTION =
  'Free browser-based explorer for UE4SS object dumps. Search, filter and navigate an Unreal Engine ' +
  "game's classes, functions, parameters and properties. Built for Palworld modding; nothing is uploaded."

export default defineNuxtConfig({
  srcDir: 'app/',

  // nothing here is renderable without the dump in memory
  ssr: false,

  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: TITLE,
      meta: [
        { name: 'description', content: DESCRIPTION },
        { name: 'theme-color', content: '#0f1319' },
        { property: 'og:type', content: 'website' },
        { property: 'og:site_name', content: 'UE4SS Object Explorer' },
        { property: 'og:title', content: TITLE },
        { property: 'og:description', content: DESCRIPTION },
        { property: 'og:url', content: SITE + '/' },
        { name: 'twitter:card', content: 'summary' },
      ],
      script: [
        {
          type: 'application/ld+json',
          innerHTML: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'UE4SS Object Explorer',
            url: SITE + '/',
            description: DESCRIPTION,
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Any (runs in a web browser)',
            browserRequirements: 'Requires JavaScript',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        },
      ],
      // The app is client-only, so the generated body is otherwise empty.
      noscript: [{ innerHTML: NOSCRIPT, tagPosition: 'bodyOpen' }],
      link: [
        // Shared views are `?dump=…` query strings on the one page; they all
        // describe the same document as far as an index is concerned.
        { rel: 'canonical', href: SITE + '/' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap',
        },
      ],
    },
  },

  vite: {
    worker: { format: 'es' },
  },

  runtimeConfig: { 
    public: {      
       urlBase: SITE
    }
  },

  modules: ['@nuxt/image']
})