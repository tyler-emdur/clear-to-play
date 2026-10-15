export type IntensityId = "rest" | "light" | "moderate" | "vigorous";

export type Action =
  | "proceed"
  | "proceed_with_precautions"
  | "reduce_intensity"
  | "shorten"
  | "move_indoors"
  | "cancel";

export type Band = { id: string; maxPm25: number | null; aqiCategory: string };

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
  evidence: {
    searchRadiusMiles: number;
    maxTrustedDistanceMiles: number;
    maxReadingAgeMinutes: number;
    maxMonitorSpreadUgM3: number;
    note: string;
  };
  intensities: { id: IntensityId; label: string; ventilationMultiplier: number }[];
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

export const ACTION_LABEL: Record<Action, string> = {
  proceed: "Hold practice as planned",
  proceed_with_precautions: "Hold practice, with precautions",
  shorten: "Shorten the session",
  reduce_intensity: "Lower the intensity",
  move_indoors: "Move indoors",
  cancel: "Cancel the outdoor session",
};
