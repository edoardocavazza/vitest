import { pathToFileURL } from 'node:url'
import mm from 'micromatch'
import { resolve } from 'pathe'
import { distDir, rootDir } from '../paths'
import type { Pool } from '../types'
import type { Vitest } from './core'
import { createChildProcessPool } from './pools/child'
import { createThreadsPool } from './pools/threads'
import { createBrowserPool } from './pools/browser'
import { createVmThreadsPool } from './pools/vm-threads'
import type { WorkspaceProject } from './workspace'

export type WorkspaceSpec = [project: WorkspaceProject, testFile: string]
export type RunWithFiles = (files: WorkspaceSpec[], invalidates?: string[]) => Promise<void>

export interface ProcessPool {
  runTests: RunWithFiles
  close: () => Promise<void>
}

export interface PoolProcessOptions {
  workerPath: string
  forksPath: string
  vmPath: string
  execArgv: string[]
  env: Record<string, string>
}

const loaderPath = pathToFileURL(resolve(distDir, './loader.js')).href
const suppressLoaderWarningsPath = resolve(rootDir, './suppress-warnings.cjs')

export function createPool(ctx: Vitest): ProcessPool {
  const pools: Record<Pool, ProcessPool | null> = {
    forks: null,
    threads: null,
    browser: null,
    vmThreads: null,
  }

  function getDefaultPoolName(project: WorkspaceProject): Pool {
    if (project.config.browser.enabled)
      return 'browser'

    return project.config.pool
  }

  function getPoolName([project, file]: WorkspaceSpec) {
    for (const [glob, pool] of project.config.poolMatchGlobs || []) {
      if ((pool as Pool) === 'browser')
        throw new Error('Since Vitest 0.31.0 "browser" pool is not supported in "poolMatchGlobs". You can create a workspace to run some of your tests in browser in parallel. Read more: https://vitest.dev/guide/workspace')
      if (mm.isMatch(file, glob, { cwd: project.config.root }))
        return pool as Pool
    }
    return getDefaultPoolName(project)
  }

  async function runTests(files: WorkspaceSpec[], invalidate?: string[]) {
    const conditions = ctx.server.config.resolve.conditions?.flatMap(c => ['--conditions', c]) || []

    // Instead of passing whole process.execArgv to the workers, pick allowed options.
    // Some options may crash worker, e.g. --prof, --title. nodejs/node#41103
    const execArgv = process.execArgv.filter(execArg =>
      execArg.startsWith('--cpu-prof') || execArg.startsWith('--heap-prof'),
    )

    const options: PoolProcessOptions = {
      ...ctx.projectFiles,
      execArgv: ctx.config.deps.registerNodeLoader
        ? [
            ...execArgv,
            '--require',
            suppressLoaderWarningsPath,
            '--experimental-loader',
            loaderPath,
            ...conditions,
          ]
        : [
            ...execArgv,
            ...conditions,
          ],
      env: {
        TEST: 'true',
        VITEST: 'true',
        NODE_ENV: ctx.config.mode || 'test',
        VITEST_MODE: ctx.config.watch ? 'WATCH' : 'RUN',
        ...process.env,
        ...ctx.config.env,
      },
    }

    const filesByPool: Record<Pool, WorkspaceSpec[]> = {
      forks: [],
      threads: [],
      browser: [],
      vmThreads: [],
    }

    for (const spec of files) {
      const pool = getPoolName(spec)
      if (!(pool in filesByPool))
        throw new Error(`Unknown pool name "${pool}" for ${spec[1]}. Available pools: ${Object.keys(filesByPool).join(', ')}`)
      filesByPool[pool].push(spec)
    }

    await Promise.all(Object.entries(filesByPool).map((entry) => {
      const [pool, files] = entry as [Pool, WorkspaceSpec[]]

      if (!files.length)
        return null

      if (pool === 'browser') {
        pools.browser ??= createBrowserPool(ctx)
        return pools.browser.runTests(files, invalidate)
      }

      if (pool === 'vmThreads') {
        pools.vmThreads ??= createVmThreadsPool(ctx, options)
        return pools.vmThreads.runTests(files, invalidate)
      }

      if (pool === 'threads') {
        pools.threads ??= createThreadsPool(ctx, options)
        return pools.threads.runTests(files, invalidate)
      }

      pools.forks ??= createChildProcessPool(ctx, options)
      return pools.forks.runTests(files, invalidate)
    }))
  }

  return {
    runTests,
    async close() {
      await Promise.all(Object.values(pools).map(p => p?.close()))
    },
  }
}
