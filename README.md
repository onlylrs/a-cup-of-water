# A Cup of Water: liquid and boiling demonstration

A scoped presentation build derived from the full repository at
https://github.com/onlylrs/a-cup-of-water, base commit
`89fc66402d3961a69f41cbae03e77ff30771eefa`.

The scope is liquid interaction plus heating and boiling. The upstream full
repository already includes freezing. This demonstration leaves freezing,
condensation, frost, wiping and ballistic splash droplets outside its exposed
runtime scope. It is not a historical checkout or a measured completion percentage.

## Run

Use Node.js 20.19+ or 22.12+ with npm. In this directory:

```sh
npm ci
npm run dev
```

Open http://localhost:5411. First installation needs internet; the app itself
uses local procedural assets. If this port is occupied, read the alternate URL
printed by Vite. Do not open index.html directly with a file URL.

```sh
npm run build
npm run preview
```

## Included

- Shared cup geometry, 128×128 GPU ripple height field and modal sloshing.
- Pointer stirring, moving the glass, spherical objects, buoyancy, drag, contacts.
- Maple, polypropylene, ceramic and steel. Repeatable Float / sink comparison.
- A 30×44 radial/vertical thermal field for glass and water.
- Room (22 °C), Warm (85 °C) and Boil (230 °C) **stage** presets.
- Water temperature evolves through heat transfer. Stage temperature is not
  the water temperature. Only thermal time accelerates (×120 / ×300 / ×600).
- Dissolved-air release, vapour nucleation at hot wall sites, bubble dynamics,
  bubble-to-wave and bubble-to-object feedback, and ray-marched steam.
- Fresnel reflection/refraction, height-derived normals, caustics and body
  occlusion along refracted light paths.
- Height-field and thermal-field insets, pause, reset and quality control.

## Shadow correction

Internal bodies have ray-traced appearances. Their raster proxies previously
still cast straight, opaque Three.js shadow-map shadows, despite being hidden
from the background colour/depth passes. This produced the displaced round
spots on the table. Internal proxies now set `castShadow=false`; external bodies
still cast ordinary shadows. Internal bodies instead occlude each refracted
light segment in the caustics pass. The glass's own shadow and light focusing
are preserved. This is a direct-light approximation, not full global illumination.

## Steam visibility

Steam below the rim is integrated along the cup tracer's air segments. It uses
refracted view directions, glass transmission, and the next water/body/wall hit
as the segment boundary. Steam above the rim uses the same density model in a
separate pass, clipped to scene depth and traced sphere silhouettes. Interior
vapour is not added again over the finished glass image. This is a reduced
single-scattering approximation, not multiple-scattering volume transport.

## Controls

- 1–4: maple, plastic, ceramic, steel.
- R: ripple. S: repeatable shake. B: select the boiling stage.
- D: toggle height field. Thermal field is available in the inset menu.
- C: clear objects. P / Space: pause. 0: reset. H: hide controls.
- Float / sink: reset to room-stage water and drop maple + steel at fixed
  positions and heights. It preserves the comparison switches.
- Boil: starts heating the current water. It does not teleport water to 100 °C.
- Bubbles → waves & bodies: turns feedback off/on while bubble simulation and
  rendering continue. Existing waves need time to decay after switching off.
- Reset scene: clears objects, bubbles, steam puffs and waves, and restores the
  room stage, camera and ×120 heat scale.

Pointer: drag open water to stir, the lower glass wall to move the cup,
objects to lift, and the empty background to orbit.

## Excluded scope

The heating controller clamps stage temperatures to 22–250 °C and initial water
to 22–99 °C. Cold/freezer presets are not exposed. Shared upstream thermal/shader
interfaces retain inactive ice-compatible fields, but the demo has no freezing
scenario, ice locking, frost, condensation or wiping. No splash-particle module
is imported. Freezing integration and transition validation are the proposed
next stage of this scoped build.

## Validation and limits

Run `npm run test:heating` for CPU thermal invariants, and
`node tools/dispersion_test.mjs` for existing wave-fit diagnostics.

The package's revision notes contain visual shadow comparisons and functional
checks of heating, vapour generation, object float/sink, input and reset. The
height field cannot overturn or spill. CPU submit time is not GPU time. A
single local recording does not establish performance across devices.
