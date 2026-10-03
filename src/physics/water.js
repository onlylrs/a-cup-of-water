// Temperature-dependent material properties of water, ice and air.
// All correlations are standard engineering fits; references are given in the README.

export const ICE = {
  density: 917,
  cp: 2050,
  k: 2.22,
  ior: 1.309,
};

export const GLASS = {
  density: 2230,       // borosilicate
  cp: 830,
  k: 1.14,
  ior: 1.5,
};

export const LATENT_FUSION = 334e3;     // J/kg
export const LATENT_VAPOR = 2257e3;     // J/kg
export const CP_WATER = 4186;           // J/(kg K)
export const K_WATER = 0.6;             // W/(m K)
export const T_SAT = 100;               // boiling point at 1 atm (°C)
export const P_ATM = 101325;

// Kell (1975) density of air-free water, valid 0..150 °C.
export function waterDensity(T) {
  const t = Math.max(-10, Math.min(150, T));
  return (999.83952 + 16.945176 * t - 7.9870401e-3 * t * t - 46.170461e-6 * t ** 3 +
    105.56302e-9 * t ** 4 - 280.54253e-12 * t ** 5) / (1 + 16.87985e-3 * t);
}

// Vogel equation for the dynamic viscosity (Pa s).
export function waterViscosity(T) {
  const tk = Math.max(0, T) + 273.15;
  return 2.414e-5 * Math.pow(10, 247.8 / (tk - 140));
}

export function kinematicViscosity(T) {
  return waterViscosity(T) / waterDensity(T);
}

// IAPWS surface tension of water against air (N/m).
export function surfaceTension(T) {
  const tau = 1 - (Math.max(0, T) + 273.15) / 647.096;
  return 0.2358 * Math.pow(tau, 1.256) * (1 - 0.625 * tau);
}

// Refractive index at ~589 nm (fit to tabulated data).
export function waterIor(T) {
  const t = Math.max(0, Math.min(100, T));
  return 1.33395 - 2.7e-6 * t - 1.27e-6 * t * t;
}

// Antoine equation, vapour pressure in Pa.
export function vaporPressure(T) {
  const t = Math.min(T, 140);
  return 133.322 * Math.pow(10, 8.07131 - 1730.63 / (233.426 + t));
}

// Relative air solubility (1.0 = saturated at 20 °C). Henry's law fit combined with the
// fact that the partial pressure of air above the liquid vanishes as p_vap -> p_atm.
export function airSolubility(T) {
  const t = Math.max(0, T);
  const henry = 1.0 / (0.69 + 0.0155 * t);           // ~1.45 at 0 °C, ~1.0 at 20 °C, ~0.44 at 100 °C
  const partial = Math.max(0, 1 - vaporPressure(t) / P_ATM);
  return henry * partial / 0.977;
}

// Capillary length l_c = sqrt(sigma / (rho g)).
export function capillaryLength(T) {
  return Math.sqrt(surfaceTension(T) / (waterDensity(T) * 9.81));
}
