# Contributing

Thanks for improving the list. The rules are short.

## Adding a plugin

1. Edit [`plugins.json`](plugins.json) — one entry, in the section that matches its purpose:

   ```json
   {
     "name": "dsh-example",
     "category": "ui",
     "why": "Fixes the thing it says it fixes, in one line."
   }
   ```

   `name` must be the **exact bundle name** the index lists (that is also the npm package name).

2. Run `npm run sync` and commit the regenerated files.

3. Open a pull request describing the problem the plugin solves.

## What makes an entry acceptable

- **It resolves.** The sync must find it in the index with a concrete version.
- **The repository is alive.** Not archived, and pushed within roughly the last year.
- **The `why` is a benefit, not a feature list.** "Grows the composer for long prompts" beats "adds a composer expand button".
- **No silent duplication.** If it overlaps an existing entry, add `"conflictWith": "<other name>"` to both. Overlap is fine; pretending it does not exist is not.

## Removing a plugin

Delete the entry from `plugins.json`, run `npm run sync`, and say why in the pull request. Abandoned or broken plugins should go — the weekly sync flags them, but it cannot judge whether they still work.

## Editorial policy

This is a starter kit, not a directory. It stays useful by staying short: a new entry should displace something or fill a gap that has no good option, not add a second choice next to an existing one. Descriptions, stars and popularity are inputs, not verdicts — an entry here means "installs, is maintained, and solves a real problem", nothing more.

## Licence

By contributing you agree your changes are published under the [MIT licence](LICENSE).
