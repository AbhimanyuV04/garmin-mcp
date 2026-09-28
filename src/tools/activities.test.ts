import assert from 'node:assert/strict';
import { strengthSummary, subTypeQuery, summarizeExerciseSets } from './activities';

// Shape of /activity-service/activity/{id}/exerciseSets: rest periods are
// their own sets, weights are grams, and Garmin ranks its exercise guesses.
const detail = summarizeExerciseSets({
  activityId: 1,
  exerciseSets: [
    {
      setType: 'ACTIVE',
      repetitionCount: 10,
      weight: 60000,
      duration: 42.5,
      exercises: [
        { category: 'BENCH_PRESS', name: 'DUMBBELL_BENCH_PRESS', probability: 20 },
        { category: 'BENCH_PRESS', name: 'BARBELL_BENCH_PRESS', probability: 80 }
      ]
    },
    { setType: 'REST', duration: 90 },
    {
      setType: 'ACTIVE',
      repetitionCount: 8,
      weight: 62500,
      duration: 38,
      exercises: [{ category: 'BENCH_PRESS', name: 'BARBELL_BENCH_PRESS', probability: 100 }]
    },
    { setType: 'REST', duration: 120 },
    // Bodyweight: Garmin sends 0 or null weight, and may not name the exercise.
    { setType: 'ACTIVE', repetitionCount: 12, weight: 0, duration: 30, exercises: [{ category: 'PULL_UP' }] }
  ]
});

assert.equal(detail.total_sets, 3, 'rest periods are not sets');
assert.equal(detail.total_reps, 30);
assert.equal(detail.total_volume_kg, 1100, '10x60 + 8x62.5, bodyweight adds nothing');
const [first, second, third] = detail.sets as any[];
assert.equal(first.exercise, 'BARBELL_BENCH_PRESS', 'most probable guess wins');
assert.equal(first.weight_kg, 60, 'grams become kg');
assert.equal(first.rest_after, '1:30', 'rest folds into the set before it');
assert.equal(second.weight_kg, 62.5);
assert.equal(second.rest_after, '2:00');
assert.equal(third.exercise, 'PULL_UP', 'falls back to the category');
assert.equal(third.weight_kg, undefined, 'bodyweight sets carry no weight');
assert.equal(third.rest_after, undefined);

assert.deepEqual(summarizeExerciseSets(null), {}, 'no sets means no strength fields');
assert.deepEqual(summarizeExerciseSets({ exerciseSets: [] }), {});

const listed = strengthSummary({
  activeSets: 9,
  totalSets: 17,
  totalReps: 84,
  summarizedExerciseSets: [
    { category: 'SQUAT', subCategory: 'BARBELL_BACK_SQUAT', sets: 5, reps: 25, volume: 2500000 },
    { category: 'PLANK', sets: 4, reps: 0, volume: 0 }
  ]
});
assert.equal(listed.total_sets, 9, 'active sets, not active plus rest');
assert.equal(listed.total_reps, 84);
assert.deepEqual(listed.exercises, [
  { exercise: 'BARBELL_BACK_SQUAT', category: 'SQUAT', sets: 5, reps: 25, volume_kg: 2500 },
  { exercise: 'PLANK', category: 'PLANK', sets: 4, reps: 0 }
]);
assert.deepEqual(strengthSummary({}), {});

// Shape of /activity-service/activity/activityTypes (ids illustrative).
const types = [
  { typeId: 1, typeKey: 'running', parentTypeId: 17 },
  { typeId: 17, typeKey: 'all', parentTypeId: null },
  { typeId: 29, typeKey: 'fitness_equipment', parentTypeId: 17 },
  { typeId: 13, typeKey: 'strength_training', parentTypeId: 29 }
];
assert.deepEqual(subTypeQuery(types, 'strength_training'), {
  activityType: 'fitness_equipment',
  activitySubType: 'strength_training'
});
assert.equal(subTypeQuery(types, 'yoga'), null, 'unknown key: no retry');
assert.equal(subTypeQuery(null, 'strength_training'), null);

console.log('✓ strength sets ok');
