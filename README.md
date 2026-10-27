# SOLHEIM — A Walkable 3D Optimal City

A fully procedural, walkable, first-person 3D city built with **Next.js 16, TypeScript and Three.js**. There are no external 3D assets — every building, street, tree, vehicle and pedestrian is generated in code at load time.

SOLHEIM is a school project about **optimal urban design**: a compact, transit-first city of ≈13,000 residents, designed around short distances, mixed neighborhoods, green space on every doorstep and streets that put people before cars.

## Features

- **Procedural city planning** — districts (downtown core, mixed-use, residential, industrial), a density gradient, parks on every doorstep and a car-free shopping street
- **Walkable first-person controller** — sprint, crouch, jump, with AABB collision against 3,000+ colliders
- **Living streets** — traffic AI with cars, buses, trams, traffic lights and intersection logic; pedestrians with daily roles and routines; cyclists and birds
- **Random city events** — fires and medical emergencies spawn randomly: a fire engine or ambulance routes through the street grid with beacons, smoke/flame effects and onlooker crowds, then resolves on its own
- **Car-free shopping street** — themed market stalls, cafe terraces, sandwich boards and street advertising brought to life as real 3D props
- **Day/night cycle** — sun, moon, sky and fog, plus weather and procedural ambient audio
- **Explainable design** — glowing points of interest, a guided city tour (T) and a live statistics dashboard (Tab) that show *why* the city is planned this way
- **Interiors** — enterable buildings, including a fire station
- **Touch controls** — virtual joystick and action buttons on mobile devices

## Controls

| Key | Action |
| --- | --- |
| `W A S D` / Arrows | Move |
| Mouse | Look |
| `Shift` | Sprint |
| `Space` | Jump |
| `Ctrl` / `C` | Crouch |
| `E` | Interact / enter buildings |
| `Tab` | Toggle city statistics |
| `T` | Toggle guided tour |
| `Esc` | Release the mouse |

On touch devices a virtual joystick plus jump / sprint / interact buttons appear automatically.

## Tech stack

- [Next.js](https://nextjs.org/) 16 (App Router) + TypeScript 5
- [Three.js](https://threejs.org/) 0.185 (all meshes, textures and instancing are procedural — Canvas-generated textures, `BufferGeometry` merging, instanced meshes)
- [Tailwind CSS](https://tailwindcss.com/) 4 + [shadcn/ui](https://ui.shadcn.com/) components
- [Zustand](https://zustand.docs.pmnd.rs/) for UI state

## Getting started

Requires [Bun](https://bun.sh/) (or Node.js 20+ with npm):

```bash
bun install
bun run dev
```

Open <http://localhost:3000>, click **Enter Solheim** and walk around.

### Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start the dev server on port 3000 |
| `bun run lint` | Run ESLint |
| `bun run build` | Production build (standalone Node server) |
| `bun run start` | Run the standalone production server |
| `bun run build:static` | Static export for GitHub Pages (`NEXT_EXPORT=1`) |

## Project structure

```
src/
├── app/                  # Next.js App Router (single-page experience)
├── components/city/      # React UI: intro overlay, HUD, minimap, info & stats panels
└── lib/city/             # The city engine (all procedural, no external assets)
    ├── planner.ts        #   generates the CityPlan: districts, blocks, parks, POIs
    ├── roads.ts          #   road/sidewalk graph and meshes
    ├── buildings.ts      #   merged building meshes, doors, specials
    ├── environment.ts    #   trees, furniture, props (instanced)
    ├── traffic.ts        #   vehicle AI: cars, buses, trams, traffic lights
    ├── pedestrians.ts    #   pedestrian roles, routines and crowds
    ├── cyclists.ts       #   bicycle traffic
    ├── emergency.ts      #   random fire / medical events + responding vehicles
    ├── interiors.ts      #   enterable building interiors
    ├── lighting.ts       #   day/night cycle, sky, fog
    ├── weather.ts        #   weather effects
    ├── audio.ts          #   procedural ambient audio
    ├── player.ts         #   FPS controller + AABB collision
    └── engine.ts         #   orchestrator, render loop, state bridge
```

## License

Released under the [MIT License](LICENSE).
Uhh
