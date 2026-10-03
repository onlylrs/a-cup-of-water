// Objects that can be dropped into the glass. Density decides floating vs. sinking;
// the thermo bead (975 kg/m^3) floats in cold water but sinks once the water expands
// above ~73 °C, a direct visual readout of the temperature-dependent density of water.
export const BALL_TYPES = [
  { id: 'wood', name: 'Maple', density: 650, radius: 0.0088, restitution: 0.42, friction: 0.55, mat: 0, swatch: '#c9a172' },
  { id: 'plastic', name: 'PP plastic', density: 905, radius: 0.0082, restitution: 0.55, friction: 0.35, mat: 1, swatch: '#e2533f' },
  { id: 'thermo', name: 'Thermo bead', density: 975, radius: 0.0080, restitution: 0.5, friction: 0.35, mat: 2, swatch: '#f0a830' },
  { id: 'ceramic', name: 'Ceramic', density: 2300, radius: 0.0075, restitution: 0.5, friction: 0.3, mat: 3, swatch: '#ecebe6' },
  { id: 'steel', name: 'Steel', density: 7850, radius: 0.0065, restitution: 0.6, friction: 0.25, mat: 4, swatch: '#9aa3ab' },
];
