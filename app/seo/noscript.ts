/**
 * Rendered into <noscript> at the top of <body> (see nuxt.config.ts). The app
 * itself is client-only, so this is the whole page for crawlers that do not run
 * JavaScript and for visitors who have it turned off. main.css is linked in the
 * head regardless, so its tokens (--void, --ink, --amber...) apply here too.
 *
 * Plain HTML in a template string: no backticks or ${} in the markup.
 */
export const NOSCRIPT = /* html */ `
<style>
  .static { max-width: 720px; margin: 0 auto; padding: 40px 20px 64px; line-height: 1.65; }
  .static h1 { font-size: 30px; letter-spacing: -0.025em; color: var(--ink-strong); margin: 8px 0 12px; }
  .static h2 { font-size: 15px; color: var(--ink-strong); margin: 32px 0 8px; }
  .static p, .static li { color: var(--ink); max-width: 64ch; }
  .static a { color: var(--amber); }
  .static code, .static pre { font-family: var(--mono); font-size: 12px; }
  .static pre { overflow-x: auto; padding: 12px; background: var(--panel); border: 1px solid var(--rule); border-radius: 3px; color: var(--dim); }
  .static .notice { padding: 10px 12px; border: 1px solid var(--amber); border-radius: 3px; color: var(--amber); }
  .static .eyebrow { margin: 0; }
</style>
<main class="static">
  <p class="eyebrow">UE4SS Object Explorer</p>
  <h1>Browse UE4SS object dumps in your browser</h1>

  <p class="notice">
    This explorer runs entirely in your browser and needs JavaScript. Enable it
    and reload the page to open a dump.
  </p>

  <p>
    UE4SS Object Explorer is a free, browser-based viewer for the output of <a href="https://github.com/UE4SS-RE/RE-UE4SS">UE4SS</a>'s <code>DumpObjects</code>
    command: the very large text file an Unreal Engine game writes when it enumerates every live <code>UObject</code>. Drop the dump in and it becomes a
    searchable, filterable, linkable index of the game's classes, functions, properties, structs and enums.
  </p>
  <p>
    It was originally built for Palworld modding, but the format works with dumps from most games UE4SS supports.
  </p>

  <h2>Privacy</h2>
  <p>
    Nothing is uploaded. The dump is parsed in a Web Worker and cached in your browser's own storage, so a large dump opens instantly the next time.
  </p>

  <h2>How to make a dump</h2>
  <p>
  Heh. 
  Install <a href="https://github.com/UE4SS-RE/RE-UE4SS">UE4SS</a> for your game and trigger its object dumper (the <kbd>Ctrl</kbd>+<kbd>J</kbd> key binding by default). It writes <code>UE4SS_ObjectDump.txt</code> next to the UE4SS install. See the <a href="https://github.com/UE4SS-RE/RE-UE4SS/blob/main/docs/feature-overview/dumpers.md">UE4SS dumper documentation</a> for details.
  </p>
</main>
`
