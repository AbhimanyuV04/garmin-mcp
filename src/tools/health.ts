import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api, getDisplayName } from '../garmin';

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** Local calendar date — Garmin days are local, so UTC would be off by a day. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

/** Garmin returns nulls for every metric the device didn't record; drop them. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  ) as Partial<T>;
}

const round = (n: number, places = 1) => Number(n.toFixed(places));
const hours = (seconds: number) => round(seconds / 3600, 2);
const pct = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100) : undefined);

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (value: unknown): Result => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
});

const problem = (message: string): Result => ({
  content: [{ type: 'text', text: message }],
  isError: true
});

/**
 * Registers a tool with uniform error handling: Garmin answers 404/204 for a
 * date the watch wasn't worn, which is a normal empty day rather than a fault.
 */
function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>
): void {
  server.registerTool(name, { description, inputSchema }, (async (args: unknown) => {
    try {
      return await handler(args as z.infer<z.ZodObject<S>>);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 204) {
        return problem(`No data available from Garmin for that date.`);
      }
      if (status === 401 || status === 403) {
        return problem('Garmin rejected the session. Re-run `npm run auth` to refresh tokens.');
      }
      if (status === 429) {
        return problem('Garmin is rate limiting this account. Wait a few minutes and retry.');
      }
      const message = err instanceof Error ? err.message : String(err);
      return problem(`Could not fetch ${name}: ${message}`);
    }
  }) as Parameters<McpServer['registerTool']>[2]);
}

