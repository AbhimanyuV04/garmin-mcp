import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GarminSession } from '../garmin';
import {
  compact,
  defineTool,
  hms,
  km,
  kmh,
  num,
  paceMinPerKm,
  problem,
  round,
  text
} from './common';

// Coerced because MCP clients routinely send numeric ids as strings, and the
// value is interpolated into a URL and a filename.
const activityId = z.coerce
  .number()
  .int()
  .positive()
  .describe('Garmin activity id, as returned by list_activities.');

const ACTIVITY_PATH = '/activity-service/activity';

/** Sports where pace reads naturally; everything else gets km/h. */
const PACE_SPORTS = /run|walk|hike|swim/i;

function speedFields(sport: string | undefined, metersPerSecond: number | null | undefined) {
  if (typeof metersPerSecond !== 'number' || metersPerSecond <= 0) return {};
  return PACE_SPORTS.test(sport ?? '')
    ? { avg_pace_min_per_km: paceMinPerKm(metersPerSecond) }
    : { avg_speed_kmh: kmh(metersPerSecond) };
}

const STRENGTH_SPORT = 'strength_training';

// Garmin stores strength weights in grams, on sets and on summed volume alike.
const kg = (grams: unknown) =>
  typeof grams === 'number' && grams > 0 ? round(grams / 1000, 1) : undefined;

/** Per-exercise totals the activity list already carries for strength sessions. */
export function strengthSummary(a: any) {
  const exercises = Array.isArray(a?.summarizedExerciseSets)
    ? a.summarizedExerciseSets.map((e: any) =>
        compact({
          exercise: e.subCategory ?? e.category,
          category: e.category,
          sets: e.sets,
          reps: e.reps,
          volume_kg: kg(e.volume)
        })
      )
    : [];
  return compact({
    total_sets: a?.activeSets ?? a?.totalSets,
    total_reps: a?.totalReps,
    exercises: exercises.length ? exercises : undefined
  });
}

/**
 * Flattens Garmin's exerciseSets into the sets a lifter logged. Rest periods
 * arrive as their own sets; fold each into the set before it as rest_after so
 * the list reads like a training log rather than alternating rows.
 */
export function summarizeExerciseSets(raw: any) {
  const sets: Record<string, unknown>[] = [];
  let reps = 0;
  let volume = 0;
  for (const s of Array.isArray(raw?.exerciseSets) ? raw.exerciseSets : []) {
    if (s?.setType !== 'ACTIVE') {
      const last = sets[sets.length - 1];
      if (last && typeof s?.duration === 'number') last.rest_after = hms(s.duration);
      continue;
    }
    // Garmin guesses the exercise and ranks candidates; the first-ranked wins.
    const guess = [...(s.exercises ?? [])].sort(
      (x: any, y: any) => (y?.probability ?? 0) - (x?.probability ?? 0)
    )[0];
    const count = typeof s.repetitionCount === 'number' ? s.repetitionCount : undefined;
    if (count) reps += count;
    if (count && typeof s.weight === 'number' && s.weight > 0) volume += count * s.weight;
    sets.push(
      compact({
        set: sets.length + 1,
        exercise: guess?.name ?? guess?.category,
        category: guess?.category,
        reps: count,
        weight_kg: kg(s.weight),
        duration: hms(s.duration)
      })
    );
  }
  return compact({
    total_sets: sets.length || undefined,
    total_reps: reps || undefined,
    total_volume_kg: kg(volume),
    sets: sets.length ? sets : undefined
  });
}

/**
 * Garmin's search takes a top-level type in activityType and rejects a
 * sub-type there ("Activity type cannot be an activity sub type"). Sub-types
 * such as strength_training go in activitySubType under their parent type,
 * which is how Garmin's own site filters them.
 */
export function subTypeQuery(types: unknown, key: string): Record<string, string> | null {
  const list = Array.isArray(types) ? types : [];
  const self = list.find((t: any) => t?.typeKey === key);
  const parent = list.find((t: any) => t?.typeId === self?.parentTypeId);
  return parent?.typeKey ? { activityType: parent.typeKey, activitySubType: key } : null;
}

const isSubTypeRejection = (err: unknown) =>
  /activity sub type/i.test(err instanceof Error ? err.message : String(err));

const DOWNLOADS = {
  // Garmin serves the original FIT wrapped in a zip; the others are plain XML.
  fit: { path: '/download-service/files/activity', ext: 'zip' },
  tcx: { path: '/download-service/export/tcx/activity', ext: 'tcx' },
  gpx: { path: '/download-service/export/gpx/activity', ext: 'gpx' }
} as const;

