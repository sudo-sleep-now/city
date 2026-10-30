# Architecture asset audit

Reviewed 2026-10-29 before updating the Blender-authored building library.

- Local model inventory: `architecture.blend`, `architecture.glb`, and the separate vehicle library. No additional building meshes or source assets were present under `assets/` or `public/`.
- External source considered: [Kenney City Kit Commercial](https://kenney.nl/assets/city-kit-commercial), published as CC0 on the official asset page. Its ready-made commercial blocks are useful as generic city kit pieces, but do not fit the existing city's more restrained authored facade style or improve the covered building types enough to justify replacing them.
- No external model or texture was imported. Existing root names, footprints, Y-up GLB export, and the apartment ground/floor/roof part contract remain in use.

## Work applied

- Added small entrance fixtures to the reusable houses, planted roof and balcony planters, modern-house window sills and timber side screen, a mansard gutter and dormer cheeks, and striped shop awning fabric.
- Used low-poly clustered shrub crowns instead of the first cone-shaped foliage draft after preview review.
- The existing same-material mesh joining and Blender image packing remain in the export path; the foliage is baked mesh geometry with no external runtime dependencies.

## Geometry and draw-batch check

The architecture authoring script already joins primitive pieces by material inside each named root. `createAuthoredBuildings` creates one `InstancedMesh` for each joined root/material pair, so the library's 78 child meshes are 78 material draw batches for the 11 reusable roots—not hundreds of per-window objects. Every root has exactly one child mesh per used material. Combining those groups further would either merge distinct material appearance or remove independent root geometry needed by authored placement.

The architecture library gains detail in this request. The before-request web export was preserved in the previous production build and measured before rebuilding it:

| Measure | Before request | Final |
| --- | ---: | ---: |
| Named roots | 11 | 11 |
| Unique geometry triangles | 44,364 | 49,676 |
| Meshes / material batches | 69 | 78 |
| Materials | 10 | 13 |
| GLB bytes | 1,726,904 | 2,046,004 |

The extra geometry is deliberate facade/roof detail. Each root still has one mesh per used material; re-exporting the optimization review left those counts unchanged. The parallel vehicle optimization reduced its triangle count by 5,392, offsetting the architecture increase of 5,312: together the two libraries have 66,070 unique geometry triangles, versus 66,150 before. Combined GLB size rises about 7%, while the vehicle file alone is 24% smaller. Detailed measurements are in `assets/benchmarks/models-2026-10-29.json`.

## Review outputs

- Editable source: `assets/blender/architecture.blend`
- Web asset: `public/models/architecture.glb`
- Rendered previews: `assets/previews/house_modern.png`, `assets/previews/apartment_roof.png`, and `assets/previews/corner_shop.png`
