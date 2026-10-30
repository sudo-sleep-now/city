# Solheim 2050: City D

An interactive 3D **pilot district proposal** for the Future Cities Summit 2050 English presentation. Adapted from [sudo-sleep-now/city](https://github.com/sudo-sleep-now/city).

The assigned city has spread-out neighbourhoods, long commutes and unreliable public transport outside the centre. The proposal answers: **How can we reduce car dependency without making everyday life harder for people who rely on cars?**

## The proposal

1. **Reliable buses first.** Start with existing main roads, priority at bottlenecks and connections from outer neighbourhoods. Sheltered transfer points and affordable fares support access. Fund early and late services for shift workers.
2. **Safer short journeys.** Connect cycle routes, safer crossings and calmer school streets. Keep accessible transport and essential drop-off options.
3. **Daily needs closer to home.** Gradually add local services and housing around stops, with affordable housing and tenant safeguards. Check school and utility capacity before increasing density.

Road space and public funding are limited. Pilot changes, consult residents and shops, retain emergency and disabled access, and agree delivery arrangements. Judge expansion by bus delays, household travel costs and access to jobs. **Useful alternatives and fair access come before restrictions.**

## What the model represents

The 1.2 × 1.2 km scene illustrates a possible redeveloped district within a larger sprawling city. The outer suburbs are **outside** the scene. It is not a simulation of converting an entire city overnight, nor a before/after prediction.

The existing tram network represents a **possible later phase**, conditional on demand and funding. The initial city-wide strategy prioritises buses. The new outer transfer hubs illustrate connections to neighbourhoods beyond the model. Accessible drop-off and shared-car bays are further options for detailed design where kerb space allows, rather than additional large car parks.

Statistics use geometry and assumed building capacity. Distances are straight-line proxies, weighted by residential units. They do not measure real walking routes, disability access or journey times. Travel behaviour, affordability and emissions outcomes are not predicted. The original heuristic modal shares remain internal to the engine and are deliberately omitted from the public statistics.

## Run locally

Requires Bun or Node.js 20+ with npm. No database or account is needed for the city scene.

```bash
bun install --frozen-lockfile
bun run dev
```

Open [localhost:3000](http://localhost:3000). Choose **Start the site visit** for a manual six-location visit or **Explore freely** to walk.

Classroom mode defaults on: steady daylight, muted sound and no random weather or emergency incidents. Turn it off on the opening screen for the original day/night and weather simulation. Sound can also be toggled with M.

## Controls

| Control | Action |
| --- | --- |
| WASD / arrows | Walk (click the world to capture the mouse on desktop) |
| Mouse | Look while captured |
| Shift / Space / Ctrl | Sprint / jump / crouch |
| E | Inspect a point of interest / enter or exit a building |
| T | Start the site visit / advance to next location |
| Shift + T | Previous visit location |
| Q | End the site visit |
| Tab | Model estimates |
| M | Toggle sound |
| Esc | Release mouse / pause |

The site visit stays at each location until advanced. It works with its on-screen Previous/Next buttons without mouse capture. If the mouse is captured, press Esc for the pause menu and use its navigation buttons. Touch controls support walking, looking and interactions.

## Separate presentation

The slide deck is an independent artifact in the chat, with rehearsal notes in the sibling `../presentation/` folder. The app contains **no slide deck, slide renderer or presentation route**. Use the slides for the seven-minute talk and the 3D district as an optional demonstration or during questions.

The six model visit locations cover the district's scope, outer connections, phased transit, safer school journeys, local services and the road-space trade-off. They explain the scene while exploring it.

The slide research uses the [Transport for London bus priority programme](https://tfl.gov.uk/modes/buses/bus-priority-programme) as a real-world example. Policy details and source links are in the separate presentation notes.

## Checks and builds

```bash
bun run typecheck
bun run lint
bun run build
bun run start
```

Build and typecheck generate the unused starter Prisma client's TypeScript definitions; they do not connect to or modify a database. The production build enforces TypeScript checks.

For GitHub Pages, `bun run build:static` exports to `out/`. Set `NEXT_PUBLIC_BASE_PATH=/city` when deploying beneath the repository path. Building does not publish anything.

## Project structure

- `src/components/city/`: intro, HUD, estimates, minimap and POI panels.
- `src/lib/city/planner.ts`: generated district, transit and planning explanations.
- `src/lib/city/mobility.ts`: transfer-hub demonstration geometry.
- `src/lib/city/tour.ts`: manual six-location site visit.
- `src/lib/city/engine.ts`: rendering, simulation and classroom mode.
- Remaining city modules: procedural buildings, streets, traffic, people and environment.

Next.js 16, TypeScript, Three.js and Zustand. The Blender models and textures are bundled locally. No asset service is required at runtime.

Released under the [MIT License](LICENSE).


## Blender models

`assets/blender/architecture.blend` contains the gabled house, hipped house, townhouse and modular apartment parts. `assets/blender/vehicles.blend` contains the sedan, estate, van and wheel assembly. They are original editable Blender scenes, exported to `public/models/*.glb`. Window frames, sills, balconies, sloped automotive glass and wheel arches are actual geometry. Repeated architecture and vehicles use GPU instancing.

To regenerate the exported models after changing the authoring scripts:

```bash
bun run models:build
```

This requires Blender. Editing a `.blend` file directly does not automatically alter the Python authoring script: export the changed asset to the matching GLB, or also update the script before regenerating. Named asset roots and local origins are the app's model contract. `scripts/blender/render_preview.py` renders an individual asset for visual review. The app keeps procedural fallbacks if a GLB cannot load.

`assets/blender/street-props.blend` adds seven original street models, built by `scripts/blender/street-props.py`: a cast-iron hydrant, a diamond-frame parked bicycle, a bent-steel cycle rack, a glazed stop shelter, a ticket machine, a slatted bench and a litter bin. The bicycle includes separate tyres, rims, spokes, hubs, stays, pedals, fenders and a rear carrier. Shelter glass is transparent, and the structure includes corner posts, roof gutters and a timetable panel. Repeated props use GPU instances grouped by material. The bundle is 783,500 bytes with 16,388 unique triangles and 24 material batches; it adds no texture downloads.

These models replace the corresponding street furniture throughout the live district. Bus shelters have readable route/stop names and visible seats; bikes follow the racks' long axes; curbside items rest on the pavement. Tram waiting shelters now stand beyond the cycle strip rather than occupying the old island position inside a car lane. These are curbside waiting areas, not a simulation of accessible tram boarding across the lanes. The interchange has ticket machines and hall/forecourt seating, with both entrance portals kept clear. Moving cyclists retain their existing rider/bicycle assembly.

`bun run models:check` checks the prop names, axes, grounding, size and download/triangle budget. Tests load the actual GLB, check transparent glazing and instanced transforms, and verify that placed hydrants, bikes, racks and shelters do not overlap road corridors. `blender -b --python scripts/blender/render_street_details.py` renders the collection to `assets/previews/street-details.png`; it does not modify the source scene.

## Graphics on slower devices

The intro and in-world **Graphics** menu offer Auto, Performance, Balanced and High. Auto starts conservatively on touch devices, devices reporting four or fewer CPU threads, or four GB or less memory; it reduces detail after sustained slow frames. Manual choices are remembered locally. Performance caps the framebuffer at 900,000 pixels, removes sun shadow rendering, limits the static draw distance to 420 m with matching fog, and keeps two nearby street lights and visible vehicle lenses. Balanced uses a 1024 px shadow map refreshed at 15 Hz; High uses 2048 px at 30 Hz. Traffic lab overview and rooftop views retain the skyline in every mode. Hidden tabs stop rendering and do not accumulate simulation catch-up work.

Expensive static batches are partitioned into 240 m cells, so buildings and props outside the camera view can be culled. Small batches stay combined to limit draw-call overhead. District/rooftop overviews use the original broad batches, avoiding extra cell draw calls when the whole city is visible. Every traffic simulation step still runs at 60 Hz; multiple steps in one displayed frame write car matrices only on the final step. Bus/tram wheel meshes contain a single tire/hub pair per instance.

`bun run render:benchmark --save` compares static camera-pass geometry submission before and after partitioning at all seven tour stops, using the actual Blender assets. Results are saved in `assets/benchmarks/render-performance.json`. This measures triangles and draw calls, not FPS on physical low-end hardware. `tests/render-performance.test.ts` verifies preserved geometry, transforms, material groups, colours, dynamic meshes, quality adaptation and framebuffer budgets.

## Solheim Square

The centre is arranged as a garden square rather than scattered furniture on an empty slab: a tiered stone fountain, an eleven-metre clock landmark, west-facing timber market kiosks, a planted pergola with usable benches, layered flower beds and a café terrace. Café Verde's entrance now faces the square. The market hall across the tram avenue has a sheltered green frontage. Four-metre walking approaches remain clear around the fountain and connect to the existing crossings; the bus forecourt and road network retain their existing routes.

The fountain, clock and kiosk are original Blender CLI models in `assets/blender/civic.blend`, regenerated with `scripts/blender/civic.py` and exported to `public/models/civic.glb`. The export preserves authored normals and uses ordinary glTF without a compression decoder. Repeated kiosk/material parts use GPU instances; fountain jets animate in a single batch. Stone paving uses metre-scale UVs, and the square's lamps participate in the existing pooled night lighting. The separate presentation deck is independent of this scene.

`tests/city-center.test.ts` checks bounds, walking corridors and café access. `tests/authored-models.test.ts` loads the actual civic GLB and verifies all three landmark models are present in the live square. `bun run models:check` validates the civic origin, size and geometry/download budget.

## Surface stability and vehicle lighting

Junction asphalt, pavement corners and tram crossings have one surface owner, and block paving is cut away from road and sidewalk corridors. Intentional road-paint overlays have their own small material depth bias. The waste truck's textured packer body is rendered once. The sun shadow projection snaps to its texel grid to reduce crawling edges when walking. Tree shape variation moves shared vertices together, preserving closed canopies instead of opening black cracks between triangular faces.

Car and bus lenses always use the vehicle's unscaled body transform. Day/night brightness and red brake-light brightness change independently; brake lights remain lit while stopped and briefly hold through small speed corrections. A pool of four spotlights follows the real headlamp positions of two nearby road vehicles at night. The full fleet retains its visible lenses, without a separate dynamic light per vehicle.

Click the bottom-left clock to compare steady daylight and night lighting, including while traffic is paused. Tests cover light/body alignment with procedural and actual Blender vehicles, brake holding, paused lighting, bounded road illumination and stable shadow projection.

## A working central interchange

The hall is now **Solheim Interchange**, a bus station. B1 enters from the eastern street, stops at Bay A, opens its doors toward the boarding pavement, turns within the forecourt and leaves through the signed exit. The hall's two entrances open into the actual visible building. The terminal drives are bus-only and do not spawn private cars.

T1 has a real stop on its tracks beside the hall, with a signed walking connection. T2 continues along the east-west avenue farther south. Neither tram line is described as a train entering the bus hall. The third site-visit location shows the interchange.

`bun test` verifies B1 boarding and departure, the bus turning envelope, open hall portals and the exclusion of private cars from the terminal.

## Traffic lab and congestion experiments

Choose **Traffic lab** on the opening screen, or press **P** while outdoors. The city keeps running while the panel is open. Choose a street view, an overhead view of the central junction or a view of the whole district.

- **Normal:** 48 private/service vehicles spread through the district, adaptive signal timing.
- **Rush hour:** 144 vehicles with more demand near the centre, adaptive signals.
- **High congestion:** 240 vehicles concentrated on central roads, adaptive signals.

You can adjust demand from 24 to 240 vehicles, switch between fixed and adaptive signal timing, pause the experiment and run at 1×, 2× or 4× speed. Changes restart the car population, signals and measurements with the same seed. Buses and trams continue their services. Cameras do not relocate cars or erase queues.

Wait at least 60 simulated seconds, then **Save reading** before changing a setting. Saved readings remain in the panel until reload. For a fair signal comparison, keep the scenario, vehicle count and simulated run age the same. Scenario presets deliberately change both demand and its distribution.

The panel shows the run-average speed, current queued vehicles (below 0.5 m/s), current average waiting duration for those vehicles, accumulated stopped seconds per car, and completed junction crossings per minute over the last 60 seconds. Internal lane splits are excluded from throughput. Compare accumulated stopped time at the same simulated run age; a brief clear moment cannot erase earlier waiting. Before the first minute ends, flow is a rate estimate. A junction crossing is not a completed door-to-door trip. These readings describe the demonstration and are not calibrated traffic forecasts.

Cars follow leaders by distance along the actual lane and turn, with vehicle-length gaps. Junction reservations start at the stop line; followers can share the same movement with a safe gap. Crossing movements wait until the preceding vehicle’s rear clears the shared area, with extra sweep clearance for turning trucks. Admission reserves downstream storage for every committed vehicle. If a chosen exit is full, a car near the line can choose another legal turn, keeping the same destination-biased demand. No car is removed or relocated to clear queues.

Adaptive signals use approaching traffic, queue age and downstream space. Through phases have a 4.5-second minimum green and maximum of 15 seconds at ordinary junctions or 11 seconds at the redesigned crossroads. Protected left arrows run for 3.5–7 seconds, with empty arrow phases skipped. Left turns can also use gaps during the circular green, subject to conflicting-movement and tram checks. Each phase change retains 1.6 seconds of all-red clearance. Both axes still receive service without cars; pedestrian logic never interprets a protected left arrow as a crossing permission. Fixed timing uses 9-second through and 6-second arrow phases where present. All presets start with adaptive control. Demand can still exceed capacity. Terminal drives remain bus-only.

### Rebuilt crossroads

The five central crossroads at (0,0), (±200,0) and (0,±200) have actual movement-specific lane geometry:

- Arterial approaches split across a 12m taper into a left-only pocket and a separate straight/right lane. Storage is up to 28m. Drivers select a legal pocket before the taper and cannot cut across its markings at the stop line.
- The central tram avenues are 22m wide, giving 3m car lanes outside the unchanged tram tracks. The 1.6m cycle lanes and 5m pavements move outward without losing width. The hospital tower moves 1m back to retain the complete walking strip.
- Straight/right stop bars sit 3m behind the left stop bars, leaving space for truck tail swing. Stop bars and arrows are rendered from the same lane coordinates that cars use.
- Zebra bars now extend in the correct direction across the full actual road width; collector crossings use 11m and tram-avenue crossings 22m. Previously they were rotated 90 degrees and often used the wrong width. Keep-clear hatching and continuous green cycle crossings make the mouths legible.
- Left-turn guide curves avoid forcing opposing left turns through the same central point. Green arrow heads protect turn queues. Cars reserve track crossings around the full length of approaching trams; trams hold if a car is already committed to their crossing.

The junction camera is closer and shifted so the central crossing remains visible alongside the lab panel.

### Earlier layout comparison

Run `bun run traffic:benchmark` for six ten-minute cases. Run `BENCH_LAYOUT=shared bun run traffic:benchmark` for the shared-lane control, which retains the current tram checks, crossing corrections and central road width. `BENCH_DT=0.016666666666666666` uses the live 60Hz step. Raw data and the earlier release are saved in `assets/benchmarks/crossroads.json`; the earlier control-only experiment remains archived in `assets/benchmarks/junctions.json`.

Before the persistent-trip routing update, the deterministic adaptive-control comparison at 600 seconds was:

| Demand | Cars | Shared → rebuilt stopped seconds/car | Shared → rebuilt junction exits |
| --- | ---: | ---: | ---: |
| Normal |48|5.1 →8.3|2,279 →2,253|
| Rush hour |144|151.5 →139.2|4,278 →4,532|
| High congestion |240|272.4 →264.4|4,324 →4,785|

This is 6% more junction crossings in rush hour and 11% more at high congestion. Light traffic has a small waiting penalty; the pockets and turn phases serve heavy turning demand rather than improving every run. Vehicle counts are unchanged, with zero recovery respawns. Available lane lengths and starting positions differ because the layout changes, so these are controlled scenario comparisons, not identical vehicle trajectories. The new tram safety constraints make this different from the earlier release's control-only benchmark.

The isolated 12-second bypass test holds a left turn behind a reserved opposing movement: the shared lane completes 0 junction exits, while the separate through lane completes 1. This verifies a physical head-of-line bypass rather than counting added graph segments as traffic flow. Tests also cover lane envelopes, movement restrictions, staggered bars, correctly oriented zebras, truck separation at 60Hz, protected arrow compliance, bounded signal service and tram clearance/resumption.

## Sustained 15 km/h target

The current traffic model fixes the old feedback loop that independently steered cars inward at every junction, even after they had reached the centre. Cars now have persistent inbound destinations and homeward legs. High congestion assigns 92% of new inbound trip intents to the actual central junction; rush hour assigns 55% to real junctions in the central district. Every car remains on the road. Arrival is recorded only after physically completing a non-internal junction crossing; road-fragment seams cannot serve as destinations or complete trips. Assignment counters include a next leg preplanned at the home approach, while completed trips/returns count physical arrival only.

Routes use shortest travel time with live stopped/slow queues, downstream storage and committed traffic costs, refreshed once per simulated second. Small cost changes do not cause repeated route switching. A shared-lane head held by a conflicting turn for 5 seconds may choose another legal exit; committed turn pockets still obey their marked movements. Signals forecast cars arriving through a taper and retain busy greens rather than treating permissive same-axis left demand as opposing traffic. The same-path admission gate now measures the real following distance, including the follower's distance before the connector.

No speed limits, acceleration, braking or turn-speed settings were increased: the main car cap remains 11m/s, turn target 4.6m/s, acceleration 3.5m/s² and braking 9m/s². Red signals, rear clearance, tram priority and blocked-exit checks remain enforced. No vehicles are filtered out of the averages, parked to hide demand, removed, teleported or respawned to maintain speed.

The lab displays current fleet mean, run mean and trailing 60-second mean, plus the lowest fleet and 60-second means observed since restart. Its 15km/h indicator uses unrounded recorded values and reports any breach; an initial unloaded reading is shown as measuring rather than a zero speed observation.

### Reproducible stability checks

`bun run traffic:stability` runs 30 minutes at the live 60Hz step for each preset with adaptive signals. It exits nonzero if the instantaneous fleet, run or trailing 60-second average falls below 15km/h. Run-average minima start after the first simulated second; rolling minima start once a complete minute is available. Instantaneous minima include every positive simulation step.

```sh
# Both controllers at preset vehicle counts, live 60Hz
BENCH_POLICIES=fixed,adaptive bun run traffic:stability
# 90-minute tests at the maximum supported population
BENCH_SCENARIOS=gridlock BENCH_POLICIES=fixed,adaptive BENCH_SECONDS=5400 bun run traffic:stability
# Custom-density sweep using a coarser physics step
BENCH_COUNTS=24,96,180,240 BENCH_POLICIES=fixed,adaptive BENCH_DT=0.1 bun run traffic:stability
```

Saved results are in `assets/benchmarks/speed-stability-2026-10-29.json` and the companion CSV. The 44 validation runs total 24 simulated hours: six 30-minute preset cases at 60Hz, six coarse-step preset cases, 24 coarse density cases, six 24-car cases at 60Hz and two 90-minute 240-car cases at 60Hz. Every case uses deterministic seed 90210 and includes all private/service vehicles, including those waiting. Headless checks omit car matrix writes; transit and all motion rules still run. Every case retained its full fleet, with zero recovery respawns and zero red-light overrides.

Worst values across both controllers in the 30-minute live-step preset runs:

| Demand | Cars | Lowest fleet mean | Lowest 60s mean | Lowest run mean |
| --- | ---: | ---: | ---: | ---: |
| Normal |48|20.26km/h|25.70km/h|25.65km/h|
| Rush hour |144|19.64km/h|22.68km/h|23.35km/h|
| High congestion |240|15.76km/h|18.09km/h|19.52km/h|

In the 90-minute 240-car tests, fixed control's lowest fleet mean was 15.76km/h and its lowest rolling mean 17.97km/h; adaptive control's minima were 16.27km/h and 18.09km/h. The lowest fleet mean across the entire checked matrix was 15.23km/h. These are finite deterministic validation results, not a mathematical guarantee for unlimited time, arbitrary new demand or every future configuration. The input demand model is now complete inbound/return journeys, so it is not the same never-ending central circling process as the archived earlier benchmark.

Tests cover destination integrity, physical trip completion, congestion detours, stopped vehicles included in every average, a 20-minute 240-car minimum-speed regression, red-light compliance, separation, fork accounting and the existing station service.

## Blender model refinement and optimization

The sedan, estate and van now have smoother body profiles, subtle panel seams and refined lamp/trim details. Their GLB meshes are consolidated, and static preview wheels stay editable in the `.blend` but are omitted from the runtime export because the city already instances animated wheels. The importer handles multi-material GLB groups, and an integration test starts and resets a full fleet using the actual exported model hierarchy.

Building refinements include window sills and a timber screen on modern homes, entrance fixtures, mansard details, balcony/roof planters with clustered foliage, and striped shop awnings. All 11 architecture roots, door/footprint contracts and apartment floor parts are preserved. Original same-material batches remain instanced. The architecture library intentionally spends some geometry on these details; vehicle savings offset its triangle increase.

| Library | Before → after bytes | Before → after unique triangles | Before → after meshes |
| --- | ---: | ---: | ---: |
| Vehicles |628,848 →477,196|21,786 →16,394|115 →20|
| Architecture |1,726,904 →2,046,004|44,364 →49,676|69 →78|
| Combined |2,355,752 →2,523,200|66,150 →66,070|184 →98|

The vehicle file is 24% smaller; combined triangle count is essentially unchanged while combined download size rises about 7% for the new building detail. Regenerated editable sources are `assets/blender/architecture.blend` and `assets/blender/vehicles.blend`. Both were built with Blender CLI and render-reviewed; `bun run models:check` validates exported names/bounds. Measurements are saved in `assets/benchmarks/models-2026-10-29.json`; the architecture audit records the external CC0 source considered. No external models or textures were imported.

## More architectural variety

The Blender source also includes an asymmetric modern home, a brick bay-window terrace, a glazed corner shop, a stepped office block and a taller office with a setback crown. Selection is deterministic, and the small shop models keep the existing café/grocery names and interior interactions. Models reuse material batches and GPU instances. Original civic landmarks and the working interchange retain their specialised geometry.


The road graph now gives westbound and northbound lanes their correct directed endpoints, and road fragments have unique lane IDs. This prevents wrong-way movement and distant connector links near the pedestrian street. Regression tests cover those directions, short junction connections, red-light entries and ten-minute normal-flow stability.
