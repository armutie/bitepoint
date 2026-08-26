# Track image importer

Run `npm run dev`, then open `http://localhost:5173/tools/track-importer/`.

The importer is deliberately semi-automatic: it traces the shape, while a human confirms the mask, start/finish point, direction, real lap length, and road width. It exports a normal Bite Point `TrackData` JSON file plus the matching manifest entry.

Best inputs are clean, top-down maps with one continuous black route on a light background, like a circuit-outline diagram. The importer reduces that uniform stroke to its true middle and filters disconnected corner labels, watermarks, and lighter pit-lane marks. Coloured-sector and bright-line modes remain available for other references, but a clean black-line map is the most reliable source.

Generated tracks are drafts. Drive and inspect them before adding the JSON to `public/tracks/` and the copied entry to `public/tracks/manifest.json`.
