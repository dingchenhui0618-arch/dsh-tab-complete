#!/usr/bin/env node
// Dependency-free build.
//
// The host half is plain ESM whose only imports are node: builtins and its own
// sibling modules, so copying the sources into lib/ is a complete build: no
// bundler, no devDependency that can fail to install, and the shipped artifact
// is byte-identical to the reviewed source.
//
// The client half is CommonJS loaded through window.__ModuleLoader__ with a
// harness-provided require(), so it must carry no relative require except the
// inlined stylesheet.
//
// lib/ is committed. `npm test` runs this script first, so a forgotten rebuild
// is a failing test rather than a stale package.

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapClient } from './wrap-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const out = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const hostModules = (await readdir(src)).filter((name) => name.endsWith('.js')).sort()
if (hostModules.length === 0) throw new Error('src/ contains no host modules')

for (const file of hostModules) {
  const target = file === 'host.js' ? 'index.js' : file
  await copyFile(join(src, file), join(out, target))
}

const cssModule = await import(pathToFileURL(join(src, 'client-css.cjs')).href)
const css = cssModule.default
if (typeof css !== 'string' || css.length === 0) {
  throw new Error('src/client-css.cjs did not export a non-empty CSS string')
}

const clientSource = await readFile(join(src, 'client.cjs'), 'utf8')
const CSS_REQUIRE = /require\((['"])\.\/client-css\.cjs\1\)/
if (!CSS_REQUIRE.test(clientSource)) {
  throw new Error('src/client.cjs no longer requires ./client-css.cjs — update scripts/build.mjs')
}

const bundle = wrapClient(clientSource.replace(CSS_REQUIRE, JSON.stringify(css)), pkg.name)
await writeFile(join(out, 'client.js'), bundle)

// Compile the client bundle and import the host module: a broken build fails
// here rather than in the browser, where the error is much harder to read.
new Function('window', bundle.replace(/^\/\*[\s\S]*?\*\/\n/, ''))
const host = await import(pathToFileURL(join(out, 'index.js')).href)
if (host.name !== pkg.name || typeof host.apply !== 'function') {
  throw new Error('invalid host plugin export: expected name "' + pkg.name + '" and an apply() function')
}

const core = await import(pathToFileURL(join(out, 'core.js')).href)
if (typeof core.buildPrompt !== 'function' || typeof core.transcriptOf !== 'function') {
  throw new Error('core.js must export buildPrompt() and transcriptOf()')
}

console.log(
  'Built ' + pkg.name + ' ' + pkg.version + ': lib/index.js, lib/client.js, ' +
  hostModules.length + ' host module(s)',
)
