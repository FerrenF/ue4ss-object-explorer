export default defineNuxtConfig({
  srcDir: 'app/',

  // nothing here is renderable without the dump in memory
  ssr: false,

  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],

  app: {
    head: {
      title: 'Object Dump Explorer',
      link: [
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
       urlBase: 'https://u34ss-explorer.gimme.pet'
    }
  },

  modules: ['@nuxt/image']
})