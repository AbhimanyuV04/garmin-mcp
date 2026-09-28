import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GarminSession } from '../garmin';
import { EXERCISE_CATALOG } from './exercise-catalog';
import {
  compact,
  dateSchema,
  defineTool,
  daysAgo,
  firstDeviceEntry,
  km,
  problem,
  round,
  text,
  today
} from './common';

// Garmin's workout-service enum ids. These are fixed server-side constants.
const SPORT_TYPES = {
  running: 1,
  cycling: 2,
  strength_training: 5,
  walking: 12
} as const;

const STEP_TYPES = {
  warmup: 1,
  cooldown: 2,
  interval: 3,
  recovery: 4,
  rest: 5
} as const;

const TARGET_TYPES = {
  'no.target': 1,
  'power.zone': 2,
  cadence: 3,
  'heart.rate.zone': 4,
  'pace.zone': 6
} as const;

// Garmin reports training status as an integer code with no label attached.
const TRAINING_STATUS_LABELS: Record<number, string> = {
  0: 'No Status',
  1: 'Detraining',
  2: 'Recovery',
  3: 'Maintaining',
  4: 'Productive',
  5: 'Peaking',
  6: 'Overreaching',
  7: 'Unproductive'
};

const targetSchema = z.object({
  type: z
    .enum(['no.target', 'heart.rate.zone', 'power.zone', 'pace.zone', 'cadence'])
    .describe('Target metric for this step.'),
  zone: z.number().int().min(1).max(5).optional().describe('Named zone 1-5.'),
  min: z
    .number()
    .optional()
    .describe('Custom range low end (bpm, watts, rpm, or m/s for pace). Requires max.'),
  max: z.number().optional().describe('Custom range high end. Requires min.')
});

// Garmin's end-condition ids. A step ends on the first of these it is given.
const END_CONDITIONS = {
  'lap.button': 1,
  time: 2,
  distance: 3,
  reps: 10
} as const;

// Garmin's exercise codes are SCREAMING_SNAKE (BENCH_PRESS, BARBELL_BENCH_PRESS);
// accept "bench press" too, since that is how a person will say it. Codes that
// open with a digit carry a leading underscore (_3_WAY_CALF_RAISE).
const exerciseCode = z
  .string()
  .trim()
  .min(1)
  .transform((v) => v.toUpperCase().replace(/[\s-]+/g, '_').replace(/^(\d)/, '_$1'))
  .pipe(z.string().regex(/^[A-Z0-9_]+$/, 'Exercise codes are letters, digits and underscores.'));

const exerciseSchema = z.object({
  category: exerciseCode.describe('Garmin exercise category, e.g. BENCH_PRESS, SQUAT, DEADLIFT.'),
  name: exerciseCode
    .optional()
    .describe(
      "Specific exercise within the category, e.g. BARBELL_BENCH_PRESS. Must be one of Garmin's codes for that category."
    )
});

const executableStep = z.object({
  type: z.enum(['warmup', 'interval', 'recovery', 'cooldown', 'rest']),
  durationSeconds: z.number().int().positive().optional(),
  distanceMeters: z.number().positive().optional(),
  reps: z.number().int().positive().optional().describe('Strength only: end the step after this many reps.'),
  lapButton: z
    .boolean()
    .optional()
    .describe('End the step when the lap button is pressed, e.g. rest until ready.'),
  exercise: exerciseSchema.optional().describe('Strength only: the exercise for this set.'),
  weightKg: z.number().positive().optional().describe('Strength only: planned load in kg.'),
  target: targetSchema.optional(),
  description: z.string().optional()
});

const repeatGroup = z.object({
  repeat: z.number().int().min(1).max(99).describe('How many times to repeat the nested steps.'),
  steps: z.array(executableStep).min(1)
});

type ExecutableStep = z.infer<typeof executableStep>;
type RepeatGroup = z.infer<typeof repeatGroup>;
type WorkoutStep = ExecutableStep | RepeatGroup;

const isRepeat = (step: WorkoutStep): step is RepeatGroup => 'repeat' in step;

function buildTarget(target?: z.infer<typeof targetSchema>) {
  const kind = target?.type ?? 'no.target';
  const base = {
    targetType: { workoutTargetTypeId: TARGET_TYPES[kind], workoutTargetTypeKey: kind }
  };
  if (kind === 'no.target') return base;
  // A custom range and a named zone are mutually exclusive in Garmin's model.
  if (target?.min != null && target?.max != null) {
    return { ...base, targetValueOne: target.min, targetValueTwo: target.max };
  }
  return { ...base, zoneNumber: target?.zone ?? 2 };
}

