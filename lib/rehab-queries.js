// Read-only query layer over Fred's rehab data.
//
// Knows nothing about Express or Anthropic, so the same functions can back the
// /api/ask chat tools now and an MCP server later. `tools` is the single
// definition of what is exposed; inputSchema is JSON Schema, which is the shape
// MCP uses directly.
//
// Each call opens its own read-only connection. The app's restore feature swaps
// the database file while running, so a long-lived handle would go stale.

const sqlite3 = require('sqlite3');

const MAX_DAILY_RANGE_DAYS = 366;
const TEN_K = 10000;
const DAY_MS = 86400000;
const FORECAST_WINDOW_DAYS = 60;

const FUN_MILESTONES = [
    { name: 'Stoke to London',       steps: 300000,   miles: 150  },
    { name: 'Stoke to Paris',        steps: 800000,   miles: 400  },
    { name: 'Stoke to Berlin',       steps: 1500000,  miles: 750  },
    { name: 'Stoke to Moscow',       steps: 3200000,  miles: 1600 },
    { name: 'Stoke to Johannesburg', steps: 12000000, miles: 6000 },
];

// Highest first. days = number of 10,000+ step days needed.
const CLUB_LEVELS = [
    { level: 'Gold',   days: 15 },
    { level: 'Silver', days: 10 },
    { level: 'Bronze', days: 5 },
    { level: 'Member', days: 1 },
];

function clubLevel(tenKDays) {
    const reached = CLUB_LEVELS.find((entry) => tenKDays >= entry.days);
    return reached ? reached.level : 'None';
}

// Thrown for bad input. The message is safe to show to the caller.
class QueryInputError extends Error {}

function parseDate(value, field) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new QueryInputError(`${field} must be a date in YYYY-MM-DD format.`);
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new QueryInputError(`${field} is not a real calendar date: ${value}.`);
    }
    return value;
}

function parseRange(input, prefix = '') {
    const source = input || {};
    const start = parseDate(source.start_date, `${prefix}start_date`);
    const end = parseDate(source.end_date, `${prefix}end_date`);
    if (start > end) {
        throw new QueryInputError(`${prefix}start_date must not be after ${prefix}end_date.`);
    }
    return { start, end };
}

