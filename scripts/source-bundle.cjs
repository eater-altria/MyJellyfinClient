/** Load a real source module and its local dependencies after API modules are split. */
const esbuild = require('esbuild');
const bundles = new Map();
module.exports = function sourceBundle(file) {
  if (bundles.has(file)) return bundles.get(file);
  const code = esbuild.buildSync({ entryPoints: [file], bundle: true, platform: 'node',
    format: 'cjs', packages: 'external', write: false }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  bundles.set(file, module.exports);
  return module.exports;
};
