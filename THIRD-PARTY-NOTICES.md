# Third-party notices

The Docker image bundles the following third-party software. Each licence
text ships inside the image next to the code it covers.

| Component | Licence | Where in the image | Licence text |
|---|---|---|---|
| [Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app) (built from a pinned commit, patched: `patches/m2m/`) | MIT (code), CC0 (bundled assets) | `/app/rig/` | `/app/rig/LICENSE-MIT.MD`, `/app/rig/LICENSE-CC0.MD` |
| [three.js](https://github.com/mrdoob/three.js) (core + example loaders/exporters, vendored) | MIT | `/app/ui/webgl/vendor/` | `/app/ui/webgl/vendor/LICENSE-three.txt` |
| [fflate](https://github.com/101arrowz/fflate) | MIT | `/app/ui/webgl/vendor/fflate.module.js` | `/app/ui/webgl/vendor/LICENSE-fflate.txt` |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | `/app/node_modules/sharp/` | `/app/node_modules/sharp/LICENSE` |
| [libvips](https://github.com/libvips/libvips) (prebuilt with sharp) | LGPL-3.0-or-later | `/app/node_modules/@img/` | inside the `@img/sharp-libvips-*` package |
| [ag-psd](https://github.com/Agamnentzar/ag-psd) | MIT | `/app/node_modules/ag-psd/` | `/app/node_modules/ag-psd/LICENSE` |
| [Node.js](https://nodejs.org) (base image) | MIT and others | `/usr/local/` | see the `node` image |

Poly Vault itself is MIT licensed (`/app/LICENSE`).
