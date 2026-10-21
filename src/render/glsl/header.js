import { CUP, THERMAL, LIMITS, GRID } from '../../config.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// GLSL constants generated from config.js so shaders and solvers share one geometry.
export const GLSL_HEADER = /* glsl */`
#define R_IN ${f(CUP.rIn)}
#define R_OUT ${f(CUP.rOut)}
#define CUP_H ${f(CUP.height)}
#define BASE_H ${f(CUP.base)}
#define LEVEL0 ${f(CUP.level)}
#define TH_NR ${f(THERMAL.nr)}
#define TH_NZ ${f(THERMAL.nz)}
#define TH_TOPY ${f((THERMAL.topRow + 0.5) * THERMAL.dz)}
#define MAX_BUBBLES ${LIMITS.maxBubbles}
#define MAX_BALLS ${LIMITS.maxBalls}
#define STEAM_MAX_PUFFS ${LIMITS.maxPuffs}
#define WAVE_N ${f(GRID.waveN)}
#ifndef PI
#define PI 3.141592653589793
#endif
#ifndef TAU
#define TAU 6.283185307179586
#endif
`;
