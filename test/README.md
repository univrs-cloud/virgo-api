Run the indexer tests with Node 24 and the repository dependencies installed:

```sh
npm test
```

`npm run test:indexer` runs the same files.

## What is tested

- `indexer-scenarios.test.js`: what the two incremental writers record for a snapshot.
- `indexer-transactions.test.js`: a failed snapshot leaves nothing behind, a retry gives the same index as a clean run, and a reader never sees half a snapshot.
- `indexer-retention.test.js`: what happens to versions when snapshots are pruned.
- `indexer-query.test.js`: `search`, `history`, `diff` and `since`.
- `indexer-scope.test.js`: which paths are indexed, how a rename across the edge of that scope is read, and how `zfs diff` lines are parsed.

## Scenarios

Each scenario performs actual filesystem operations between two captures: writes, deletes,
recreations, overwrites, directory moves, or moves across the edge of the indexed scope. No change
event is written by hand.

Every scenario is checked the same way, with nothing scenario-specific to get wrong:

- The live index equals the final filesystem: paths, kinds, inodes and sizes.
- Every stored version names a path that exists in the capture it belongs to, with that size.
- Every object that survived carries the history of the path it had before, wherever it is now.
- Every object that is gone is kept as exactly one deleted entry at the path it had.
- A new object continues an earlier history only under its own name and of its own kind.
- Nothing is left set aside, and no event lost its file.

A few scenarios add checks of their own on `diff` and `since`.

Both writers run each scenario with the whole event list in one batch and with one event per
batch, including snapshot finalization inside the production transaction helper.

## Event order

`zfs diff` prints changes in object-number order. That order says nothing about what happened
first, so the index must come out the same whatever order a snapshot's events arrive in. Each
scenario is therefore run in every order of its events, or in a fixed sample of 120 orders when
there are more than that, always including the order the backend produced and its reverse.

## Backends

The default backend uses a temporary local directory and an in-memory SQLite index. It derives
events from inode identity, birth time, ctime and path changes, following the ordinary-file and
directory rules of
[OpenZFS 2.4.4's diff implementation](https://github.com/openzfs/zfs/blob/zfs-2.4.4/lib/libzfs/libzfs_diff.c#L263-L363),
the release the nodes run:

- an object that is in both snapshots with an unchanged ctime has no event, which covers the
  untouched contents of a renamed directory;
- with a changed ctime it is a rename when its full path differs, and a modification otherwise,
  so a file that was edited under a renamed directory is a rename;
- an object number that was freed and used again is a removal followed by an addition;
- a rename changes the ctime of the object that moved and of the directories on both sides.

This is a model, not an execution of ZFS. Host inode allocation and timestamp resolution can
differ from ZFS, so it needs a filesystem that records birth time and sub-second change times.
Hard links and concurrent retention are not covered.

To execute the same scenarios with actual ZFS snapshots and `zfs diff -FHt`, select an existing
scratch parent dataset on a ZFS host:

```sh
VIRGO_INDEXER_ZFS_TEST_PARENT=tank/scratch npm test
```

The process needs permission to create, mount, snapshot, and destroy children of that parent. Each
scenario creates a uniquely named child dataset, mounts it in a temporary directory, takes `s1`
and `s2`, and consumes the actual diff output. Cleanup destroys only the child created by that
scenario. The supplied parent is never destroyed. An interrupted process may leave its
`virgo-review-*` child for manual cleanup. An explicitly selected ZFS backend fails if
unavailable; it never silently falls back to the local model. Its scenarios use plain ASCII names
without spaces, because the fixture does not undo the escapes `zfs diff` writes for other bytes.
