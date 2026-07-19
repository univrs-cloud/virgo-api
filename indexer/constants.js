// Shared crawl/diff tuning constants. Kept in one place so the walker and the
// incremental flush paths can't drift apart on batch sizing or on the
// wholesale-stat-failure thresholds.

export const BATCH_SIZE = 4096;
export const STAT_CONCURRENCY = 64;

// If more than STAT_FAILURE_ABORT_RATIO of stat() calls in a batch of at least
// STAT_FAILURE_MIN_SAMPLE entries return null, treat it as a wholesale
// snapshot-mount failure and abort the snapshot rather than silently dropping
// files. The threshold is high because some real changes are legitimately
// ENOENT on the snapshot mount (file deleted between zfs diff and our stat) —
// but losing >50% of a non-trivial batch is unambiguously a mount problem.
export const STAT_FAILURE_ABORT_RATIO = 0.5;
export const STAT_FAILURE_MIN_SAMPLE = 32;
