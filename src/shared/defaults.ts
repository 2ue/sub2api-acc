import type { ModifyOptions, PluginSettings } from './types';

export const defaultSettings: PluginSettings = {
  profiles: {
    max5x: {
      label: 'max 5x',
      usage5h: { min: 25, max: 90 },
      usage7d: { min: 100, max: 400 },
      survivalDays: { min: 0, max: 12 },
      today: { min: 0, max: 180 },
      totalExtra: { min: 40, max: 1200 },
      concurrencyTotal: { min: 3, max: 10 },
    },
    max20x: {
      label: 'max 20x',
      usage5h: { min: 150, max: 220 },
      usage7d: { min: 600, max: 1700 },
      survivalDays: { min: 0, max: 12 },
      today: { min: 0, max: 850 },
      totalExtra: { min: 100, max: 5000 },
      concurrencyTotal: { min: 3, max: 10 },
    },
  },
  accountCount: { min: 0, max: 28 },
  statusRatios: {
    active: 50,
    rate_limited: 10,
    temp_unschedulable: 30,
    unschedulable: 0,
    error: 0,
    inactive: 0,
  },
  clearSubsiteOwner: false,
  maskAccountEmail: false,
  customLabel: 'max custom',
  customProfile: 'max20x',
  currency: '$',
  decimals: 2,
  notifyAfterApply: true,
};

export const defaultModifyOptions: ModifyOptions = {
  subscription: true,
  usage5h: true,
  usage7d: true,
  usage7dF: true,
  survivalDays: true,
  concurrency: true,
  today: true,
  total: true,
  accountCount: false,
  maskEmail: false,
  subscriptionMode: 'max5x',
};
