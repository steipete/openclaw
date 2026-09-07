export default class OriginalShardOrder {
  async sort(specifications) {
    const names = [
      "test/scripts/ci-workflow-guards.test.ts",
      "test/scripts/ci-node-test-plan.test.ts",
      "test/scripts/pr-main-refresh.test.ts",
    ];
    const rank = (specification) =>
      names.findIndex((name) => specification.moduleId.endsWith(`/${name}`));
    const ranks = specifications.map(rank);
    if (specifications.length !== 3 || new Set(ranks).size !== 3 || ranks.includes(-1)) {
      throw new Error("Original shard inventory differs from the three reviewed files");
    }
    return [...specifications].sort((left, right) => rank(left) - rank(right));
  }

  async shard() {
    throw new Error("The three-file comparison must not be sharded again");
  }
}
