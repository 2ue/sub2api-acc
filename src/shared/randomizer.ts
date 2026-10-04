import type { PluginSettings, ProfileSettings, SubscriptionMode } from './types';

export interface GeneratedValues {
  usage5h: number;
  usage7d: number;
  usage7dF: number;
  usage5hAmount: number;
  usage7dAmount: number;
  survivalDays: number;
  today: number;
  total: number;
  concurrencyCurrent: number;
  concurrencyTotal: number;
}

export function resolveProfile(
  settings: PluginSettings,
  mode: SubscriptionMode,
  customLabel?: string,
  customProfile?: 'max5x' | 'max20x',
): { profile: ProfileSettings; label: string; profileKey: 'max5x' | 'max20x' } {
  if (mode === 'custom') {
    const profileKey = customProfile ?? settings.customProfile;
    return {
      profile: settings.profiles[profileKey],
      label: customLabel?.trim() || settings.customLabel,
      profileKey,
    };
  }
  return {
    profile: settings.profiles[mode],
    label: settings.profiles[mode].label,
    profileKey: mode,
  };
}

export function generateValues(profile: ProfileSettings): GeneratedValues {
  const usage5h = randomInt(0, 100);
  const usage7d = randomInt(0, 90);
  const usage7dF = randomInt(0, 90);
  const usage5hAmount = roundMoney(randomInRange(profile.usage5h));
  const usage7dAmount = roundMoney(
    Math.max(randomInRange(profile.usage7d), usage5hAmount * 2),
  );
  const survivalDays = Math.max(0, Math.round(randomInRange(profile.survivalDays)));
  const rawToday = Math.max(randomInRange(profile.today), usage5hAmount);
  const todayLimit = survivalDays < 7 ? usage7dAmount / 2 : Number.POSITIVE_INFINITY;
  const today = roundMoney(Math.min(rawToday, todayLimit));
  const rawTotalExtra = Math.max(randomInRange(profile.totalExtra), today);
  const totalExtra =
    survivalDays < 7
      ? Math.min(rawTotalExtra, Math.max(today, usage7dAmount - today))
      : rawTotalExtra;
  const total = roundMoney(today + totalExtra);
  const concurrencyTotal = Math.max(1, Math.round(randomInRange(profile.concurrencyTotal)));
  const concurrencyCurrent = randomInt(0, concurrencyTotal);

  return {
    usage5h: today > 0 ? Math.max(1, usage5h) : usage5h,
    usage7d,
    usage7dF,
    usage5hAmount,
    usage7dAmount,
    survivalDays,
    today,
    total,
    concurrencyCurrent,
    concurrencyTotal,
  };
}

export function randomInRange(range: { min: number; max: number }): number {
  const min = Math.min(Number(range.min) || 0, Number(range.max) || 0);
  const max = Math.max(Number(range.min) || 0, Number(range.max) || 0);
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
