import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { writeFileSync } from 'node:fs';

const bundle = await rollup({
  input: 'src-client/main.js',
  plugins: [nodeResolve({ browser: true, exportConditions: ['browser', 'import', 'default'] })],
  external: ['react', 'react/jsx-runtime'],
  onwarn(w) {
    if (w.code === 'CIRCULAR_DEPENDENCY' || w.code === 'THIS_IS_UNDEFINED') return;
    console.warn('[rollup]', w.code, w.message);
  },
});

const { output } = await bundle.generate({ format: 'cjs', exports: 'named' });
const inner = output[0].code;

const wrapped =
  'window.__ModuleLoader__.load({ id: "dsh-mobile-bridge", factory: (require) => {\n' +
  'var module = { exports: {} }; var exports = module.exports;\n' +
  inner +
  '\nreturn module.exports; } });\n';

writeFileSync('client.js', wrapped);
await bundle.close();
console.log('client.js bytes:', wrapped.length);