export function registerHealthTools(server: McpServer): void {
  defineTool(
    server,
    'get_sleep_data',
    'Sleep duration, sleep score, deep/light/REM stage breakdown and quality qualifiers for a date.',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      const raw = await api<any>('/wellness-service/wellness/dailySleepData', {
        date: day,
        nonSleepBufferMinutes: '60'
      });
      const dto = raw?.dailySleepDTO;
      if (!dto || dto.sleepTimeSeconds == null) {
        return problem(`No sleep recorded for ${day}. The watch may not have been worn overnight.`);
      }

      const total: number = dto.sleepTimeSeconds;
      const scores = dto.sleepScores ?? {};
      const spo2 = raw.wellnessSpO2SleepSummaryDTO ?? {};

      return text(
        compact({
          date: day,
          sleep_hours: hours(total),
          sleep_start: dto.sleepStartTimestampGMT,
          sleep_end: dto.sleepEndTimestampGMT,
          nap_hours: dto.napTimeSeconds ? hours(dto.napTimeSeconds) : undefined,
          sleep_score: scores.overall?.value,
          sleep_score_qualifier: scores.overall?.qualifierKey,
          duration_qualifier: scores.totalDuration?.qualifierKey,
          deep_sleep_hours: hours(dto.deepSleepSeconds ?? 0),
          light_sleep_hours: hours(dto.lightSleepSeconds ?? 0),
          rem_sleep_hours: hours(dto.remSleepSeconds ?? 0),
          awake_hours: hours(dto.awakeSleepSeconds ?? 0),
          deep_sleep_percent: pct(dto.deepSleepSeconds ?? 0, total),
          light_sleep_percent: pct(dto.lightSleepSeconds ?? 0, total),
          rem_sleep_percent: pct(dto.remSleepSeconds ?? 0, total),
          awake_count: dto.awakeCount,
          restless_moments: dto.restlessMomentsCount,
          avg_sleep_stress: dto.avgSleepStress,
          resting_heart_rate_bpm: dto.restingHeartRate,
          avg_overnight_hrv: raw.avgOvernightHrv,
          avg_spo2_percent: spo2.averageSpo2,
          lowest_spo2_percent: spo2.lowestSpo2
        })
      );
    }
  );

  defineTool(
    server,
    'get_heart_rate',
    'Resting, min, max and average heart rate plus a timeline summary for a date.',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      const raw = await api<any>(
        `/wellness-service/wellness/dailyHeartRate/${await getDisplayName()}`,
        { date: day }
      );
      if (!raw || raw.restingHeartRate == null) {
        return problem(`No heart rate data for ${day}.`);
      }

      // heartRateValues is [[epochMs, bpm], ...]; nulls mark gaps in wear time.
      const samples: number[] = (raw.heartRateValues ?? [])
        .map((entry: [number, number | null]) => entry?.[1])
        .filter((bpm: number | null): bpm is number => typeof bpm === 'number' && bpm > 0);

      return text(
        compact({
          date: raw.calendarDate ?? day,
          resting_heart_rate_bpm: raw.restingHeartRate,
          max_heart_rate_bpm: raw.maxHeartRate,
          min_heart_rate_bpm: raw.minHeartRate,
          last_7_days_avg_resting_bpm: raw.lastSevenDaysAvgRestingHeartRate,
          avg_heart_rate_bpm: samples.length
            ? round(samples.reduce((a, b) => a + b, 0) / samples.length)
            : undefined,
          samples_recorded: samples.length || undefined
        })
      );
    }
  );

  defineTool(
    server,
    'get_body_battery',
    'Body battery high/low levels, charge and drain totals, and same-day stress correlation.',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      const [days, stress] = await Promise.all([
        api<any[]>('/wellness-service/wellness/bodyBattery/reports/daily', {
          startDate: day,
          endDate: day
        }),
        // Stress shares the body battery engine, so pair them; a failure here
        // must not sink the whole tool.
        api<any>(`/wellness-service/wellness/dailyStress/${day}`).catch(() => null)
      ]);

      const report = days?.[0];
      if (!report) return problem(`No body battery data for ${day}.`);

      // bodyBatteryValuesArray entries are [timestamp, status, level, version].
      const levels: number[] = (report.bodyBatteryValuesArray ?? [])
        .map((entry: unknown[]) => entry?.[2])
        .filter((v: unknown): v is number => typeof v === 'number' && v >= 0);

      const events = (report.bodyBatteryActivityEvent ?? []).map((e: any) =>
        compact({
          type: e.eventType,
          start_time: e.eventStartTimeGmt,
          duration_minutes: e.durationInMilliseconds
            ? round(e.durationInMilliseconds / 60000)
            : undefined,
          body_battery_impact: e.bodyBatteryImpact,
          feedback: e.shortFeedback
        })
      );

      return text(
        compact({
          date: report.date ?? day,
          charged: report.charged,
          drained: report.drained,
          highest_level: levels.length ? Math.max(...levels) : undefined,
          lowest_level: levels.length ? Math.min(...levels) : undefined,
          current_level: report.bodyBatteryDynamicFeedbackEvent?.bodyBatteryLevel,
          current_feedback: report.bodyBatteryDynamicFeedbackEvent?.feedbackShortType,
          avg_stress_level: stress?.avgStressLevel,
          max_stress_level: stress?.maxStressLevel,
          events: events.length ? events : undefined
        })
      );
    }
  );

  defineTool(
    server,
    'get_stress_and_respiration',
    'Average and max stress, time spent in each stress band, respiration rate (BRPM), and SpO2 averages when the device records them.',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      // Respiration and SpO2 are hardware-dependent — many watches report
      // neither, so a miss on those is normal rather than an error.
      const [stress, respiration, spo2] = await Promise.all([
        api<any>(`/wellness-service/wellness/dailyStress/${day}`).catch(() => null),
        api<any>(`/wellness-service/wellness/daily/respiration/${day}`).catch(() => null),
        api<any>(`/wellness-service/wellness/daily/spo2/${day}`).catch(() => null)
      ]);

      if (!stress && !respiration && !spo2) {
        return problem(`No stress, respiration or SpO2 data for ${day}.`);
      }

      // stressValuesArray is [[epochMs, level], ...]; -1/-2 mark gaps and activity.
      const levels: number[] = (stress?.stressValuesArray ?? [])
        .map((entry: [number, number]) => entry?.[1])
        .filter((v: number) => typeof v === 'number' && v > 0);

      const inBand = (lo: number, hi: number) =>
        pct(levels.filter((v) => v >= lo && v < hi).length, levels.length);

      // Garmin samples stress every 3 minutes.
      const highStressSamples = levels.filter((v) => v >= 76).length;

      return text(
        compact({
          date: day,
          avg_stress_level: stress?.avgStressLevel,
          max_stress_level: stress?.maxStressLevel,
          rest_percent: inBand(0, 26),
          low_stress_percent: inBand(26, 51),
          medium_stress_percent: inBand(51, 76),
          high_stress_percent: inBand(76, Infinity),
          high_stress_minutes: levels.length ? highStressSamples * 3 : undefined,
          avg_waking_breaths_per_min: respiration?.avgWakingRespirationValue,
          avg_sleep_breaths_per_min: respiration?.avgSleepRespirationValue,
          lowest_breaths_per_min: respiration?.lowestRespirationValue,
          highest_breaths_per_min: respiration?.highestRespirationValue,
          avg_spo2_percent: spo2?.averageSpO2,
          lowest_spo2_percent: spo2?.lowestSpO2,
          avg_sleep_spo2_percent: spo2?.avgSleepSpO2,
          last_7_days_avg_spo2: spo2?.lastSevenDaysAvgSpO2
        })
      );
    }
  );

  defineTool(
    server,
    'get_daily_summary',
    'Steps against goal, active and total calories, intensity minutes, floors climbed, and distance for a date.',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      const raw = await api<any>(
        `/usersummary-service/usersummary/daily/${await getDisplayName()}`,
        { calendarDate: day }
      );
      if (!raw || raw.privacyProtected === true) {
        return problem(`No daily summary available for ${day}.`);
      }

      const moderate = raw.moderateIntensityMinutes ?? 0;
      const vigorous = raw.vigorousIntensityMinutes ?? 0;

      return text(
        compact({
          date: raw.calendarDate ?? day,
          total_steps: raw.totalSteps,
          step_goal: raw.dailyStepGoal,
          step_goal_percent: pct(raw.totalSteps ?? 0, raw.dailyStepGoal ?? 0),
          distance_km: raw.totalDistanceMeters
            ? round(raw.totalDistanceMeters / 1000, 2)
            : undefined,
          total_calories: raw.totalKilocalories,
          active_calories: raw.activeKilocalories,
          bmr_calories: raw.bmrKilocalories,
          // Garmin's weekly goal counts vigorous minutes double.
          moderate_intensity_minutes: raw.moderateIntensityMinutes,
          vigorous_intensity_minutes: raw.vigorousIntensityMinutes,
          total_intensity_minutes: moderate + vigorous * 2,
          intensity_minutes_goal: raw.intensityMinutesGoal,
          floors_ascended: raw.floorsAscended,
          floors_descended: raw.floorsDescended,
          floors_goal: raw.userFloorsAscendedGoal,
          resting_heart_rate_bpm: raw.restingHeartRate,
          avg_stress_level: raw.averageStressLevel
        })
      );
    }
  );

  defineTool(
    server,
    'get_body_composition',
    'Weight, BMI, body fat %, muscle mass and bone mass trends over a date range.',
    {
      startDate: dateSchema.optional().describe('YYYY-MM-DD. Defaults to 30 days ago.'),
      endDate: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.')
    },
    async ({ startDate, endDate }) => {
      const end = endDate ?? today();
      const start =
        startDate ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      if (start > end) return problem(`startDate ${start} is after endDate ${end}.`);

      const raw = await api<any>('/weight-service/weight/dateRange', {
        startDate: start,
        endDate: end
      });

      const entries: any[] = raw?.dateWeightList ?? [];
      if (!entries.length) {
        return problem(`No weigh-ins recorded between ${start} and ${end}.`);
      }

      // Garmin stores mass in grams.
      const kg = (grams: number | null | undefined) =>
        typeof grams === 'number' ? round(grams / 1000, 2) : undefined;
      const avg = raw.totalAverage ?? {};

      return text(
        compact({
          start_date: start,
          end_date: end,
          measurements: entries.length,
          latest: compact({
            date: entries[0]?.calendarDate,
            weight_kg: kg(entries[0]?.weight),
            bmi: entries[0]?.bmi ? round(entries[0].bmi, 1) : undefined,
            body_fat_percent: entries[0]?.bodyFat ? round(entries[0].bodyFat) : undefined,
            body_water_percent: entries[0]?.bodyWater ? round(entries[0].bodyWater) : undefined,
            muscle_mass_kg: kg(entries[0]?.muscleMass),
            bone_mass_kg: kg(entries[0]?.boneMass)
          }),
          range_average: compact({
            weight_kg: kg(avg.weight),
            bmi: avg.bmi ? round(avg.bmi, 1) : undefined,
            body_fat_percent: avg.bodyFat ? round(avg.bodyFat) : undefined,
            muscle_mass_kg: kg(avg.muscleMass),
            bone_mass_kg: kg(avg.boneMass)
          }),
          weight_change_kg:
            entries.length > 1
              ? round(
                  ((entries[0]?.weight ?? 0) - (entries[entries.length - 1]?.weight ?? 0)) / 1000,
                  2
                )
              : undefined
        })
      );
    }
  );
}
