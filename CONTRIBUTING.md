# Contributing

Thanks for your interest in `@homotope/engine`.

- **Issues and pull requests are welcome here**, in the public repository. Please include an
  image (or a synthetic one built in a test) that shows the problem, and the options used.
- **How changes land.** This repository is a mirror: the engine is developed alongside the
  Homotope application, and each release is exported here. An accepted pull request is
  integrated by hand upstream, credited to you (`Co-authored-by`), and comes back in the next
  release. Your pull request is then closed with a link to the release.
- **No lockfile.** Dependency ranges come from upstream at each release, so this repository has
  no `package-lock.json`: use `npm install` (not `npm ci`), as the CI does.
- **Before opening a pull request**: `npm run lint`, `npm run typecheck`, `npm test` and
  `npm run eval -- --check` must pass. Every fixed bug comes with a regression test.
- **Ground rules of the engine**: no DOM types or globals (it runs in Web Workers and Node),
  typed arrays for per-pixel data, no runtime dependency, and only MIT/BSD/Apache/ISC-compatible
  code (no GPL, no Potrace).
- Comments in the source are mostly in French, as in the upstream project; English is welcome
  in new code.

By contributing, you agree that your contribution is licensed under the [MIT License](./LICENSE).