/** A step given several endings uses the first of distance, reps, time, lap button. */
function endConditionOf(step: ExecutableStep) {
  const [key, value]: [keyof typeof END_CONDITIONS, number | undefined] =
    step.distanceMeters != null
      ? ['distance', step.distanceMeters]
      : step.reps != null
        ? ['reps', step.reps]
        : step.durationSeconds != null || !step.lapButton
          ? ['time', step.durationSeconds]
          : ['lap.button', undefined];
  return {
    endCondition: { conditionTypeId: END_CONDITIONS[key], conditionTypeKey: key },
    endConditionValue: value
  };
}

function buildExecutable(step: ExecutableStep, order: number) {
  return {
    type: 'ExecutableStepDTO',
    stepOrder: order,
    stepType: { stepTypeId: STEP_TYPES[step.type], stepTypeKey: step.type },
    description: step.description,
    ...endConditionOf(step),
    ...buildTarget(step.target),
    ...(step.exercise
      ? { category: step.exercise.category, exerciseName: step.exercise.name }
      : {}),
    // Garmin keeps the planned load in the unit named here; kg keeps it exact.
    ...(step.weightKg != null
      ? { weightValue: step.weightKg, weightUnit: { unitId: 8, unitKey: 'kilogram', factor: 1000 } }
      : {})
  };
}

const words = (code: string) => code.split('_').filter(Boolean);

/**
 * Garmin does not reject an unknown exercise code: it saves the step with the
 * exercise blank. So check against its catalog here, and when a name is wrong
 * point at where it does live or at the closest names in the category.
 */
