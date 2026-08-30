# Third-party notices

## Earth textures

The Earth day, night, bump, roughness, and cloud textures in
`src/assets/images/earth/` are resized/combined derivatives of the Solar System
Scope planet textures. `background.jpg` preserves the downloaded 2K stars image.

- Source: https://www.solarsystemscope.com/textures/
- 2K stars source: https://www.solarsystemscope.com/textures/download/2k_stars.jpg
- Creator: Solar System Scope
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
  https://creativecommons.org/licenses/by/4.0/

The node-material treatment is adapted from the Three.js WebGPU TSL Earth
example (Three.js, MIT License):
https://threejs.org/examples/webgpu_tsl_earth.html

## DB-IP City Lite

The application can download `dbip-city-lite@1.0.16` on explicit user request.
The database is not bundled with this application. It is downloaded into and
queried from the user's browser storage.

- Source: https://www.npmjs.com/package/dbip-city-lite/v/1.0.16
- Data provider: DB-IP.com, https://db-ip.com/db/lite.php
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
  https://creativecommons.org/licenses/by/4.0/

IP geolocation data provided by DB-IP.com.

## Bundled flag emoji fonts

`src/assets/fonts/NotoColorEmoji-flagsonly.ttf` is a flag-only subset derived from Google Noto
Color Emoji. Copyright 2013 Google LLC. Noto Color Emoji font software is distributed under the
SIL Open Font License 1.1. The required copyright and license text is included at
`licenses/NotoColorEmoji-OFL-1.1.txt`.

- Source: https://github.com/googlefonts/noto-emoji
- License: SIL Open Font License 1.1

`src/assets/fonts/TwemojiMozilla-flags.woff2` is a flag-only subset derived from the Twemoji Mozilla
font created by the Mozilla Foundation from the Twemoji artwork. The font build code is licensed
under Apache License 2.0. The emoji artwork is Copyright 2020 Twitter, Inc. and other contributors
and is licensed under Creative Commons Attribution 4.0 International. This project changed the
original font by retaining only flag glyphs and converting/subsetting it to WOFF2.

- Font source: https://github.com/mozilla/twemoji-colr
- Artwork source: https://github.com/jdecked/twemoji
- Apache License 2.0: `licenses/Apache-2.0.txt`
- Attribution and CC BY 4.0 terms: `licenses/TwemojiMozilla-NOTICE.md`
