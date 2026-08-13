# UE4SS Object Explorer

**[u34ss-explorer.gimme.pet](https://u34ss-explorer.gimme.pet)**

A browser-based explorer for [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) `DumpObjects` output - the very large text files an Unreal Engine game emits when you ask it to enumerate every live `UObject`.

Drop the dump in and it becomes a searchable, filterable, linkable index of the game's object graph. Nothing is uploaded; the file is parsed and stored in your own browser. Built for Palworld modding, but the format is UE4SS's, not the game's, so it works for most UE4SS-supported titles.

<!-- ![screenshot](docs/screenshot.png) -->

## Why it exists

A UE4SS object dump is a text file with one line per object and no index:

```
[00000226E92B0000] Package /Script/CoreUObject [n: 13891] [c: 00000226DCC55980] [or: 0000000000000000]
```

At ~292,000 objects and 59 MB, the usual tools give up. `Ctrl+F` in an editor answers one question at a time, and grep can't tell you what *owns* the thing you found. This turns the file into a structure you can navigate.

## Features

- **Package tree** — the `/Script/…` and `/Game/…` hierarchy, built from the dump's own path separators (`/`, `.`, `:`), with object counts per node. Sort branches by weight or alphabetically.
- **Virtualized table** — all 292k rows in one scroller, rendering only the ~60 on screen. Columns are click-to-sort (asc → desc → dump order) and drag-to-resize, with widths remembered between visits.
- **Faceted filtering** — full-path and leaf-name substring search, path scoping, and type chips whose counts stay live against everything *except* the type filter itself.
- **Inspector** — address, field offset, full path, and a resolved link to the object's `Outer`, so you can walk ownership upward.
- **Shareable views** — every dump gets a content hash; that hash plus the active filters live in the URL. Send someone a link and they land on your exact view, provided they hold the same dump.
- **Filter history** — each change is recorded as a frame with back/forward navigation. Branching from an earlier frame truncates the ones after it, like a browser but scoped to the query.
- **Hosted dumps** — dumps the site ships with are listed but never auto-downloaded; one click fetches, caches and opens.
- **Type-coded rows** — UE's type zoo collapses into six families by colour. The address gutter ghosts the leading hex digits every object shares and lights only the ones that differ.

## Breakdown

Nuxt 4 / Vue 3 / TypeScript, statically generated, no backend. The interesting parts are all about not letting 59 MB touch the main thread.

**Columnar parse.** A byte-level tokenizer reads the dump into parallel typed arrays — `Float64Array` of addresses, `Uint8Array` path blob with offset indices, interned type ids — rather than an array of objects. No per-row allocation, no GC pressure, and the result is a set of buffers that `postMessage` and IndexedDB both move without serialising. Parses 59 MB in ~700 ms.

The line format is harder than it looks: object paths contain spaces, so trailing `[k: v]` groups have to be peeled from the *right*; enum constants carry no path at all; and UE4SS occasionally truncates a record mid-write. Each shape is handled and counted rather than silently dropped.

**Worker-owned state.** The parsed columns never leave the Web Worker; the UI asks for a window of rows and gets ~60 plain objects back. Queries are a single linear pass over every row, comparing case-folded bytes in the path blob directly. At this scale that is cheaper to run than an inverted index would be to maintain.

**Sorting under virtualization.** Because windowing is over a `Uint32Array` of matching row indices, order is decided *before* any chunk is handed out. A re-sort is one comparator pass in the worker, not a merge across already-delivered pages.

**Content addressing.** Dumps are identified by a 64-bit FNV-1a over every byte — four interleaved lanes to break the multiply dependency chain, ~50 ms for 59 MB. Content-only is the point: two people holding the same file must derive the same id, so the hash can't include the filename or the parse time.

**Build-time prebake.** `npm run prebake` parses a dump into a flat `.pdx` bundle of length-prefixed column buffers. Homogeneous columns gzip far better than JSON — 40 MB down to 4.3 MB on the wire — and the browser does one fetch and a few typed-array views instead of parsing anything.

## Running it

```bash
npm install
npm run dev                                   # localhost:3000
npm run build                                 # static site in .output/public

npm run prebake -- dump.txt public/dump.pdx   # optional: ship a parsed dump
```

Docker, serving the static output through nginx:

```bash
docker compose up              # localhost:8080
docker compose --profile dev up
```

To offer a dump from the site, drop the file in `public/` and add an entry to `public/dumps.json`.

Measurements above are from the the only included Palworld dump: 58.9 MB, 292,342 objects.
