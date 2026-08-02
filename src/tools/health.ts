import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GarminSession } from '../garmin';
import {
  compact,
  dateSchema,
  daysAgo,
  defineTool,
  hours,
  localFromEpoch,
  num,
  pct,
  problem,
  round,
  text,
  today
} from './common';

export function registerHealthTools(server: McpServer, g: GarminSession): void {
  defineTool(
    server,
    'get_sleep_data',
    'Sleep duration, sleep score, deep/light/REM stage breakdown and quality qualifiers for a date.',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      const raw = await g.api<any>('/wellness-service/wellness/dailySleepData', {
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
          sleep_start: localFromEpoch(dto.sleepStartTimestampLocal ?? dto.sleepStartTimestampGMT),
          sleep_end: localFromEpoch(dto.sleepEndTimestampLocal ?? dto.sleepEndTimestampGMT),
          nap_hours: dto.napTimeSeconds ? hours(dto.napTimeSeconds) : undefined,
          sleep_score: scores.overall?.value,
          sleep_score_qualifier: scores.overall?.qualifierKey,
          duration_qualifier: scores.totalDuration?.qualifierKey,
          deep_sleep_hours: hours(dto.deepSleepSeconds ?? 0),
          light_sleep_hours: hours(dto.lightSleepSeconds ?? 0),
          rem_sleep_hours: hours(dto.remSleepSeconds ?? 0),
          awake_hours: hours(dto.awakeSleepSeconds ?? 0),
          unmeasurable_hours: dto.unmeasurableSleepSeconds
            ? hours(dto.unmeasurableSleepSeconds)
            : undefined,
          deep_sleep_percent: pct(dto.deepSleepSeconds ?? 0, total),
          light_sleep_percent: pct(dto.lightSleepSeconds ?? 0, total),
          rem_sleep_percent: pct(dto.remSleepSeconds ?? 0, total),
          // Without REM capability the stage split is coarse and deep sleep
          // absorbs what a newer device would classify as REM.
          device_tracks_rem: dto.deviceRemCapable,
          awake_count: dto.awakeCount,
          restless_moments: dto.restlessMomentsCount,
          avg_sleep_stress: dto.avgSleepStress,
          // Lives at the top level of the response, not inside dailySleepDTO.
          resting_heart_rate_bpm: raw.restingHeartRate ?? dto.restingHeartRate,
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
      const raw = await g.api<any>(
        `/wellness-service/wellness/dailyHeartRate/${await g.getDisplayName()}`,
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
        g.api<any[]>('/wellness-service/wellness/bodyBattery/reports/daily', {
          startDate: day,
          endDate: day
        }),
        // Stress shares the body battery engine, so pair them; a failure here
        // must not sink the whole tool.
        g.api<any>(`/wellness-service/wellness/dailyStress/${day}`).catch(() => null)
      ]);

      const report = days?.[0];
      if (!report) return problem(`No body battery data for ${day}.`);

      // Column order varies by device, so read the index Garmin declares rather
      // than assuming one. This account returns [timestamp, level], not the
      // 4-column layout older devices send.
      const levelIndex =
        (report.bodyBatteryValueDescriptorDTOList ?? []).find(
          (d: any) => d?.bodyBatteryValueDescriptorKey === 'bodyBatteryLevel'
        )?.bodyBatteryValueDescriptorIndex ?? 1;

      const levels: number[] = (report.bodyBatteryValuesArray ?? [])
        .map((entry: unknown[]) => entry?.[levelIndex])
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
          events: events.length ? events : undefined,
          // Garmin answers 200 with an all-null series when the device does not
          // support body battery, which would otherwise read as a healthy zero.
          body_battery_note:
            !levels.length && report.charged == null
              ? 'No body battery readings — this device does not report it. Stress values are shown instead.'
              : undefined
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
        g.api<any>(`/wellness-service/wellness/dailyStress/${day}`).catch(() => null),
        g.api<any>(`/wellness-service/wellness/daily/respiration/${day}`).catch(() => null),
        g.api<any>(`/wellness-service/wellness/daily/spo2/${day}`).catch(() => null)
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
      const raw = await g.api<any>(
        `/usersummary-service/usersummary/daily/${await g.getDisplayName()}`,
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
          floors_ascended: num(raw.floorsAscended, 0),
          floors_descended: num(raw.floorsDescended, 0),
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
      const start = startDate ?? daysAgo(30);
      if (start > end) return problem(`startDate ${start} is after endDate ${end}.`);

      const raw = await g.api<any>('/weight-service/weight/dateRange', {
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
