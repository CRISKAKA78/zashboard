# License and attribution audit

This repository and the incorporated Zephyruso/zashboard baseline use the MIT License. The root
`LICENSE` retains the upstream `Copyright 2024 Zephyruso` notice. Local Rule Intelligence and Helper
changes are distributed under the same repository license; no second license header is used.

## Code provenance

- Base: `Zephyruso/zashboard`, incorporated as the credited source baseline described in `README.md`.
- Mihomo: consumed through its public Controller API and CLI; no Mihomo binary is stored or installed
  by this repository.
- `liandu2024/AnGe-ClashBoard`: product/feature reference only. This repository is not based on its
  server architecture or old components. A history-aware comparison found no substantial copied code
  sequence requiring an additional AnGe notice.
- Bundled flag emoji fonts, 3D textures, and related assets retain their specific notices and
  license references in
  `public/THIRD_PARTY_NOTICES.md`.

## npm dependencies

The lockfile is the source of truth for exact versions. All 56 direct dependency package manifests were
found and checked as part of public readiness; none lacked a declared license. The declared licenses
are permissive or otherwise compatible with source
distribution under MIT (primarily MIT, Apache-2.0, BSD, ISC, and OFL-1.1). This is an engineering audit,
not a substitute for legal advice, and transitive metadata should be rechecked whenever the lockfile
changes.

The public install path copies only the Helper source and the `yaml` runtime package. `yaml` declares
ISC. Frontend dependencies are build-time inputs; `node_modules` and `dist` are ignored and are not
committed.

The repository Dockerfile likewise builds `build:no-fonts` and produces only a static UI image. It is
not a prebuilt artifact and does not bundle Mihomo or Local Helper.

## Font build restriction

Public deployment uses:

```bash
pnpm build:no-fonts
```

The inherited `subsetted-fonts@1.0.4` package declares MIT, but its archive includes PingFang subsets
without an accompanying independently verifiable original font license. A package-level MIT field is
not treated here as proof that every source font can be redistributed. Therefore this project does not
designate the inherited `build`, `build:pingfang-only`, or other `subsetted-fonts` variants as public
release artifacts.

The optional scripts remain solely to preserve upstream compatibility. Anyone choosing a font-bearing
build must perform their own font-license review and provide all required notices. Do not attach such a
bundle to a project Release based only on the npm package's license field.

## Release checklist

Before any future public binary or container release:

1. build from the exact committed lockfile with `build:no-fonts`;
2. confirm `LICENSE`, `public/THIRD_PARTY_NOTICES.md`, and `public/licenses/` are included;
3. regenerate the direct/transitive dependency license report;
4. inspect the archive for fonts, credentials, runtime configuration, backups, and logs;
5. record the exact Git commit and do not present upstream artifacts as this project's build.
