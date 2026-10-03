// Compares the fitted PDE dispersion w^2 = c2 k^2 + beta k^4 with the exact
// capillary-gravity relation, and reports the stable sub-step of the GPU solver.
import { surfaceTension, waterDensity } from '../src/physics/water.js';
import { CUP, GRID } from '../src/config.js';

const g = 9.81;
function fit(T) {
  const sigma = surfaceTension(T), rho = waterDensity(T), D = CUP.fill;
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  const kMin = 2 * Math.PI / 0.04, kMax = 2 * Math.PI / 0.003;
  for (let i = 0; i <= 200; i++) {
    const k = kMin * Math.pow(kMax / kMin, i / 200);
    const w2 = (g * k + sigma / rho * k ** 3) * Math.tanh(k * D);
    const x1 = k * k / w2, x2 = k ** 4 / w2;
    a11 += x1 * x1; a12 += x1 * x2; a22 += x2 * x2; b1 += x1; b2 += x2;
  }
  const det = a11 * a22 - a12 * a12;
  return { c2: (b1 * a22 - b2 * a12) / det, beta: (a11 * b2 - a12 * b1) / det, sigma, rho };
}
for (const T of [0, 20, 100]) {
  const { c2, beta, sigma, rho } = fit(T);
  console.log(`T=${T}: c2=${c2.toExponential(3)} beta=${beta.toExponential(3)} sigma=${sigma.toFixed(4)}`);
  for (const lam of [0.003, 0.005, 0.01, 0.02, 0.04]) {
    const k = 2 * Math.PI / lam;
    const w = Math.sqrt((g * k + sigma / rho * k ** 3) * Math.tanh(k * CUP.fill));
    const wf = Math.sqrt(c2 * k * k + beta * k ** 4);
    console.log(`  lambda=${(lam * 1000).toFixed(0).padStart(2)}mm  exact f=${(w / 2 / Math.PI).toFixed(1).padStart(6)}Hz  fit f=${(wf / 2 / Math.PI).toFixed(1).padStart(6)}Hz  err=${((wf / w - 1) * 100).toFixed(1)}%  c=${(w / k * 100).toFixed(1)}cm/s`);
  }
  const dx = 2 * CUP.rIn / GRID.waveN;
  const wmax = Math.sqrt(c2 * 8 / dx ** 2 + beta * 64 / dx ** 4);
  console.log(`  dtSub=${(1.55 / wmax * 1000).toFixed(3)}ms -> ${Math.ceil((1 / 60) / (1.55 / wmax))} substeps @60fps`);
}
