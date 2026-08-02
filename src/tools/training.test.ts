import assert from 'node:assert/strict';
import { buildWorkoutPayload, validateSteps } from './training';

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
assert.match(validateSteps([{ type: 'warmup' }])!, /durationSeconds or distanceMeters/);
assert.match(
  validateSteps([{ repeat: 2, steps: [{ type: 'interval' }] }])!,
  /durationSeconds or distanceMeters/,
  'validation reaches inside repeat groups'
);
assert.match(
  validateSteps([
    { type: 'interval', durationSeconds: 60, target: { type: 'heart.rate.zone', min: 130 } }
  ])!,
  /both min and max/
);

console.log('✓ workout builder ok');
