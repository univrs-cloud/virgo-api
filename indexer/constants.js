// Shared crawl/diff tuning constants. Kept in one place so the walker and the
// incremental flush paths can't drift apart on batch sizing or on the
// wholesale-stat-failure thresholds.

export const BATCH_SIZE = 4096;
export const STAT_CONCURRENCY = 64;

// When stat() starts returning null wholesale, the ZFS snapshot automount almost
// certainly didn't take, and continuing would silently drop files. Two rules,
// because aborting is expensive — it restarts the entire run:
//
//   - every stat in a batch of at least STAT_FAILURE_TOTAL_SAMPLE failed. A clean
//     sweep needs little evidence; nothing else looks like that.
//   - at least STAT_FAILURE_ABORT_RATIO of a batch of at least
//     STAT_FAILURE_MIN_SAMPLE failed.
//
// MIN_SAMPLE is deliberately large. Individual ENOENTs are legitimate (dangling
// symlinks, objects on the ZFS delete queue), and a batch that happens to contain
// only a handful of stattable entries used to trip the ratio on ~17 failures and
// take the whole run down with it.
export const STAT_FAILURE_ABORT_RATIO = 0.5;
export const STAT_FAILURE_MIN_SAMPLE = 256;
export const STAT_FAILURE_TOTAL_SAMPLE = 32;