export function registerActivityTools(server: McpServer, g: GarminSession): void {
  defineTool(
    server,
    'list_activities',
    'Recent activities with id, title, sport, start time, distance, duration, average pace or speed, average heart rate and elevation gain. Strength sessions also carry sets, reps and per-exercise volume.',
    {
      limit: z.number().int().min(1).max(50).optional().describe('How many. Default 10, max 50.'),
      start: z.number().int().min(0).optional().describe('Offset for paging. Default 0.'),
      activityType: z
        .string()
        .optional()
        .describe('Garmin type key filter, e.g. running, cycling, swimming, strength_training.')
    },
    async ({ limit, start, activityType }) => {
      const search = (filter: Record<string, string>) =>
        g.api<any[]>(`/activitylist-service/activities/search/activities`, {
          start: String(start ?? 0),
          limit: String(limit ?? 10),
          ...filter
        });

      let activities: any[];
      try {
        activities = await search(activityType ? { activityType } : {});
      } catch (err) {
        if (!activityType || !isSubTypeRejection(err)) throw err;
        const types = await g.api<any[]>('/activity-service/activity/activityTypes');
        const query = subTypeQuery(types, activityType);
        if (!query) throw err;
        // The parent search can include siblings; keep only what was asked for.
        activities = (await search(query))?.filter(
          (a: any) => a.activityType?.typeKey === activityType
        );
      }

      if (!activities?.length) {
        return problem(
          activityType
            ? `No ${activityType} activities found. Check the type key — Garmin uses e.g. "running", not "Run".`
            : 'No activities found.'
        );
      }

      return text(
        activities.map((a: any) => {
          const sport = a.activityType?.typeKey;
          return compact({
            activity_id: a.activityId,
            title: a.activityName,
            sport,
            start_time: a.startTimeLocal,
            distance_km: km(a.distance),
            duration: hms(a.duration),
            ...speedFields(sport, a.averageSpeed),
            avg_heart_rate_bpm: a.averageHR,
            max_heart_rate_bpm: a.maxHR,
            elevation_gain_m: a.elevationGain != null ? round(a.elevationGain) : undefined,
            calories: a.calories,
            ...(sport === STRENGTH_SPORT ? strengthSummary(a) : {})
          });
        })
      );
    }
  );

  defineTool(
    server,
    'get_activity_details',
    'Full breakdown for one activity: lap splits, time in heart rate and power zones, elevation profile, cadence, normalized power, and aerobic/anaerobic training effect. Strength sessions list every set with exercise, reps, weight and rest instead of laps.',
    { activityId },
    async ({ activityId: id }) => {
      // Deliberately not calling /details — that endpoint returns the full
      // per-second time-series (megabytes). Summary, splits and zones carry
      // everything a reader actually needs.
      const [activity, splits, hrZones, powerZones] = await Promise.all([
        g.api<any>(`${ACTIVITY_PATH}/${id}`),
        g.api<any>(`${ACTIVITY_PATH}/${id}/splits`).catch(() => null),
        g.api<any>(`${ACTIVITY_PATH}/${id}/hrTimeInZones`).catch(() => null),
        g.api<any>(`${ACTIVITY_PATH}/${id}/powerTimeInZones`).catch(() => null)
      ]);

      if (!activity) return problem(`No activity found with id ${id}.`);

      const s = activity.summaryDTO ?? {};
      const sport = activity.activityTypeDTO?.typeKey;
      // Only strength sessions have sets, so runs and rides skip the extra call.
      const strength =
        sport === STRENGTH_SPORT
          ? summarizeExerciseSets(
              await g.api<any>(`${ACTIVITY_PATH}/${id}/exerciseSets`).catch(() => null)
            )
          : ({} as ReturnType<typeof summarizeExerciseSets>);

      const zoneList = (zones: unknown) =>
        Array.isArray(zones) && zones.length
          ? zones.map((z: any) =>
              compact({
                zone: z.zoneNumber,
                seconds: z.secsInZone != null ? round(z.secsInZone) : undefined,
                time: hms(z.secsInZone),
                low_boundary: z.zoneLowBoundary
              })
            )
          : undefined;

      const laps = (splits?.lapDTOs ?? []).map((lap: any, i: number) =>
        compact({
          lap: i + 1,
          distance_km: km(lap.distance),
          duration: hms(lap.duration),
          ...speedFields(sport, lap.averageSpeed),
          avg_heart_rate_bpm: num(lap.averageHR, 0),
          max_heart_rate_bpm: num(lap.maxHR, 0),
          elevation_gain_m: num(lap.elevationGain, 0),
          avg_power_watts: num(lap.averagePower)
        })
      );

      return text(
        compact({
          activity_id: activity.activityId ?? id,
          title: activity.activityName,
          sport,
          start_time: s.startTimeLocal,
          distance_km: km(s.distance),
          duration: hms(s.duration),
          moving_duration: hms(s.movingDuration),
          calories: s.calories,
          ...speedFields(sport, s.averageSpeed),
          max_speed_kmh: kmh(s.maxSpeed),
          avg_heart_rate_bpm: s.averageHR,
          max_heart_rate_bpm: s.maxHR,
          avg_cadence: num(s.averageRunCadence ?? s.averageBikeCadence),
          max_cadence: num(s.maxRunCadence ?? s.maxBikeCadence),
          avg_power_watts: num(s.averagePower),
          max_power_watts: num(s.maxPower),
          normalized_power_watts: num(s.normPower),
          elevation_gain_m: num(s.elevationGain, 0),
          elevation_loss_m: num(s.elevationLoss, 0),
          min_elevation_m: num(s.minElevation, 0),
          max_elevation_m: num(s.maxElevation, 0),
          aerobic_training_effect: num(s.trainingEffect),
          anaerobic_training_effect: num(s.anaerobicTrainingEffect),
          training_effect_label: s.trainingEffectLabel,
          hr_time_in_zones: zoneList(hrZones),
          power_time_in_zones: zoneList(powerZones),
          ...strength,
          // A strength session's laps are its sets again, minus the detail.
          laps: laps.length && !strength.sets ? laps : undefined
        })
      );
    }
  );

  defineTool(
    server,
    'update_activity',
    'Edit an activity on Garmin Connect: title, description, event type, or perceived effort. Writes to the Garmin account.',
    {
      activityId,
      title: z.string().min(1).max(120).optional(),
      description: z.string().max(1000).optional(),
      eventTypeId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Garmin event type id, e.g. 9 training, 1 race.'),
      rpe: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Perceived exertion 1-10.'),
      feel: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('How the effort felt, 0 (poor) to 100 (strong).')
    },
    async ({ activityId: id, title, description, eventTypeId, rpe, feel }) => {
      if (
        title === undefined &&
        description === undefined &&
        eventTypeId === undefined &&
        rpe === undefined &&
        feel === undefined
      ) {
        return problem('Nothing to update — pass at least one of title, description, eventTypeId, rpe or feel.');
      }

      // Garmin stores RPE on a 10-100 scale, ten points per RPE point.
      const summaryDTO = compact({
        directWorkoutRpe: rpe != null ? rpe * 10 : undefined,
        directWorkoutFeel: feel
      });

      const payload = compact({
        activityId: id,
        activityName: title,
        description,
        eventTypeDTO: eventTypeId != null ? { typeId: eventTypeId } : undefined,
        summaryDTO: Object.keys(summaryDTO).length ? summaryDTO : undefined
      });

      await g.apiPut(`${ACTIVITY_PATH}/${id}`, payload);

      return text({
        activity_id: id,
        updated: Object.keys(payload).filter((k) => k !== 'activityId'),
        note: 'Garmin returns no body on a successful edit; re-read with get_activity_details to confirm.'
      });
    },
    { readOnlyHint: false, destructiveHint: false }
  );

  defineTool(
    server,
    'download_activity_file',
    'Download an activity as fit, gpx or tcx and save it locally. Returns the saved path.',
    {
      activityId,
      format: z.enum(['fit', 'gpx', 'tcx']).describe('fit arrives as a zip; gpx and tcx are XML.'),
      directory: z
        .string()
        .optional()
        .describe('Where to save. Defaults to ~/.garmin-mcp/activities.')
    },
    async ({ activityId: id, format, directory }) => {
      const { path, ext } = DOWNLOADS[format];
      const data = await g.apiDownload(`${path}/${id}`);

      if (!data.length) {
        return problem(`Garmin returned an empty ${format} file for activity ${id}.`);
      }

      const dir = directory ?? join(homedir(), '.garmin-mcp', 'activities');
      mkdirSync(dir, { recursive: true });
      // id is a validated integer, so it cannot escape the directory.
      const file = join(dir, `activity_${id}.${ext}`);
      writeFileSync(file, data);

      return text({
        activity_id: id,
        format,
        path: file,
        bytes: data.length,
        ...(format === 'fit' ? { note: 'FIT downloads are zipped by Garmin.' } : {})
      });
    },
    { readOnlyHint: false, destructiveHint: false }
  );
}
