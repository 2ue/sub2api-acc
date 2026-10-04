import { defaultModifyOptions } from './defaults';
import { defaultSettings } from './defaults';
import type { ModifyOptions, PluginSettings } from './types';

const SETTINGS_KEY = 'sub2api_display_settings';
const OPTIONS_KEY = 'sub2api_last_modify_options';
const SETTINGS_SCHEMA_KEY = 'sub2api_display_settings_schema';
const OPTIONS_SCHEMA_KEY = 'sub2api_modify_options_schema';
const SETTINGS_SCHEMA_VERSION = 2;
const OPTIONS_SCHEMA_VERSION = 2;

export async function getSettings(): Promise<PluginSettings> {
  const stored = await browser.storage.local.get([SETTINGS_KEY, SETTINGS_SCHEMA_KEY]);
  if (stored[SETTINGS_SCHEMA_KEY] !== SETTINGS_SCHEMA_VERSION) {
    const next = structuredClone(defaultSettings);
    await browser.storage.local.set({
      [SETTINGS_KEY]: next,
      [SETTINGS_SCHEMA_KEY]: SETTINGS_SCHEMA_VERSION,
    });
    return next;
  }
  return mergeSettings(stored[SETTINGS_KEY] as Partial<PluginSettings> | undefined);
}

export async function saveSettings(settings: PluginSettings): Promise<void> {
  await browser.storage.local.set({
    [SETTINGS_KEY]: settings,
    [SETTINGS_SCHEMA_KEY]: SETTINGS_SCHEMA_VERSION,
  });
}

export async function getModifyOptions(): Promise<ModifyOptions> {
  const stored = await browser.storage.local.get([OPTIONS_KEY, OPTIONS_SCHEMA_KEY]);
  if (stored[OPTIONS_SCHEMA_KEY] !== OPTIONS_SCHEMA_VERSION) {
    const next = structuredClone(defaultModifyOptions);
    await browser.storage.local.set({
      [OPTIONS_KEY]: next,
      [OPTIONS_SCHEMA_KEY]: OPTIONS_SCHEMA_VERSION,
    });
    return next;
  }
  return {
    ...defaultModifyOptions,
    ...(stored[OPTIONS_KEY] as Partial<ModifyOptions> | undefined),
  };
}

export async function saveModifyOptions(options: ModifyOptions): Promise<void> {
  await browser.storage.local.set({
    [OPTIONS_KEY]: options,
    [OPTIONS_SCHEMA_KEY]: OPTIONS_SCHEMA_VERSION,
  });
}

function mergeSettings(value: Partial<PluginSettings> | undefined): PluginSettings {
  const incoming = value ?? {};
  return {
    ...defaultSettings,
    ...incoming,
    accountCount: {
      ...defaultSettings.accountCount,
      ...(incoming.accountCount ?? {}),
    },
    statusRatios: {
      ...defaultSettings.statusRatios,
      ...(incoming.statusRatios ?? {}),
    },
    profiles: {
      max5x: {
        ...defaultSettings.profiles.max5x,
        ...(incoming.profiles?.max5x ?? {}),
        usage5h: {
          ...defaultSettings.profiles.max5x.usage5h,
          ...(incoming.profiles?.max5x?.usage5h ?? {}),
        },
        usage7d: {
          ...defaultSettings.profiles.max5x.usage7d,
          ...(incoming.profiles?.max5x?.usage7d ?? {}),
        },
        survivalDays: {
          ...defaultSettings.profiles.max5x.survivalDays,
          ...(incoming.profiles?.max5x?.survivalDays ?? {}),
        },
        today: {
          ...defaultSettings.profiles.max5x.today,
          ...(incoming.profiles?.max5x?.today ?? {}),
        },
        totalExtra: {
          ...defaultSettings.profiles.max5x.totalExtra,
          ...(incoming.profiles?.max5x?.totalExtra ?? {}),
        },
        concurrencyTotal: {
          ...defaultSettings.profiles.max5x.concurrencyTotal,
          ...(incoming.profiles?.max5x?.concurrencyTotal ?? {}),
        },
      },
      max20x: {
        ...defaultSettings.profiles.max20x,
        ...(incoming.profiles?.max20x ?? {}),
        usage5h: {
          ...defaultSettings.profiles.max20x.usage5h,
          ...(incoming.profiles?.max20x?.usage5h ?? {}),
        },
        usage7d: {
          ...defaultSettings.profiles.max20x.usage7d,
          ...(incoming.profiles?.max20x?.usage7d ?? {}),
        },
        survivalDays: {
          ...defaultSettings.profiles.max20x.survivalDays,
          ...(incoming.profiles?.max20x?.survivalDays ?? {}),
        },
        today: {
          ...defaultSettings.profiles.max20x.today,
          ...(incoming.profiles?.max20x?.today ?? {}),
        },
        totalExtra: {
          ...defaultSettings.profiles.max20x.totalExtra,
          ...(incoming.profiles?.max20x?.totalExtra ?? {}),
        },
        concurrencyTotal: {
          ...defaultSettings.profiles.max20x.concurrencyTotal,
          ...(incoming.profiles?.max20x?.concurrencyTotal ?? {}),
        },
      },
    },
  };
}
