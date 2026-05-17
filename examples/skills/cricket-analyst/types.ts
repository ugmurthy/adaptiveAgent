/**
 * Public type surface for the cricket-analyst skill handler.
 *
 * Input is a discriminated union on `action`. Output is intentionally permissive
 * (`Record<string, unknown>` per branch) because the parent agent forwards the
 * payload to a stylist or simulator without re-parsing it. Each branch is
 * tightened in the US that implements that action.
 */

export interface PointsTableInput {
  action: 'points_table';
  asOf?: string;
}

export interface FixturesInput {
  action: 'fixtures';
  asOf?: string;
  from?: string;
  to?: string;
}

export interface PlayerFormInput {
  action: 'player_form';
  asOf?: string;
  team?: string;
}

export type CricketAnalystInput = PointsTableInput | FixturesInput | PlayerFormInput;

export interface CricketAnalystStubOutput {
  action: CricketAnalystInput['action'];
  status: 'stub';
  message: string;
}

// Output is intentionally an unknown JSON-shaped value: each action branch
// returns its own concrete shape (PointsTable, FixturesResult, PlayerFormResult)
// and we deliberately don't re-export those types here to keep types.ts free of
// implementation imports.
export type CricketAnalystOutput = unknown;
