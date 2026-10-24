/** 一次性检查：账号库能否在真实数据目录落盘（不写入假账号）。 */
import { join } from 'node:path'
import { existsSync, rmSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
const { SqliteStore, AccountPool, isUsableCredential } = await import(pathToFileURL(join(root, 'lib', 'pool.js')).href)

const home = process.env.USERPROFILE
const dbFile = join(home, '.dsh', 'zcode-start-plan', 'accounts.db')

const store = await new SqliteStore(dbFile)
console.log(`dataDir=${join(home, '.dsh', 'zcode-start-plan')}`)
console.log(`dbFile=${dbFile}`)
console.log(`inMemory=${store.inMemory}  mkdirError=${store.mkdirError ? store.mkdirError.message : 'none'}`)
console.log(`exists=${existsSync(dbFile)}`)

const pool = new AccountPool({ store })
pool.add({ zcode_jwt: 'probe-jwt-not-real', device_mid: 'probe-device', user_id: 'probe-user' }, '落盘探测')
const listed = pool.list({ withCredentials: true })
console.log(`roundtrip accounts=${listed.length} credentialUsable=${isUsableCredential(listed[0]?.credential)}`)
console.log(`nickname=${listed[0]?.nickname}`)

pool.remove(listed[0].id)
console.log(`cleaned accounts=${pool.list().length}`)
store.close()

if (existsSync(dbFile)) {
  const size = statSync(dbFile).size
  console.log(`fileSize=${size}B`)
}