function daysInRange(start, end) {
    return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

// Stored values have been 'Yes'/'No' but older code assumed lower case.
const isYes = (value) => String(value ?? '').trim().toLowerCase() === 'yes';

// A steps row can hold only a comment, so 0 or blank means no count was recorded.
function stepCount(row) {
    const steps = Number(row && row.quantity);
    return Number.isFinite(steps) && steps > 0 ? steps : null;
}

const round1 = (value) => Math.round(value * 10) / 10;

function percent(part, whole) {
    return whole > 0 ? round1((part / whole) * 100) : null;
}

function longestStreak(dates) {
    let best = 0;
    let current = 0;
    let previous = null;
    for (const date of [...dates].sort()) {
        const consecutive = previous !== null && daysInRange(previous, date) === 2;
        current = consecutive ? current + 1 : 1;
        best = Math.max(best, current);
        previous = date;
    }
    return best;
}

function addDays(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// Straight-line fit of cumulative steps over the window, matching the forecast
// on the Fun Milestones page so the chat and the page give the same date.
function fitStepTrend(dailySteps, totalSteps) {
    const n = dailySteps.length;
    let cumulative = totalSteps - dailySteps.reduce((sum, steps) => sum + steps, 0);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    dailySteps.forEach((steps, x) => {
        cumulative += steps;
        sumX += x;
        sumY += cumulative;
        sumXY += x * cumulative;
        sumXX += x * x;
    });
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return { slope, intercept: (sumY - slope * sumX) / n };
}

function estimateCompletion(trend, goal, today) {
    if (!(trend.slope > 0)) return null;
    const daysFromNow = Math.ceil((goal - trend.intercept) / trend.slope - (FORECAST_WINDOW_DAYS - 1));
    return daysFromNow > 0 ? addDays(today, daysFromNow) : 'very soon';
}

// Abramowitz and Stegun approximation, as used by the Fun Milestones page.
function erf(x) {
    const sign = x >= 0 ? 1 : -1;
    const abs = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * abs);
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return sign * (1 - poly * Math.exp(-abs * abs));
}

// Treats each future day as a random draw from the last 60 days, like the page does.
function chanceOfReaching(stepsNeeded, days, dailyMean, dailySd) {
    const expected = days * dailyMean;
    const spread = Math.sqrt(days) * dailySd;
    if (spread === 0) return expected >= stepsNeeded ? 100 : 0;
    return Math.round(0.5 * (1 - erf((stepsNeeded - expected) / (spread * Math.SQRT2))) * 100);
}

function reachChances(stepsNeeded, windowSteps) {
    const mean = windowSteps.reduce((sum, steps) => sum + steps, 0) / windowSteps.length;
    if (mean <= 0) return null;
    const sd = Math.sqrt(windowSteps.reduce((sum, steps) => sum + (steps - mean) ** 2, 0) / windowSteps.length);
    return {
        within_1_month: chanceOfReaching(stepsNeeded, 30, mean, sd),
        within_3_months: chanceOfReaching(stepsNeeded, 90, mean, sd),
        within_6_months: chanceOfReaching(stepsNeeded, 180, mean, sd),
        within_1_year: chanceOfReaching(stepsNeeded, 365, mean, sd),
    };
}

function createRehabQueries(dbPath) {
    function withReadOnlyDb(work) {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
                if (openErr) return reject(openErr);
                const all = (sql, params = []) => new Promise((res, rej) =>
                    db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows))));
                all('PRAGMA query_only = ON')
                    .then(() => work(all))
                    .then(
                        (result) => db.close(() => resolve(result)),
                        (err) => db.close(() => reject(err))
                    );
            });
        });
    }

    function loadRange(all, start, end) {
        return Promise.all([
            all('SELECT date, quantity, comments FROM steps WHERE date BETWEEN ? AND ? ORDER BY date', [start, end]),
            all('SELECT date, done, weights_done FROM exercises WHERE date BETWEEN ? AND ? ORDER BY date', [start, end]),
        ]);
    }

    function summarise(start, end, stepRows, exerciseRows) {
        const logged = stepRows
            .map((row) => ({ date: row.date, steps: stepCount(row) }))
            .filter((row) => row.steps !== null);
        const totalSteps = logged.reduce((sum, row) => sum + row.steps, 0);
        const byStepsDesc = [...logged].sort((a, b) => b.steps - a.steps);
        const exerciseDays = exerciseRows.filter((row) => isYes(row.done)).length;
        const weightsDays = exerciseRows.filter((row) => isYes(row.weights_done)).length;
        const calendarDays = daysInRange(start, end);

        return {
            start_date: start,
            end_date: end,
            calendar_days: calendarDays,
            steps: {
                days_logged: logged.length,
                total: totalSteps,
                average_per_logged_day: logged.length ? Math.round(totalSteps / logged.length) : null,
                best_day: byStepsDesc[0] || null,
                lowest_day: byStepsDesc[byStepsDesc.length - 1] || null,
                days_at_10k_or_more: logged.filter((row) => row.steps >= TEN_K).length,
            },
            exercise: {
                days_logged: exerciseRows.length,
                exercise_days: exerciseDays,
                weights_days: weightsDays,
                both_days: exerciseRows.filter((row) => isYes(row.done) && isYes(row.weights_done)).length,
                exercise_percent_of_logged_days: percent(exerciseDays, exerciseRows.length),
                weights_percent_of_logged_days: percent(weightsDays, exerciseRows.length),
            },
        };
    }

    async function getDataOverview() {
        return withReadOnlyDb(async (all) => {
            const [[steps], [exercises]] = await Promise.all([
                all('SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS days FROM steps WHERE quantity > 0'),
                all('SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS days FROM exercises'),
            ]);
            return { steps, exercises };
        });
    }

    async function getDailyMetrics(input) {
        const { start, end } = parseRange(input);
        const calendarDays = daysInRange(start, end);
        if (calendarDays > MAX_DAILY_RANGE_DAYS) {
            throw new QueryInputError(
                `Daily metrics cover at most ${MAX_DAILY_RANGE_DAYS} days per call (asked for ${calendarDays}). ` +
                'Use a shorter range, or get_period_summary for totals.'
            );
        }
        return withReadOnlyDb(async (all) => {
            const [stepRows, exerciseRows] = await loadRange(all, start, end);
            const days = new Map();
            const dayFor = (date) => {
                if (!days.has(date)) {
                    days.set(date, { date, steps: null, comment: null, exercise_done: null, weights_done: null });
                }
                return days.get(date);
            };
            for (const row of stepRows) {
                const day = dayFor(row.date);
                day.steps = stepCount(row);
                day.comment = row.comments || null;
            }
            for (const row of exerciseRows) {
                const day = dayFor(row.date);
                day.exercise_done = isYes(row.done);
                day.weights_done = isYes(row.weights_done);
            }
            const recorded = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
            return {
                start_date: start,
                end_date: end,
                calendar_days: calendarDays,
                days_with_no_record: calendarDays - recorded.length,
                days: recorded,
            };
        });
    }

    async function getExerciseHistory(input) {
        const { start, end } = parseRange(input);
        const type = (input && input.type) || 'all';
        if (!['all', 'exercise', 'weights'].includes(type)) {
            throw new QueryInputError("type must be 'all', 'exercise' or 'weights'.");
        }
        return withReadOnlyDb(async (all) => {
            const rows = await all(
                'SELECT date, done, weights_done FROM exercises WHERE date BETWEEN ? AND ? ORDER BY date',
                [start, end]
            );
            const entries = rows.map((row) => ({
                date: row.date,
                exercise_done: isYes(row.done),
                weights_done: isYes(row.weights_done),
            }));
            const exerciseDates = entries.filter((e) => e.exercise_done).map((e) => e.date);
            const weightsDates = entries.filter((e) => e.weights_done).map((e) => e.date);
            const matches = {
                all: () => entries,
                exercise: () => entries.filter((e) => e.exercise_done),
                weights: () => entries.filter((e) => e.weights_done),
            };
            return {
                start_date: start,
                end_date: end,
                type,
                days_logged: entries.length,
                exercise_days: exerciseDates.length,
                weights_days: weightsDates.length,
                last_exercise_date: exerciseDates[exerciseDates.length - 1] || null,
                last_weights_date: weightsDates[weightsDates.length - 1] || null,
                longest_exercise_streak_days: longestStreak(exerciseDates),
                longest_weights_streak_days: longestStreak(weightsDates),
                entries: matches[type](),
            };
        });
    }

    async function getPeriodSummary(input) {
        const { start, end } = parseRange(input);
        return withReadOnlyDb(async (all) => {
            const [stepRows, exerciseRows] = await loadRange(all, start, end);
            return summarise(start, end, stepRows, exerciseRows);
        });
    }

    async function comparePeriods(input) {
        const source = input || {};
        const rangeA = parseRange(source.period_a, 'period_a.');
        const rangeB = parseRange(source.period_b, 'period_b.');
        return withReadOnlyDb(async (all) => {
            const [[stepsA, exercisesA], [stepsB, exercisesB]] = await Promise.all([
                loadRange(all, rangeA.start, rangeA.end),
                loadRange(all, rangeB.start, rangeB.end),
            ]);
            const a = summarise(rangeA.start, rangeA.end, stepsA, exercisesA);
            const b = summarise(rangeB.start, rangeB.end, stepsB, exercisesB);

            const change = (valueA, valueB) => {
                if (valueA === null || valueB === null) {
                    return { a: valueA, b: valueB, change: null, percent_change: null };
                }
                return {
                    a: valueA,
                    b: valueB,
                    change: round1(valueB - valueA),
                    percent_change: valueA !== 0 ? round1(((valueB - valueA) / valueA) * 100) : null,
                };
            };

            return {
                period_a: a,
                period_b: b,
                changes_from_a_to_b: {
                    average_steps_per_logged_day: change(a.steps.average_per_logged_day, b.steps.average_per_logged_day),
                    total_steps: change(a.steps.total, b.steps.total),
                    days_logged: change(a.steps.days_logged, b.steps.days_logged),
                    days_at_10k_or_more: change(a.steps.days_at_10k_or_more, b.steps.days_at_10k_or_more),
                    exercise_days: change(a.exercise.exercise_days, b.exercise.exercise_days),
                    weights_days: change(a.exercise.weights_days, b.exercise.weights_days),
                    exercise_percent_of_logged_days: change(
                        a.exercise.exercise_percent_of_logged_days,
                        b.exercise.exercise_percent_of_logged_days
                    ),
                },
            };
        });
    }

    async function getAchievements() {
        return withReadOnlyDb(async (all) => {
            const [achievements, updates] = await Promise.all([
                all('SELECT id, name, description, start_date, end_date FROM achievements ORDER BY start_date, id'),
                all(`SELECT u.achievement_id, u.update_date, u.comments,
                            SUM(m.media_type = 'photo') AS photos,
                            SUM(m.media_type = 'video') AS videos
                     FROM achievement_updates u
                     LEFT JOIN achievement_update_media m ON m.update_id = u.id
                     GROUP BY u.id
                     ORDER BY u.update_date, u.id`),
            ]);
            return {
                achievements: achievements.map((achievement) => ({
                    name: achievement.name,
                    description: achievement.description || null,
                    start_date: achievement.start_date,
                    end_date: achievement.end_date || null,
                    updates: updates
                        .filter((update) => update.achievement_id === achievement.id)
                        .map((update) => ({
                            date: update.update_date,
                            comment: update.comments || null,
                            photos: update.photos || 0,
                            videos: update.videos || 0,
                        })),
                })),
            };
        });
    }

    async function getMilestoneProgress() {
        return withReadOnlyDb(async (all) => {
            const rows = await all('SELECT date, quantity FROM steps ORDER BY date');
            const logged = rows
                .map((row) => ({ date: row.date, steps: stepCount(row) }))
                .filter((row) => row.steps !== null);
            const totalSteps = logged.reduce((sum, row) => sum + row.steps, 0);

            const today = new Date().toISOString().slice(0, 10);
            const windowStart = addDays(today, 1 - FORECAST_WINDOW_DAYS);
            const stepsByDate = new Map(logged.map((row) => [row.date, row.steps]));
            const windowSteps = Array.from({ length: FORECAST_WINDOW_DAYS }, (_, i) =>
                stepsByDate.get(addDays(windowStart, i)) || 0);
            const trend = fitStepTrend(windowSteps, totalSteps);

            const reachedOn = (goal) => {
                let running = 0;
                for (const row of logged) {
                    running += row.steps;
                    if (running >= goal) return row.date;
                }
                return null;
            };

            const tenKDays = logged.filter((row) => row.steps >= TEN_K).length;
            const level = clubLevel(tenKDays);
            const nextLevel = [...CLUB_LEVELS].reverse().find((entry) => entry.days > tenKDays) || null;

            return {
                total_steps: totalSteps,
                steps_in_last_60_days: windowSteps.reduce((sum, steps) => sum + steps, 0),
                ten_k_club: {
                    days_at_10k_or_more: tenKDays,
                    level,
                    next_level: nextLevel ? nextLevel.level : null,
                    more_days_needed: nextLevel ? nextLevel.days - tenKDays : null,
                },
                distance_milestones: FUN_MILESTONES.map((milestone) => {
                    const reached = totalSteps >= milestone.steps;
                    return {
                        name: milestone.name,
                        miles: milestone.miles,
                        goal_steps: milestone.steps,
                        percent_complete: Math.min(100, round1((totalSteps / milestone.steps) * 100)),
                        reached,
                        reached_on: reached ? reachedOn(milestone.steps) : null,
                        steps_remaining: reached ? 0 : milestone.steps - totalSteps,
                        estimated_completion: reached ? null : estimateCompletion(trend, milestone.steps, today),
                        percent_chance_of_reaching: reached ? null : reachChances(milestone.steps - totalSteps, windowSteps),
                    };
                }),
            };
        });
    }

    const dateProperty = (description) => ({ type: 'string', format: 'date', description });
    const rangeProperties = {
        start_date: dateProperty('First day of the range, inclusive, as YYYY-MM-DD.'),
        end_date: dateProperty('Last day of the range, inclusive, as YYYY-MM-DD.'),
    };
    const rangeSchema = (description) => ({
        type: 'object',
        description,
        properties: rangeProperties,
        required: ['start_date', 'end_date'],
        additionalProperties: false,
    });

    const tools = [
        {
            name: 'get_data_overview',
            description: 'Get the first and last dates that have data, and how many days are recorded, for steps and exercise. An exercise record can be a "No", so last_date is not the last time he exercised. Use this to resolve "all time" or "since he started", and to check whether the data reaches the dates being asked about.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: getDataOverview,
        },
        {
            name: 'get_daily_metrics',
            description: `Get day-by-day records for a date range: steps, comment, exercise done and weights done. Only days with a record are listed; null means that item was not recorded. At most ${MAX_DAILY_RANGE_DAYS} days per call. Use this for specific days, comments, or patterns a summary would hide.`,
            inputSchema: {
                type: 'object',
                properties: rangeProperties,
                required: ['start_date', 'end_date'],
                additionalProperties: false,
            },
            handler: getDailyMetrics,
        },
        {
            name: 'get_exercise_history',
            description: 'Get exercise and weights history for a date range: totals, the last date each was actually done, longest streaks of consecutive days, and the matching entries. type is "all" (default) for every logged day, or "exercise" or "weights" for only the days that activity was done.',
            inputSchema: {
                type: 'object',
                properties: {
                    ...rangeProperties,
                    type: { type: 'string', enum: ['all', 'exercise', 'weights'], description: 'Which entries to list. Defaults to all.' },
                },
                required: ['start_date', 'end_date'],
                additionalProperties: false,
            },
            handler: getExerciseHistory,
        },
        {
            name: 'get_period_summary',
            description: 'Get totals for a date range of any length: total and average steps, best and lowest days, 10,000+ step days, exercise and weights counts and percentages. Percentages are of days with an exercise record, not calendar days.',
            inputSchema: {
                type: 'object',
                properties: rangeProperties,
                required: ['start_date', 'end_date'],
                additionalProperties: false,
            },
            handler: getPeriodSummary,
        },
        {
            name: 'compare_periods',
            description: 'Compare two date ranges side by side and get the change from period_a to period_b for each metric. Put the earlier period in period_a. Periods can differ in length, so prefer averages and percentages over totals when they do.',
            inputSchema: {
                type: 'object',
                properties: {
                    period_a: rangeSchema('The baseline period, normally the earlier one.'),
                    period_b: rangeSchema('The period being compared with the baseline.'),
                },
                required: ['period_a', 'period_b'],
                additionalProperties: false,
            },
            handler: comparePeriods,
        },
        {
            name: 'get_achievements',
            description: "Get Fred's personal achievements, each with its description, dates and dated updates. Updates include any comment and how many photos and videos are attached. Use this for questions about what he has achieved or done, such as events and activities.",
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: getAchievements,
        },
        {
            name: 'get_milestone_progress',
            description: 'Get progress on the fun step challenges: the 10,000 Steps Club level (Member 1 day, Bronze 5, Silver 10, Gold 15) and the distance milestones from Stoke to London, Paris, Berlin, Moscow and Johannesburg, based on all-time steps. Each milestone gives percent complete, the date reached or steps remaining, and estimated_completion, a date or "very soon" projected from the trend in the last 60 days. percent_chance_of_reaching gives the percentage chance of getting there within 1, 3, 6 and 12 months if the last 60 days are typical, counting unrecorded days as zero steps. Both are null when reached or when there were no steps in those 60 days.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: getMilestoneProgress,
        },
    ];

    return {
        getDataOverview, getDailyMetrics, getExerciseHistory, getPeriodSummary, comparePeriods,
        getAchievements, getMilestoneProgress, tools,
    };
}

module.exports = { createRehabQueries, QueryInputError, FUN_MILESTONES, clubLevel };
