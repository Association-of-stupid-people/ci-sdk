#!/usr/bin/env node
// Build every action in packages/* (except the shared sdk) into the layout the
// `runner` branch expects:
//
//   dist/<action>/action.yml
//   dist/<action>/dist/index.js      (single ESM bundle, all deps inlined)
//
// Usage: node scripts/build.mjs [action ...]   (no args = all actions)
//
// Replaces the old script/build.js, which rewrote the template submodule's
// package.json and ran ncc once per package, sequentially.
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { rollup } from 'rollup'
import { parse } from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.join(root, 'packages')
const outDir = path.join(root, 'dist')
const LIBRARY_PACKAGES = new Set(['sdk'])

const { positionals } = parseArgs({ allowPositionals: true })

async function listActions() {
  const entries = await readdir(packagesDir, { withFileTypes: true })
  return entries
    .filter(e => e.isDirectory() && !LIBRARY_PACKAGES.has(e.name))
    .filter(e => existsSync(path.join(packagesDir, e.name, 'action.yml')))
    .map(e => e.name)
    .sort()
}

/** Fail early on action.yml mistakes that only show up at runtime on the runner. */
async function validateActionYml(name) {
  const file = path.join(packagesDir, name, 'action.yml')
  const meta = parse(await readFile(file, 'utf8'))
  const problems = []
  if (!meta?.name) problems.push('missing name')
  if (!meta?.description) problems.push('missing description')
  if (meta?.runs?.using !== 'node24')
    problems.push(`runs.using must be node24 (got ${meta?.runs?.using})`)
  if (meta?.runs?.main !== 'dist/index.js') problems.push('runs.main must be dist/index.js')
  if (problems.length) throw new Error(`${name}/action.yml: ${problems.join(', ')}`)
}

async function buildAction(name) {
  const started = performance.now()
  await validateActionYml(name)
  const target = path.join(outDir, name)
  await rm(target, { recursive: true, force: true })
  await mkdir(path.join(target, 'dist'), { recursive: true })

  const bundle = await rollup({
    input: path.join(packagesDir, name, 'src', 'index.ts'),
    plugins: [
      typescript({
        tsconfig: path.join(root, 'tsconfig.json'),
        include: ['packages/**/*.ts'],
        exclude: ['**/__tests__/**'],
        noEmit: false,
        declaration: false,
        rootDir: root,
        sourceMap: true,
        outDir: path.join(target, 'dist')
      }),
      nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }),
      commonjs(),
      json()
    ],
    onwarn(warning, warn) {
      // Known-harmless warning from dependencies' `this` at module top level.
      if (warning.code === 'THIS_IS_UNDEFINED' || warning.code === 'CIRCULAR_DEPENDENCY') return
      warn(warning)
    }
  })
  try {
    await bundle.write({
      file: path.join(target, 'dist', 'index.js'),
      format: 'es',
      sourcemap: true,
      // Lets bundled CommonJS dependencies call require() for Node builtins.
      banner:
        "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
    })
  } finally {
    await bundle.close()
  }
  await copyFile(path.join(packagesDir, name, 'action.yml'), path.join(target, 'action.yml'))
  // Runtime files read next to the bundle (e.g. a Dockerfile): packages/<name>/assets -> dist/<name>/assets
  const assets = path.join(packagesDir, name, 'assets')
  if (existsSync(assets)) await cp(assets, path.join(target, 'assets'), { recursive: true })
  // Bundles are ESM; the nearest package.json tells Node so.
  await writeFile(path.join(target, 'dist', 'package.json'), '{ "type": "module" }\n')
  return Math.round(performance.now() - started)
}

const all = await listActions()
const unknown = positionals.filter(p => !all.includes(p))
if (unknown.length) {
  console.error(`Unknown action(s): ${unknown.join(', ')}. Available: ${all.join(', ')}`)
  process.exitCode = 1
} else {
  const selected = positionals.length ? positionals : all
  const results = await Promise.allSettled(selected.map(buildAction))
  results.forEach((r, i) => {
    const name = selected[i]
    if (r.status === 'fulfilled') console.log(`✔ ${name} (${r.value}ms) -> dist/${name}`)
    else console.error(`✖ ${name}: ${r.reason?.stack ?? r.reason}`)
  })
  if (results.some(r => r.status === 'rejected')) process.exitCode = 1
}
