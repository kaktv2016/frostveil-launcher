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

    const expected = new Set([
      JSON.stringify([service, '../windows']),
      JSON.stringify([service, './pe-version']),
      JSON.stringify([target, '../windows']),
      JSON.stringify([policy, '../distribution/policy']),
      JSON.stringify([service, './depot']),
      JSON.stringify([depot, 'node:child_process']),
    ]);
    const matched = new Set();
    builder.onResolve({filter: /^(\.\.\/windows|\.\.\/distribution\/policy|\.\/depot|\.\/pe-version|node:child_process)$/}, args => {
      const boundary = JSON.stringify([args.importer, args.path]);
      if (expected.has(boundary)) {
        matched.add(boundary);
        return {path: fixture};
      }
    });
    builder.onEnd(() => ({
      errors: [...expected].filter(boundary => !matched.has(boundary))
        .map(boundary => ({text: 'W03 isolation boundary was not substituted: ' + boundary})),
    }));
  }
};
