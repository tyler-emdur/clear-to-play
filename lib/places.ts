export type Place = { id: string; name: string; lat: number; lon: number; note?: string };

/** Boulder High is the default. Coordinates are approximate campus centroids. */
export const PLACES: Place[] = [
  { id: "boulder-high", name: "Boulder High School", lat: 40.0150, lon: -105.2797, note: "Recht Field / 1604 Arapahoe Ave" },
  { id: "fairview-high", name: "Fairview High School", lat: 39.9728, lon: -105.2436 },
  { id: "centaurus-high", name: "Centaurus High School (Lafayette)", lat: 39.9949, lon: -105.1063 },
  { id: "monarch-high", name: "Monarch High School (Louisville)", lat: 39.9566, lon: -105.1486 },
  { id: "peak-to-peak", name: "Peak to Peak Charter (Lafayette)", lat: 39.9936, lon: -105.1217 },
  { id: "nederland", name: "Nederland Middle/Senior High", lat: 39.9614, lon: -105.5108, note: "13+ miles from the nearest monitor" },
  { id: "boulder-res", name: "Boulder Reservoir", lat: 40.0730, lon: -105.2180 },
  { id: "chautauqua", name: "Chautauqua Park trailhead", lat: 39.9992, lon: -105.2810 },
];

export const DEFAULT_PLACE_ID = "boulder-high";
