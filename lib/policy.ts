export type IntensityId = "rest" | "light" | "moderate" | "vigorous";

export type Action =
  | "proceed"
  | "proceed_with_precautions"
  | "reduce_intensity"
  | "shorten"
  | "move_indoors"
  | "cancel";

/** Bands are AQI ranges now, because CHSAA's guidance is keyed on AQI. */
export type Band = { id: string; maxAqi: number | null; aqiCategory: string };

export type Rule = {
  id: string;
  band: string | string[];
  intensity: "any" | IntensityId[];
  sensitive: "any" | boolean;
  action: Action;
  precautions: string[];
  rationale: string;
};

export type Policy = {
  policyVersion: string;
  jurisdiction: string;
  pollutant: string;
  disclaimer: string;
  sources: { id: string; title: string; url: string; verified: boolean; note: string }[];
  basis: string;
  evidence: {
    searchRadiusMiles: number;
    maxTrustedDistanceMiles: number;
    maxReadingAgeMinutes: number;
    note: string;
  };
  visibility: {
    note: string;
    /** The band a coach's own visual range check corresponds to. */
    scale: { band: string; label: string }[];
  };
  intensities: { id: IntensityId; label: string; light: boolean }[];
  bands: Band[];
  rules: Rule[];
};

/** Ordered severity, used to compare two decisions. */
export const ACTION_SEVERITY: Record<Action, number> = {
  proceed: 0,
  proceed_with_precautions: 1,
  shorten: 2,
  reduce_intensity: 3,
  move_indoors: 4,
  cancel: 5,
};

// Every label is an imperative a coach can act on without a second reading.
// "Hold practice" is deliberately avoided: it reads as both "conduct" and
// "halt", which is the one ambiguity this band cannot afford.
export const ACTION_LABEL: Record<Action, string> = {
  proceed: "Run practice as planned",
  proceed_with_precautions: "Run practice, with precautions",
  shorten: "Shorten the session",
  reduce_intensity: "Lower the intensity",
  move_indoors: "Move indoors",
  cancel: "Cancel the outdoor session",
};
