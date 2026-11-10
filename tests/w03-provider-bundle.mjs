import path from 'node:path';

// The W03 suite calls the real service with synthetic Windows, helper and trust
// boundaries. Importer checks restrict each substitution to the fixture bundle.
export const w03ProviderBoundaries = {
  name: 'w03-provider-fixture',
  setup(builder) {
    builder.initialOptions.define = {...builder.initialOptions.define, W03_ISOLATED_PROVIDER_BUNDLE: 'true'};
    const service = path.resolve('src/main/runtime/service.ts');
    const target = path.resolve('src/main/installer/managed-target.ts');
    const policy = path.resolve('src/main/runtime/policy.ts');
    const depot = path.resolve('src/main/runtime/depot.ts');
    const fixture = path.resolve('tests/w03-provider-boundaries.ts');

    builder.onResolve({filter: /^(\.\.\/windows|\.\.\/distribution\/policy|\.\/depot|node:child_process)$/}, args => {
      if ((args.path === '../windows' && [service, target].includes(args.importer)) ||
          (args.path === '../distribution/policy' && args.importer === policy) ||
          (args.path === './depot' && args.importer === service) ||
          (args.path === 'node:child_process' && args.importer === depot)) {
        return {path: fixture};
      }
    });
  }
};
