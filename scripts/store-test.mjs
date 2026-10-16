// JsonFile без Electron и без профиля: настоящий модуль, подставные fs и app.
// Тест сам задерживает и роняет запись, чтобы проверить порядок, выход во время записи и ошибки.
// Запуск: npm run test:store.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { transformWithEsbuild } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const filename = path.join(root, 'src/main/store.ts')
const source = (await transformWithEsbuild(fs.readFileSync(filename, 'utf8'), filename, { format: 'cjs', target: 'es2022' })).code
const DIR = path.join(path.parse(root).root, 'masaki-fake-profile')
const FILE = path.join(DIR, 'state.json')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Файлы в памяти. hold — асинхронная запись ждёт, пока тест её не отпустит (или не уронит). */
function fakeFs() {
  const files = new Map()
  const gates = []
  const state = { hold: false, fail: 0 }
  const api = {
    promises: {
      mkdir: async () => {},
      readFile: async (p) => {
        if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return files.get(p)
      },
      writeFile: (p, data) =>
        new Promise((resolve, reject) => {
          if (state.fail > 0) {
            state.fail--
            return setImmediate(() => reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })))
          }
          const done = () => {
            files.set(p, data)
            resolve()
          }
          if (state.hold) gates.push({ data, release: done })
          else setImmediate(done)
        }),
      // Прежний JsonFile заменял файл асинхронно — оставлено, чтобы тест ловил и его ошибку.
      rename: async (from, to) => api.renameSync(from, to)
    },
    mkdirSync() {},
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => {
      if (!files.has(from)) throw Object.assign(new Error('ENOENT ' + from), { code: 'ENOENT' })
      files.set(to, files.get(from))
      files.delete(from)
    },
    rmSync: (p) => files.delete(p)
  }
  return { api, files, gates, state }
}

function load(fsApi) {
  const module = { exports: {} }
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      setTimeout,
      clearTimeout,
      require: (id) => {
        if (id === 'electron') return { app: { getPath: () => DIR } }
        if (id === 'fs') return fsApi
        if (id === 'path') return path
        throw new Error('Неожиданный модуль: ' + id)
      }
    },
    { filename }
  )
  return module.exports.JsonFile
}

const saved = (f) => JSON.parse(f.files.get(FILE)).v
const leftovers = (f) => [...f.files.keys()].filter((p) => p !== FILE)
async function waitFor(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await sleep(5)
  }
  throw new Error('Не дождались: ' + what)
}

// 1. Две записи подряд: даже если вторая закончит раньше, на диске должна остаться она.
{
  const f = fakeFs()
  const store = new (load(f.api))('state.json')
  f.state.hold = true
  store.write({ v: 1 }, 0)
  await waitFor(() => f.gates.length === 1, 'первая запись')
  store.write({ v: 2 }, 0)
  await sleep(30)
  f.state.hold = false
  // Отпускаем в обратном порядке: прежний JsonFile писал оба файла сразу, и старый побеждал.
  for (const gate of f.gates.splice(0).reverse()) gate.release()
  await store.flush()
  assert.equal(saved(f), 2, 'новая запись затёрта старой')
  assert.deepEqual(leftovers(f), [], 'остались временные файлы')
  assert.equal((await store.read()).v, 2)
  console.log('  ok — записи по очереди: последняя остаётся на диске')
}

// 2. Выход во время асинхронной записи: flushSync сохраняет свежее, запоздавшая запись его не трогает.
{
  const f = fakeFs()
  const store = new (load(f.api))('state.json')
  f.state.hold = true
  store.write({ v: 3 }, 0)
  await waitFor(() => f.gates.length === 1, 'асинхронная запись')
  store.write({ v: 4 }, 60_000)
  store.flushSync()
  assert.equal(saved(f), 4, 'flushSync не сохранил последнее состояние')
  f.state.hold = false
  f.gates.shift().release()
  await store.flush()
  assert.equal(saved(f), 4, 'запоздавшая запись затёрла сохранённое при выходе')
  assert.deepEqual(leftovers(f), [], 'остались временные файлы')

  // То же без новых изменений: при выходе уходит то, что ещё пишется.
  f.state.hold = true
  store.write({ v: 5 }, 0)
  await waitFor(() => f.gates.length === 1, 'вторая асинхронная запись')
  store.flushSync()
  assert.equal(saved(f), 5, 'flushSync не увидел начатую запись')
  f.state.hold = false
  f.gates.shift().release()
  await store.flush()
  assert.equal(saved(f), 5)
  assert.deepEqual(leftovers(f), [])
  console.log('  ok — выход во время записи сохраняет последнее состояние')
}

// 3. Ошибка записи не теряет состояние: таймер повторяет, при выходе дописывает flushSync.
{
  const f = fakeFs()
  const store = new (load(f.api))('state.json')
  store.write({ v: 6 }, 0)
  await store.flush()
  f.state.fail = 1
  store.write({ v: 7 }, 0)
  await sleep(50)
  assert.equal(saved(f), 6, 'неудачная запись что-то изменила')
  store.flushSync()
  assert.equal(saved(f), 7, 'после ошибки состояние потерялось')

  f.state.fail = 1
  store.write({ v: 8 }, 0)
  await sleep(50)
  assert.equal(saved(f), 7)
  // Повтор — через 2 с (RETRY_MS в store.ts).
  await sleep(2200)
  assert.equal(saved(f), 8, 'запись не повторилась после ошибки')
  assert.deepEqual(leftovers(f), [])
  console.log('  ok — ошибка записи: состояние не теряется, запись повторяется')
}

console.log('JsonFile: все проверки прошли')
