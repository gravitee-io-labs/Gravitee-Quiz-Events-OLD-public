# Third-party licences

Everything vendored in `shared/` is permissively licensed. The files are committed; `tools/fetch-assets.sh` and `tools/build-sprite.mjs` reproduce them from npm.

| What | Where | Source | Licence |
|---|---|---|---|
| **Bricolage Grotesque** (display font, variable `opsz` + `wght`, latin + latin-ext subsets) | `fonts/bricolage-grotesque-*.woff2` | npm `@fontsource-variable/bricolage-grotesque` 5.3.0 (upstream: ateliertriay/bricolage) | SIL Open Font License 1.1: `fonts/OFL-bricolage-grotesque.txt` |
| **Inter** (text font, variable `wght`, latin + latin-ext subsets) | `fonts/inter-*.woff2` | npm `@fontsource-variable/inter` 5.3.0 (upstream: rsms/inter) | SIL Open Font License 1.1: `fonts/OFL-inter.txt` |
| **Phosphor Icons** (182 symbols composed into `icons/sprite.svg`) | `icons/sprite.svg` | npm `@phosphor-icons/core` 2.1.1, <https://phosphoricons.com> | MIT, Copyright (c) 2023 Phosphor Icons (text below) |
| **qrcode-generator** (QR matrix, ES module build) | `vendor/qrcode.js` | npm `qrcode-generator` 2.0.4, Kazuhiko Arase, <http://www.d-project.com/> | MIT (licence header kept at the top of the file). "QR Code" is a registered trademark of DENSO WAVE INCORPORATED. |
| **Gravitee logos** | `img/gravitee-*.svg` | copied from `assets/gravitee-logo/` of this repository | Gravitee trademark / branding, used with permission as part of this project |

The OFL permits bundling and embedding; the fonts are served unmodified (only the latin / latin-ext subsets that Fontsource already ships). The Reserved Font Name clause of the OFL is respected: the files are not renamed fonts, they are the original families.

## Phosphor Icons: MIT License

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## qrcode-generator: MIT License

```
Copyright (c) 2009 Kazuhiko Arase

URL: http://www.d-project.com/

Licensed under the MIT license:
  http://www.opensource.org/licenses/mit-license.php
```

The full MIT text applies as above (permission to use, copy, modify, merge, publish, distribute, sublicense and/or sell, subject to keeping the notice; provided "as is" without warranty).

## SIL Open Font License 1.1

The complete licence texts, including each project's copyright line, are in `fonts/OFL-bricolage-grotesque.txt` and `fonts/OFL-inter.txt`.
