import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('lib mirrors src for the host modules', async () => {
  const srcFiles = (await readdir(join(root, 'src'))).filter((name) => name.endsWith('.js')).sort()
  for (const file of srcFiles) {
    const expected = await readFile(join(root, 'src', file), 'utf8')
    const target = file === 'host.js' ? 'index.js' : file
    const actual = await readFile(join(root, 'lib', target), 'utf8')
    assert.equal(actual, expected, `lib/${target} is stale — run npm run build`)
  }
})

test('the client bundle is wrapped for __ModuleLoader__ and inlines the CSS', async () => {
  const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/)
  assert.match(bundle, /id: "dsh-tab-complete"/)
  assert.doesNotMatch(bundle, /require\(['"]\.\/client-css\.cjs['"]\)/)
  assert.match(bundle, /\.tc-ghost\{/)
})

test('package manifest declares both halves', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-tab-complete')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(pkg.dsh.client.platform, 'web')
})
