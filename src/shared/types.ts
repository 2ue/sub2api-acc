export type SubscriptionProfile = 'max5x' | 'max20x';
export type SubscriptionMode = SubscriptionProfile | 'custom';
export type AccountStatusKey =
  | 'active'
  | 'rate_limited'
  | 'temp_unschedulable'
  | 'unschedulable'
  | 'error'
  | 'inactive';

export interface NumberRange {
  min: number;
  max: number;
}

export interface ProfileSettings {
  label: string;
  usage5h: NumberRange;
  usage7d: NumberRange;
  survivalDays: NumberRange;
  today: NumberRange;
  totalExtra: NumberRange;
  concurrencyTotal: NumberRange;
}

export type StatusRatios = Record<AccountStatusKey, number>;

export interface PluginSettings {
  profiles: Record<'max5x' | 'max20x', ProfileSettings>;
  accountCount: NumberRange;
  statusRatios: StatusRatios;
  clearSubsiteOwner: boolean;
  maskAccountEmail: boolean;
  customLabel: string;
  customProfile: SubscriptionProfile;
  currency: string;
  decimals: number;
  notifyAfterApply: boolean;
}

export interface ModifyOptions {
  subscription: boolean;
  usage5h: boolean;
  usage7d: boolean;
  usage7dF: boolean;
  survivalDays: boolean;
  concurrency: boolean;
  today: boolean;
  total: boolean;
  accountCount: boolean;
  maskEmail: boolean;
  subscriptionMode: SubscriptionMode;
  customLabel?: string;
  customProfile?: SubscriptionProfile;
}

export interface ApplyMessage {
  type: 'APPLY_MODIFICATIONS';
  options: ModifyOptions;
}

export interface ApplyResult {
  matched: number;
  modified: number;
  skipped: number;
  details: string[];
}