export function checkExercise(category: string, name?: string): string | null {
  const names = EXERCISE_CATALOG.get(category);
  if (!names) {
    return `Unknown exercise category ${category}. Garmin's categories are: ${[...EXERCISE_CATALOG.keys()].join(', ')}.`;
  }
  if (name === undefined || names.has(name)) return null;

  const elsewhere = [...EXERCISE_CATALOG].filter(([, n]) => n.has(name)).map(([c]) => c);
  if (elsewhere.length) {
    return `${name} is under ${elsewhere.join(' or ')}, not ${category}.`;
  }
  const wanted = words(name);
  const close = [...names]
    .map((n) => ({ n, score: words(n).filter((w) => wanted.includes(w)).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.n.length - b.n.length)
    .slice(0, 5)
    .map((c) => c.n);
  return `Garmin has no ${name} under ${category}.${close.length ? ` Closest: ${close.join(', ')}.` : ''}`;
}

/** Rejects step combinations Garmin's API accepts structurally but cannot run. */
export function validateSteps(steps: WorkoutStep[], sport?: keyof typeof SPORT_TYPES): string | null {
  // ponytail: one level of repeat nesting, which is all Garmin's own editor
  // exposes. Recurse buildWorkoutPayload if a workout ever needs deeper nesting.
  const flat = steps.flatMap((s) => (isRepeat(s) ? s.steps : [s]));
  const missing = flat.find(
    (s) => s.durationSeconds == null && s.distanceMeters == null && s.reps == null && !s.lapButton
  );
  if (missing) {
    return `Step "${missing.type}" needs durationSeconds, distanceMeters, reps or lapButton — Garmin cannot end a step without one.`;
  }
  if (
    sport !== undefined &&
    sport !== 'strength_training' &&
    flat.some((s) => s.reps != null || s.exercise || s.weightKg != null)
  ) {
    return 'reps, exercise and weightKg only apply to strength_training workouts.';
  }
  for (const s of flat) {
    const bad = s.exercise && checkExercise(s.exercise.category, s.exercise.name);
    if (bad) return bad;
  }
  if (flat.some((s) => s.target && (s.target.min == null) !== (s.target.max == null))) {
    return 'A custom target range needs both min and max, or use zone instead.';
  }
  return null;
}

export function buildWorkoutPayload(
  title: string,
  sport: keyof typeof SPORT_TYPES,
  steps: WorkoutStep[]
) {
  const sportType = { sportTypeId: SPORT_TYPES[sport], sportTypeKey: sport };
  const workoutSteps = steps.map((step, i) =>
    isRepeat(step)
      ? {
          type: 'RepeatGroupDTO',
          stepOrder: i + 1,
          numberOfIterations: step.repeat,
          workoutSteps: step.steps.map((s, j) => buildExecutable(s, j + 1))
        }
      : buildExecutable(step, i + 1)
  );
  return {
    workoutName: title,
    sportType,
    workoutSegments: [{ segmentOrder: 1, sportType, workoutSteps }]
  };
}

export function registerTrainingTools(server: McpServer, g: GarminSession): void {
  defineTool(
    server,
    'get_training_status',
    'Current training status (Productive, Peaking, Overreaching...), fitness age, VO2 max for running and cycling, acute and chronic training load, and the acute:chronic workload ratio.',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      // Fitness age and VO2 max live in separate services; a watch that reports
      // neither is common, so only the status call is allowed to fail the tool.
      const [status, fitnessAge, maxMet] = await Promise.all([
        g.api<any>(`/metrics-service/metrics/trainingstatus/aggregated/${day}`),
        g.api<any>(`/fitnessage-service/fitnessage/${day}`).catch(() => null),
        g.api<any>(`/metrics-service/metrics/maxmet/daily/${day}/${day}`).catch(() => null)
      ]);

      if (!status) return problem(`No training status available for ${day}.`);

      const latest = firstDeviceEntry<any>(status.mostRecentTrainingStatus?.latestTrainingStatusData);
      const balance = firstDeviceEntry<any>(
        status.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap
      );
      const load = latest?.acuteTrainingLoadDTO ?? {};
      // VO2 max and fitness age ride along in the training status payload. The
      // maxmet endpoint returns [] on this account and the fitnessage service
      // carries only the inputs, so neither is a reliable primary source.
      const vo2 = status.mostRecentVO2Max ?? (Array.isArray(maxMet) ? maxMet[0] : maxMet);
      const code = latest?.trainingStatus;

      return text(
        compact({
          date: day,
          training_status: typeof code === 'number' ? TRAINING_STATUS_LABELS[code] ?? code : code,
          training_status_code: typeof code === 'number' ? code : undefined,
          training_status_feedback: latest?.trainingStatusFeedbackPhrase,
          training_paused: latest?.trainingPaused,
          fitness_age: vo2?.generic?.fitnessAge ?? fitnessAge?.fitnessAge,
          chronological_age: fitnessAge?.chronologicalAge,
          resting_heart_rate_bpm: fitnessAge?.components?.rhr?.value,
          bmi: fitnessAge?.components?.bmi?.value,
          vo2_max_running: vo2?.generic?.vo2MaxPreciseValue ?? vo2?.generic?.vo2MaxValue,
          vo2_max_cycling: vo2?.cycling?.vo2MaxPreciseValue ?? vo2?.cycling?.vo2MaxValue,
          vo2_max_measured_date: vo2?.generic?.calendarDate,
          fitness_trend: latest?.fitnessTrend,
          load_level_trend: latest?.loadLevelTrend,
          primary_sport: latest?.sport,
          acute_load: load.dailyTrainingLoadAcute ?? load.acuteTrainingLoad,
          chronic_load: load.dailyTrainingLoadChronic ?? load.chronicTrainingLoad,
          // Garmin's optimal band is roughly 0.8-1.5; above that is overreaching.
          acute_chronic_ratio: load.dailyAcuteChronicWorkloadRatio
            ? round(load.dailyAcuteChronicWorkloadRatio, 2)
            : undefined,
          acwr_status: load.acwrStatus,
          load_ratio_percent: load.acwrPercent,
          chronic_load_target_min: load.minTrainingLoadChronic,
          chronic_load_target_max: load.maxTrainingLoadChronic,
          weekly_training_load: latest?.weeklyTrainingLoad,
          load_tunnel_min: latest?.loadTunnelMin,
          load_tunnel_max: latest?.loadTunnelMax,
          monthly_load_aerobic_low: balance?.monthlyLoadAerobicLow,
          monthly_load_aerobic_high: balance?.monthlyLoadAerobicHigh,
          monthly_load_anaerobic: balance?.monthlyLoadAnaerobic,
          load_balance_feedback: balance?.trainingBalanceFeedbackPhrase
        })
      );
    }
  );

  defineTool(
    server,
    'get_hrv_data',
    'Overnight heart rate variability: last night average, baseline balanced range, weekly average, and HRV status (Balanced, Unbalanced, Low, Poor).',
    { date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today.') },
    async ({ date }) => {
      const day = date ?? today();
      const raw = await g.api<any>(`/hrv-service/hrv/${day}`);
      const summary = raw?.hrvSummary;
      if (!summary) {
        return problem(
          `No HRV data for ${day}. HRV needs the watch worn overnight, and not all models record it.`
        );
      }

      const baseline = summary.baseline ?? {};
      return text(
        compact({
          date: summary.calendarDate ?? day,
          hrv_status: summary.status,
          last_night_avg_ms: summary.lastNightAvg,
          last_night_5min_high_ms: summary.lastNight5MinHigh,
          weekly_avg_ms: summary.weeklyAvg,
          baseline_balanced_low_ms: baseline.balancedLow,
          baseline_balanced_high_ms: baseline.balancedUpper,
          baseline_low_threshold_ms: baseline.lowUpper,
          baseline_marker_ms: baseline.markerValue,
          feedback: summary.feedbackPhrase
        })
      );
    }
  );

  defineTool(
    server,
    'get_cycling_metrics',
    'Cycling Functional Threshold Power (FTP), configured power zones, and lactate threshold heart rate and pace.',
    {},
    async () => {
      // Garmin only computes lactate threshold from running efforts, even for
      // cyclists. Every one of these is hardware or history dependent.
      const range = `${daysAgo(365)}/${today()}`;
      const [ftp, powerZones, ltHr, ltSpeed] = await Promise.all([
        g.api<any>('/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING').catch(
          () => null
        ),
        g.api<any>('/biometric-service/powerZones/sports/all').catch(() => null),
        g.api<any>(
          `/biometric-service/stats/lactateThresholdHeartRate/range/${range}?sport=RUNNING&aggregation=daily&aggregationStrategy=LATEST`
        ).catch(() => null),
        g.api<any>(
          `/biometric-service/stats/lactateThresholdSpeed/range/${range}?sport=RUNNING&aggregation=daily&aggregationStrategy=LATEST`
        ).catch(() => null)
      ]);

      const ftpEntry = Array.isArray(ftp) ? ftp[0] : ftp;
      const ftpWatts = ftpEntry?.functionalThresholdPower;
      const latest = (v: unknown) => (Array.isArray(v) ? v[v.length - 1] : v);
      const hrEntry = latest(ltHr);
      const speedEntry = latest(ltSpeed);
      const speedMs = speedEntry?.value ?? speedEntry?.lactateThresholdSpeed;

      // Garmin models seven power zones and names the boundaries zoneNFloor.
      const zones = Array.isArray(powerZones)
        ? powerZones
            .filter((z: any) => z?.sport === 'CYCLING')
            .map((z: any) =>
              compact({
                sport: z.sport,
                ftp_watts: z.functionalThresholdPower,
                zone_floors_watts: [1, 2, 3, 4, 5, 6, 7]
                  .map((n) => z[`zone${n}Floor`])
                  .filter((w: unknown) => typeof w === 'number')
              })
            )
        : [];

      const result = compact({
        ftp_watts: ftpWatts,
        ftp_measured_date: ftpEntry?.calendarDate ?? ftpEntry?.timestamp,
        power_zones: zones.length ? zones : undefined,
        lactate_threshold_heart_rate_bpm: hrEntry?.value ?? hrEntry?.lactateThresholdHeartRate,
        // Garmin stores threshold speed in m/s; runners think in min/km.
        lactate_threshold_speed_mps: typeof speedMs === 'number' ? round(speedMs, 2) : undefined,
        lactate_threshold_pace_min_per_km:
          typeof speedMs === 'number' && speedMs > 0
            ? round(1000 / speedMs / 60, 2)
            : undefined,
        lactate_threshold_note:
          hrEntry || speedEntry ? 'Garmin derives lactate threshold from running, not cycling.' : undefined
      });

      if (!Object.keys(result).length) {
        return problem(
          'No cycling performance metrics recorded. FTP and power zones need a power meter; lactate threshold needs a guided test or hard run.'
        );
      }
      return text(result);
    }
  );

  defineTool(
    server,
    'get_training_plans_and_workouts',
    'Saved workout library, active training plans, upcoming scheduled workouts, and gear mileage totals for shoes and bikes.',
    {
      limit: z.number().int().min(1).max(50).optional().describe('Workouts to return. Default 10.'),
      activeOnly: z
        .boolean()
        .optional()
        .describe('Only active training plans and non-retired gear. Default true.')
    },
    async ({ limit, activeOnly }) => {
      const max = limit ?? 10;
      const onlyActive = activeOnly ?? true;
      const now = new Date();

      const [workouts, plans, gear, calendar] = await Promise.all([
        g.api<any[]>('/workout-service/workouts', { start: '0', limit: String(max) }).catch(() => null),
        g.api<any>('/trainingplan-service/trainingplan/plans').catch(() => null),
        g.api<any[]>('/gear-service/gear/filterGear', {
          userProfilePk: String(await g.getProfileId())
        }).catch(() => null),
        // Calendar months are 0-indexed in this service.
        g.api<any>(`/calendar-service/year/${now.getFullYear()}/month/${now.getMonth()}`).catch(
          () => null
        )
      ]);

      // Gear mileage lives in a separate stats call keyed by gear uuid.
      // Named `item`, not `g`: `g` is the Garmin session in this scope.
      const gearList = (gear ?? []).filter((item: any) =>
        onlyActive ? item?.gearStatusName?.toLowerCase() !== 'retired' : true
      );
      const gearWithStats = await Promise.all(
        gearList.map(async (item: any) => {
          const stats = await g
            .api<any>(`/gear-service/gear/stats/${item.uuid}`)
            .catch(() => null);
          return compact({
            name: item.displayName ?? item.customMakeModel,
            type: item.gearTypeName,
            status: item.gearStatusName,
            total_distance_km: km(stats?.totalDistance),
            total_activities: stats?.totalActivities,
            // Shoes carry a retirement threshold; bikes usually don't.
            retire_at_km: km(item.maximumMeters),
            percent_of_life_used:
              stats?.totalDistance && item.maximumMeters
                ? round((stats.totalDistance / item.maximumMeters) * 100)
                : undefined
          });
        })
      );

      const planList = (Array.isArray(plans) ? plans : plans?.trainingPlanList ?? []).filter(
        (p: any) => (onlyActive ? p?.active !== false : true)
      );

      const iso = today();
      const scheduled = (calendar?.calendarItems ?? [])
        .filter((i: any) => i?.itemType === 'workout' && i?.date >= iso)
        .slice(0, max)
        .map((i: any) =>
          compact({ date: i.date, title: i.title, sport: i.workoutType ?? i.activityType })
        );

      return text(
        compact({
          workout_library: (workouts ?? []).map((w: any) =>
            compact({
              workout_id: w.workoutId,
              name: w.workoutName,
              sport: w.sportType?.sportTypeKey,
              estimated_duration_minutes: w.estimatedDurationInSecs
                ? round(w.estimatedDurationInSecs / 60)
                : undefined,
              updated: w.updateDate
            })
          ),
          training_plans: planList.map((p: any) =>
            compact({
              plan_id: p.trainingPlanId ?? p.planId,
              name: p.trainingPlanName ?? p.planName,
              active: p.active,
              start_date: p.startDate,
              end_date: p.endDate
            })
          ),
          scheduled_workouts: scheduled.length ? scheduled : undefined,
          gear: gearWithStats.length ? gearWithStats : undefined
        })
      );
    }
  );

  defineTool(
    server,
    'create_workout',
    'Create a structured workout in Garmin Connect so it syncs to the watch. Steps run in order; wrap repeated blocks in a repeat group. Strength workouts give each set an exercise, reps and optional weightKg, with rest steps ending on time or lapButton. Writes to the Garmin account.',
    {
      title: z.string().min(1).max(80),
      sport: z.enum(['running', 'cycling', 'walking', 'strength_training']),
      steps: z
        .array(z.union([repeatGroup, executableStep]))
        .min(1)
        .describe(
          'Ordered steps. Each needs durationSeconds, distanceMeters, reps or lapButton. Use {repeat, steps} for intervals or sets.'
        )
    },
    async ({ title, sport, steps }) => {
      const invalid = validateSteps(steps, sport);
      if (invalid) return problem(invalid);

      const payload = buildWorkoutPayload(title, sport, steps);
      const created = await g.apiPost<any>('/workout-service/workout', payload);

      return text({
        workout_id: created?.workoutId,
        name: created?.workoutName ?? title,
        sport,
        steps: payload.workoutSegments[0].workoutSteps.length,
        note: 'Created in Garmin Connect. It reaches the watch on the next sync.'
      });
    },
    { readOnlyHint: false, destructiveHint: false }
  );
}
