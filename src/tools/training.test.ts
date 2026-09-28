import assert from 'node:assert/strict';
import { buildWorkoutPayload, checkExercise, validateSteps } from './training';

// 10m warmup, 5x(400m hard Z4 / 90s recovery), 10m cooldown.
const payload = buildWorkoutPayload('Intervals', 'running', [
  { type: 'warmup', durationSeconds: 600 },
  {
    repeat: 5,
    steps: [
      { type: 'interval', distanceMeters: 400, target: { type: 'heart.rate.zone', zone: 4 } },
      { type: 'recovery', durationSeconds: 90 }
    ]
  },
  { type: 'cooldown', durationSeconds: 600 }
]);

const steps = payload.workoutSegments[0].workoutSteps as any[];
assert.equal(payload.sportType.sportTypeId, 1, 'running sport id');
assert.equal(steps.length, 3, 'repeat group stays one top-level step');
assert.deepEqual(
  steps.map((s) => s.stepOrder),
  [1, 2, 3],
  'top-level steps are ordered from 1'
);

// Distance steps must end on distance, time steps on time — Garmin rejects a
// mismatched conditionType/endConditionValue pair.
const [warmup, group, cooldown] = steps;
assert.equal(warmup.endCondition.conditionTypeKey, 'time');
assert.equal(warmup.endConditionValue, 600);
assert.equal(warmup.targetType.workoutTargetTypeKey, 'no.target');

assert.equal(group.type, 'RepeatGroupDTO');
assert.equal(group.numberOfIterations, 5);
assert.deepEqual(
  group.workoutSteps.map((s: any) => s.stepOrder),
  [1, 2],
  'nested steps re-number from 1'
);
assert.equal(group.workoutSteps[0].endCondition.conditionTypeKey, 'distance');
assert.equal(group.workoutSteps[0].endConditionValue, 400);
assert.equal(group.workoutSteps[0].zoneNumber, 4);
assert.equal(group.workoutSteps[1].stepType.stepTypeId, 4, 'recovery step id');
assert.equal(cooldown.stepType.stepTypeId, 2, 'cooldown step id');

// A custom bpm range replaces the named zone rather than joining it.
const custom = buildWorkoutPayload('Easy', 'running', [
  { type: 'interval', durationSeconds: 1800, target: { type: 'heart.rate.zone', min: 136, max: 148 } }
]).workoutSegments[0].workoutSteps[0] as any;
assert.equal(custom.targetValueOne, 136);
assert.equal(custom.targetValueTwo, 148);
assert.equal(custom.zoneNumber, undefined, 'range and zone are mutually exclusive');

assert.equal(validateSteps([{ type: 'warmup', durationSeconds: 60 }]), null);
assert.match(validateSteps([{ type: 'warmup' }])!, /durationSeconds, distanceMeters, reps or lapButton/);
assert.match(
  validateSteps([{ repeat: 2, steps: [{ type: 'interval' }] }])!,
  /durationSeconds, distanceMeters, reps or lapButton/,
  'validation reaches inside repeat groups'
);
assert.match(
  validateSteps([
    { type: 'interval', durationSeconds: 60, target: { type: 'heart.rate.zone', min: 130 } }
  ])!,
  /both min and max/
);

// 3x10 bench at 60 kg with lap-button rest between sets.
const strength = buildWorkoutPayload('Push', 'strength_training', [
  {
    repeat: 3,
    steps: [
      {
        type: 'interval',
        reps: 10,
        weightKg: 60,
        exercise: { category: 'BENCH_PRESS', name: 'BARBELL_BENCH_PRESS' }
      },
      { type: 'rest', lapButton: true }
    ]
  }
]);
assert.equal(strength.sportType.sportTypeId, 5, 'strength sport id');
const [set, rest] = (strength.workoutSegments[0].workoutSteps[0] as any).workoutSteps;
assert.deepEqual(set.endCondition, { conditionTypeId: 10, conditionTypeKey: 'reps' });
assert.equal(set.endConditionValue, 10);
assert.equal(set.category, 'BENCH_PRESS');
assert.equal(set.exerciseName, 'BARBELL_BENCH_PRESS');
assert.equal(set.weightValue, 60);
assert.equal(set.weightUnit.unitKey, 'kilogram');
assert.deepEqual(rest.endCondition, { conditionTypeId: 1, conditionTypeKey: 'lap.button' });
assert.equal(rest.endConditionValue, undefined, 'lap button carries no value');
assert.equal(rest.stepType.stepTypeId, 5, 'rest step id');
assert.equal(rest.category, undefined, 'rest steps have no exercise');

// A timed rest still ends on time even when lapButton is also set.
const timedRest = buildWorkoutPayload('Rest', 'strength_training', [
  { type: 'rest', durationSeconds: 90, lapButton: true }
]).workoutSegments[0].workoutSteps[0] as any;
assert.equal(timedRest.endCondition.conditionTypeKey, 'time');

assert.equal(validateSteps([{ type: 'interval', reps: 8 }], 'strength_training'), null);
assert.equal(validateSteps([{ type: 'rest', lapButton: true }]), null);
assert.match(
  validateSteps([{ type: 'interval', reps: 8 }], 'running')!,
  /only apply to strength_training/,
  'reps make no sense on a run'
);
assert.match(
  validateSteps([{ type: 'interval', durationSeconds: 60, weightKg: 20 }], 'cycling')!,
  /only apply to strength_training/
);

// Garmin saves an unknown exercise code as a blank step, so the catalog check
// is the only thing standing between a typo and an empty workout.
assert.equal(checkExercise('BENCH_PRESS', 'BARBELL_BENCH_PRESS'), null);
assert.equal(checkExercise('PLYO'), null, 'a category on its own is valid');
assert.match(checkExercise('BENCHPRESS')!, /Unknown exercise category BENCHPRESS/);
assert.match(
  checkExercise('SQUAT', 'BARBELL_DEADLIFT')!,
  /BARBELL_DEADLIFT is under DEADLIFT, not SQUAT/,
  'a real name in the wrong category says where it lives'
);
assert.match(
  checkExercise('BENCH_PRESS', 'BARBEL_BENCH_PRESS')!,
  /no BARBEL_BENCH_PRESS under BENCH_PRESS\. Closest: BENCH_PRESS, /,
  'a typo gets the nearest names in its category'
);
assert.match(
  validateSteps(
    [{ type: 'interval', reps: 5, exercise: { category: 'SQUAT', name: 'BACK_SQUAT_TYPO' } }],
    'strength_training'
  )!,
  /no BACK_SQUAT_TYPO under SQUAT/,
  'validateSteps runs the catalog check'
);

console.log('✓ workout builder ok');
