// Offline check of the thermal solver: prints the water state over (real) time
// for a heating run and a freezing run at the default time acceleration.
import { ThermalSim } from '../src/physics/thermal.js';
import { THERMAL } from '../src/config.js';

function run(label, env, seconds, preset) {
  const sim = new ThermalSim();
  if (preset) preset(sim);
  sim.envTemp = env;
  const dt = 1 / 60;
  console.log(`\n== ${label}: environment ${env} °C, time x${sim.timeScale}`);
  const t0 = performance.now();
  for (let f = 0; f <= seconds * 60; f++) {
    sim.step(dt);
    if (f % 300 === 0) {
      const s = sim.stats;
      console.log(`t=${(f / 60).toFixed(0).padStart(3)}s  meanT=${s.meanT.toFixed(1).padStart(6)}  ` +
        `min=${s.minT.toFixed(1).padStart(6)} max=${s.maxT.toFixed(1).padStart(6)}  ice=${(s.iceFraction * 100).toFixed(0).padStart(3)}%  ` +
        `topIce=${(s.topIce * 100).toFixed(0).padStart(3)}%  vap=${s.vaporPower.toFixed(1).padStart(5)}W  ` +
        `boil=${s.boiling.toFixed(2)} wallB=${s.wallBubbles.toFixed(2)} gas=${s.gas.toFixed(2)} sh=${s.bottomSuperheat.toFixed(1)}`);
    }
  }
  console.log(`avg step ${((performance.now() - t0) / (seconds * 60)).toFixed(3)} ms`);
  return sim;
}

const hot = run("heat", 230, 40);
const cold = run("freeze", -25, 50);
// print ice cloudiness profile along the axis and mid-radius
const row = [];
for (let j = THERMAL.baseRows; j <= THERMAL.topRow; j += 3) {
  const line = [];
  for (let i = 0; i < THERMAL.waterCols; i += 3) line.push(cold.cloud[j * cold.nr + i].toFixed(2));
  row.push(`j=${j}: ${line.join(' ')}`);
}
console.log('cloud map (bottom -> top, centre -> wall):\n' + row.join('\n'));
run("freeze boiled water", -25, 50, (s) => { s.gas = s.waterVolume * 0.3; s.gasConc = 0.3; });
