/**
 * Semantic Release Configuration
 *
 * Conservative versioning for 0.x development:
 * - fix: → patch (0.1.2 → 0.1.3)
 * - feat: → patch (0.1.2 → 0.1.3) - conservative until 1.0
 * - feat!: or BREAKING CHANGE: → minor (0.1.x → 0.2.0) - not major while 0.x
 * - perf:, refactor: → patch
 * - docs:, chore:, test:, ci: → no release
 */
export default {
  branches: ['master'],
  repositoryUrl: 'https://github.com/framersai/agentos',
  tagFormat: 'v${version}',
  plugins: [
    // Analyze commits to determine release type
    ['@semantic-release/commit-analyzer', {
      preset: 'conventionalcommits',
      releaseRules: [
        { type: 'feat', release: 'patch' },      // Conservative: feat = patch until 1.0
        { type: 'fix', release: 'patch' },
        { type: 'perf', release: 'patch' },
        { type: 'refactor', release: 'patch' },
        { type: 'revert', release: 'patch' },
        { breaking: true, release: 'minor' },   // BREAKING = minor while 0.x
        // These don't trigger releases: docs, style, chore, test, ci, build
      ],
      parserOpts: {
        noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES', 'BREAKING']
      }
    }],

    // Generate release notes from commits
    ['@semantic-release/release-notes-generator', {
      preset: 'conventionalcommits',
      presetConfig: {
        types: [
          { type: 'feat', section: 'Features' },
          { type: 'fix', section: 'Bug Fixes' },
          { type: 'perf', section: 'Performance' },
          { type: 'refactor', section: 'Code Refactoring' },
          { type: 'revert', section: 'Reverts' },
          { type: 'docs', section: 'Documentation', hidden: true },
          { type: 'chore', section: 'Maintenance', hidden: true },
          { type: 'test', section: 'Tests', hidden: true },
          { type: 'ci', section: 'CI/CD', hidden: true },
          { type: 'build', section: 'Build', hidden: true },
        ]
      },
      // Parser tweaks to keep the changelog clean:
      //   - referenceActions: []  → don't auto-link "closes #N" style refs.
      //     We don't use GitHub issues for closing tickets in commit
      //     messages; the historical parser used to misread hyphenated
      //     words like "high-level" as "hi#level" issue references.
      //   - issuePrefixes: []  → disable the "#N" reference scanner entirely.
      parserOpts: {
        noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES', 'BREAKING'],
        referenceActions: [],
        issuePrefixes: [],
      },
      // Writer tweaks: don't silently truncate long commit subjects.
      // The default writer caps `header` at 100 chars and slices mid-word.
      writerOpts: {
        headerMaxLength: 500,
        transform: (commit, context) => {
          // conventional-changelog-writer@8 freezes commit objects, so
          // we must return a new object instead of mutating in place.
          if (commit.hash && typeof commit.hash === 'string') {
            return { ...commit, shortHash: commit.hash.substring(0, 7) };
          }
          return commit;
        },
      },
    }],

    // Update CHANGELOG.md
    ['@semantic-release/changelog', {
      changelogFile: 'CHANGELOG.md'
    }],

    // Publish to npm
    ['@semantic-release/npm', {
      npmPublish: true
    }],

    // Commit version bump and changelog
    ['@semantic-release/git', {
      assets: ['CHANGELOG.md', 'package.json'],
      message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}'
    }],

    // Create GitHub release
    ['@semantic-release/github', {
      successComment: false,
      failComment: false,
      releasedLabels: false
    }]
  ]
};
