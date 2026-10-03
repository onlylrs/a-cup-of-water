// Scene dimensions (SI units: metres, seconds, kelvin offsets in °C) and global tuning.
// Every subsystem reads geometry from here so the CPU solvers, the GPU height field and
// the ray tracer agree on the exact same cup.

export const CUP = {
  rIn: 0.035,          // inner radius of the glass
  rOut: 0.0375,        // outer radius (2.5 mm wall)
  height: 0.110,       // total height of the glass
  base: 0.0125,        // thickness of the solid glass base
  fill: 0.075,         // water column height at rest
};
CUP.level = CUP.base + CUP.fill; // rest height of the free surface in cup-local coordinates
CUP.area = Math.PI * CUP.rIn * CUP.rIn;

export const GRID = {
  waveN: 128,          // height-field resolution across the inner diameter
  readN: 64,           // CPU read-back resolution of the height field
  condW: 512,          // condensation map (theta)
  condH: 192,          // condensation map (height)
  causticN: 1024,      // caustics map resolution
  causticGrid: 360,    // light-ray grid resolution for caustics
};

export const THERMAL = {
  dr: 0.00125,
  dz: 0.0025,
};
THERMAL.nr = Math.round(CUP.rOut / THERMAL.dr);          // 30 columns (28 water + 2 glass)
THERMAL.nz = Math.round(CUP.height / THERMAL.dz);        // 44 rows
THERMAL.waterCols = Math.round(CUP.rIn / THERMAL.dr);    // 28
THERMAL.baseRows = Math.round(CUP.base / THERMAL.dz);    // 5
THERMAL.waterRows = Math.round(CUP.fill / THERMAL.dz);   // 30
THERMAL.topRow = THERMAL.baseRows + THERMAL.waterRows - 1;

export const LIMITS = {
  maxBubbles: 160,
  maxBalls: 8,
  maxSplash: 256,
  maxDrips: 32,
  maxPuffs: 16,
};

export const ROOM = {
  temperature: 22,     // room air (°C) that supplies moisture for condensation
  dewPoint: 12.5,      // ~55 % relative humidity at 22 °C
};

// Light and look
export const LIGHT = {
  // direction *towards* the light (normalised in main.js)
  dir: [-0.55, 1.0, -0.62],
  color: [1.0, 0.96, 0.9],
  intensity: 2.5,
};

export const GRAVITY = 9.81;
