export type AuthFile = {
  type?: string;
  email?: string;
  access_token?: string;
  account_id?: string;
  disabled?: boolean;
};

export type ProbeWindow = {
  quota_type: string;
  used_pct?: number;
  resets_at?: string;
  model?: string;
  raw: unknown;
};

export type ProbeResult = {
  provider: string;
  account: string;
  status: string;
  unavailable: boolean;
  disabled: boolean;
  plan?: string;
  error?: string;
  windows: ProbeWindow[];
};

export type ProbeFn = (auth: AuthFile) => Promise<ProbeResult>;
