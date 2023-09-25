const { isString, isRegExp } = require("lodash");
const AggregateError = require("aggregate-error");
const pEachSeries = require("p-each-series");
const DEFINITIONS = require("../definitions/branches");
const getError = require("../get-error");
const { fetch, fetchNotes, verifyBranchName } = require("../git");
const expand = require("./expand");
const getTags = require("./get-tags");
const normalize = require("./normalize");

module.exports = async (repositoryUrl, ciBranch, context) => {
  const { cwd, env } = context;

  console.time("remoteBranches");
  const remoteBranches = await expand(
    repositoryUrl,
    context,
    context.options.branches.map((branch) => (isString(branch) || isRegExp(branch) ? { name: branch } : branch))
  );
  console.timeEnd("remoteBranches");

  console.time("each repositoryUrl");
  await pEachSeries(remoteBranches, async ({ name }) => {
    console.time("fetch branch " + name);
    await fetch(repositoryUrl, name, ciBranch, { cwd, env });
    console.timeEnd("fetch branch " + name);
  });
  console.timeEnd("each repositoryUrl");

  console.time("fetchNotes");
  await fetchNotes(repositoryUrl, { cwd, env });
  console.timeEnd("fetchNotes");

  console.time("getTags");
  const branches = await getTags(context, remoteBranches);
  console.timeEnd("getTags");

  console.time("errors");
  const errors = [];
  const branchesByType = Object.entries(DEFINITIONS).reduce(
    // eslint-disable-next-line unicorn/no-fn-reference-in-iterator
    (branchesByType, [type, { filter }]) => ({ [type]: branches.filter(filter), ...branchesByType }),
    {}
  );

  const result = Object.entries(DEFINITIONS).reduce((result, [type, { branchesValidator, branchValidator }]) => {
    branchesByType[type].forEach((branch) => {
      if (branchValidator && !branchValidator(branch)) {
        errors.push(getError(`E${type.toUpperCase()}BRANCH`, { branch }));
      }
    });

    const branchesOfType = normalize[type](branchesByType);

    if (!branchesValidator(branchesOfType)) {
      errors.push(getError(`E${type.toUpperCase()}BRANCHES`, { branches: branchesOfType }));
    }

    return { ...result, [type]: branchesOfType };
  }, {});

  const duplicates = [...branches]
    .map((branch) => branch.name)
    .sort()
    .filter((_, idx, array) => array[idx] === array[idx + 1] && array[idx] !== array[idx - 1]);

  if (duplicates.length > 0) {
    errors.push(getError("EDUPLICATEBRANCHES", { duplicates }));
  }
  console.timeEnd("errors");

  await pEachSeries(branches, async (branch) => {
    if (!(await verifyBranchName(branch.name))) {
      errors.push(getError("EINVALIDBRANCHNAME", branch));
    }
  });

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  return [...result.maintenance, ...result.release, ...result.prerelease];
};
